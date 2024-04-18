import ampq from "amqplib";
import { Octokit } from "@octokit/core";
import { EmitterWebhookEvent } from "@octokit/webhooks";
import { Repository } from "@octokit/webhooks-types";
import {
  InstallationAccessTokenAuthentication,
  createAppAuth,
} from "@octokit/auth-app";

import { db } from "../db/db";
import { cloneRepo } from "../git/clone";
import { runBuildCheck } from "../build/node/check";
import { getSourceMap } from "../analyze/sourceMap";
import { createNewFile } from "../code/newFile";
import { editFiles } from "../code/editFiles";
import { getPR } from "../github/pr";
import { addCommentToIssue } from "../github/issue";
import { fixError } from "../code/fixError";
import { createStory } from "../code/createStory";
import { codeReview } from "../code/codeReview";
import { respondToCodeReview } from "../code/respondToCodeReview";
import {
  extractFilePathWithArrow,
  PRCommand,
  PR_COMMAND_VALUES,
  enumFromStringValue,
  getRepoSettings,
  getIssueNumberFromBranch,
} from "../utils";
import {
  addFailedWorkComment,
  addStartingWorkComment,
} from "../github/comments";
import { createRepoInstalledIssue } from "../github/issue";
import { getFile } from "../github/repo";
import { posthogClient } from "../analytics/posthog";
import { Language } from "../utils/settings";
import { asyncLocalStorage } from "../utils/localStorage";

const GITHUB_EVENT_QUEUE_NAME = "github_event_queue";
const INTERNAL_EVENT_BROADCAST_QUEUE_NAME =
  process.env.INTERNAL_EVENT_BROADCAST_QUEUE_NAME ?? null;

const auth = createAppAuth({
  appId: process.env.GITHUB_APP_ID ?? "",
  privateKey: process.env.GITHUB_PRIVATE_KEY ?? "",
});

let channel: ampq.Channel | undefined;
const LOCALHOST_RABBITMQ_PORT = process.env.RABBITMQ_PORT ?? 5672;
const RABBITMQ_URL =
  process.env.RABBITMQ_URL ?? `amqp://localhost:${LOCALHOST_RABBITMQ_PORT}`;

async function initRabbitMQ() {
  try {
    const connection = await ampq.connect(RABBITMQ_URL);
    channel = await connection.createChannel();

    // Init queue with one hour consumer timeout to ensure
    // we have enough time to install, build, and test
    await channel.assertQueue(GITHUB_EVENT_QUEUE_NAME, {
      durable: true,
      arguments: { "x-consumer-timeout": 60 * 60 * 1000 },
    });

    // Queue to broadcast internal events to the web portal
    // This queue is optional and can be disabled by setting the queue name to an empty string in the .env file
    if (INTERNAL_EVENT_BROADCAST_QUEUE_NAME) {
      await channel.assertQueue(INTERNAL_EVENT_BROADCAST_QUEUE_NAME, {
        durable: true,
      });
    } else {
      console.log(
        "Warning: Internal event broadcast queue not initialized. If this was not intended, please check the .env file.",
      );
    }

    channel.prefetch(1);
    channel.consume(
      GITHUB_EVENT_QUEUE_NAME,
      async (message) => {
        if (!message) {
          console.error(`null message received from channel.consume()!`);
          return;
        }
        console.log(`Received queue message: ${message.properties.messageId}`);
        try {
          const event = JSON.parse(
            message.content.toString(),
          ) as WebhookQueuedEvent;
          await onGitHubEvent(event);
          channel?.ack(message);
        } catch (error) {
          console.error(`Error parsing or processing message: ${error}`);
          channel?.ack(message);
        }
      },
      {
        noAck: false,
      },
    );
    console.log(`Initialized RabbitMQ`);
  } catch (error) {
    console.error(`Error initializing RabbitMQ: ${error}`);
    return;
  }
}

async function addProjectToDB(
  repository: Pick<Repository, "id" | "node_id" | "name" | "full_name">,
  eventId: string,
  eventName: string,
) {
  const projectUpdate = {
    repoName: repository.name,
    repoFullName: repository.full_name,
    repoNodeId: repository.node_id,
  };
  const project = await db.projects
    .create({
      ...projectUpdate,
      repoId: `${repository.id}`,
    })
    .onConflict("repoId")
    .merge(projectUpdate);
  console.log(
    `[${repository.full_name}] onGitHubEvent: ${eventId} ${eventName} : DB project ID: ${project.id}`,
  );
}

async function isNodeProject(
  repository: Pick<
    Repository,
    "owner" | "id" | "node_id" | "name" | "full_name" | "private"
  >,
  installationAuthentication: InstallationAccessTokenAuthentication,
): Promise<boolean> {
  // Check to see if the repo has a package.json file in the root
  // This is a simple way to determine if the repo is a Node.js project
  // We will need to remove this assumption if we want to support other languages
  try {
    const { data } = await getFile(
      {
        ...repository,
        owner: {
          ...repository.owner,
          name: repository.owner?.name ?? undefined,
          gravatar_id: repository.owner?.gravatar_id ?? "",
          type: repository.owner?.type as "Bot" | "User" | "Organization",
        },
      },
      installationAuthentication.token,
      "package.json",
    );
    return !(data instanceof Array) && data.type === "file";
  } catch (e) {
    return false;
  }
}

async function authInstallation(installationId?: number) {
  if (installationId) {
    return auth({
      type: "installation",
      installationId,
    });
  }
}

async function onReposAdded(event: WebhookInstallationRepositoriesAddedEvent) {
  const { repositories_added: repos, installation, sender } = event.payload;

  const installationAuthentication = await authInstallation(installation?.id);
  if (!installationAuthentication) {
    console.error(
      `onReposAdded: ${event.id} ${event.name} : no installationId`,
    );
    return;
  }
  for (const repo of repos) {
    console.log(
      `onReposAdded: ${event.id} ${event.name} : ${repo.full_name} ${repo.id}`,
    );
    const repository = { ...repo, owner: installation.account };
    const distinctId = sender.login ?? "";

    let isNodeRepo: boolean | undefined;
    try {
      isNodeRepo = await isNodeProject(repository, installationAuthentication);
      await addProjectToDB(repo, event.id, event.name);
      const { path, cleanup } = await cloneRepo(
        repo.full_name,
        undefined,
        installationAuthentication.token,
      );

      console.log(`[${repo.full_name}] repo cloned to ${path}`);

      const repoSettings = getRepoSettings(path);

      try {
        if (isNodeRepo) {
          await runBuildCheck(path, false, repoSettings);
        } else {
          console.log(
            `[${repo.full_name}] onReposAdded: ${event.id} ${event.name} : not a Node.js project - skipping runBuildCheck`,
          );
        }

        await createRepoInstalledIssue(
          repository,
          installationAuthentication.token,
          sender.login,
          isNodeRepo,
        );
        posthogClient.capture({
          distinctId,
          event: "Repo Installed Successfully",
          properties: {
            repo: repo.full_name,
          },
        });
      } finally {
        console.log(`[${repo.full_name}] cleaning up repo cloned to ${path}`);
        cleanup();
      }
    } catch (error) {
      try {
        await createRepoInstalledIssue(
          repository,
          installationAuthentication.token,
          sender.login,
          isNodeRepo,
          error as Error,
        );
        posthogClient.capture({
          distinctId,
          event: "Repo Install Failed",
          properties: {
            repo: repo.full_name,
          },
        });
      } catch (issueError) {
        // NOTE: some repos don't have issues and we will fail to create an issue
        // Ignoring this error so we can continue to process the next repo and remove this event from the queue
        console.error(
          `[${repo.full_name}] onReposAdded: ${event.id} ${event.name} : ${issueError}, original error:`,
          error,
        );
        posthogClient.capture({
          distinctId,
          event: "Repo Issue Creation Failed",
          properties: {
            repo: repo.full_name,
          },
        });
      }
    }
  }
}

export async function onGitHubEvent(event: WebhookQueuedEvent) {
  if (event.name === "installation_repositories") {
    console.log(`onGitHubEvent: ${event.id} ${event.name}`);
    return onReposAdded(event);
  }
  const {
    name: eventName,
    payload: { repository, installation },
  } = event;
  const start = Date.now();
  console.log(
    `[${repository.full_name}] onGitHubEvent: ${event.id} ${eventName}`,
  );

  await addProjectToDB(repository, event.id, eventName);

  const installationAuthentication = await authInstallation(installation?.id);
  if (installationAuthentication) {
    const issueOpened = eventName === "issues";
    const prOpened = eventName === "pull_request";
    const prComment =
      eventName === "issue_comment" && event.payload.issue?.pull_request;
    const issueComment = eventName === "issue_comment";
    const prReview = eventName === "pull_request_review";
    const eventIssueOrPRNumber =
      eventName === "pull_request" || eventName === "pull_request_review"
        ? event.payload.pull_request.number
        : event.payload.issue.number;
    const body =
      eventName === "pull_request"
        ? event.payload.pull_request.body
        : eventName === "pull_request_review"
        ? event.payload.review.body
        : eventName === "issue_comment"
        ? event.payload.comment.body
        : event.payload.issue.body;
    const distinctId =
      eventName === "pull_request"
        ? event.payload.pull_request.user.login
        : eventName === "issues"
        ? event.payload.issue.user.login
        : eventName === "pull_request_review"
        ? event.payload.review.user.login
        : eventName === "issue_comment"
        ? event.payload.comment.user.login
        : "";

    const prCommand = enumFromStringValue(
      PRCommand,
      prOpened || prComment
        ? PR_COMMAND_VALUES.find((cmd) => body?.includes(cmd))
        : undefined,
    );

    if ((prOpened || prComment) && !prCommand) {
      if (
        !issueComment ||
        !event.payload.comment?.body?.includes("@jacob-ai-bot build")
      ) {
        throw new Error(
          "Valid prCommand expected for queued PR opened or comment event",
        );
      }
    }
    if (prCommand && issueOpened) {
      throw new Error(
        "prCommand unexpected while handling queued issue opened event",
      );
    }

    await addStartingWorkComment({
      repository,
      token: installationAuthentication.token,
      ...(prCommand
        ? {
            task: "prCommand",
            prNumber: eventIssueOrPRNumber,
            prCommand: prCommand,
          }
        : prReview
        ? { task: "prReview", prNumber: eventIssueOrPRNumber }
        : issueComment
        ? { task: "issueCommand", issueNumber: eventIssueOrPRNumber }
        : {
            task: "issueOpened",
            issueNumber: eventIssueOrPRNumber,
          }),
    });

    let existingPr: Awaited<ReturnType<typeof getPR>>["data"] | undefined;
    let prBranch: string | undefined;
    let issueNumberForPr: number | undefined;
    if (prComment || prReview || prOpened) {
      const result = await getPR(
        repository,
        installationAuthentication.token,
        eventIssueOrPRNumber,
      );
      existingPr = result.data;
      prBranch = existingPr.head.ref;

      issueNumberForPr = getIssueNumberFromBranch(prBranch);

      publishInternalEventToQueue({
        repo: repository.full_name,
        issueId: issueNumberForPr ?? eventIssueOrPRNumber,
        userId: distinctId,
        type: InternalEventType.PullRequest,
        payload: {
          id: `pr-${repository.full_name}-${issueNumberForPr.toString()}`,
          pullRequestId: eventIssueOrPRNumber,
          title: existingPr.title,
          description: existingPr.body ?? "",
          link: existingPr.html_url,
          status: existingPr.state,
          createdAt: existingPr.created_at,
          author: existingPr.user.login,
          comments: [],
          changedFiles: existingPr.changed_files,
          additions: existingPr.additions,
          deletions: existingPr.deletions,
        } as PullRequest,
      });
    }
    const internalEventMetadata: InternalEventMetadata = {
      repo: repository.full_name,
      issueId: issueNumberForPr ?? eventIssueOrPRNumber,
      userId: distinctId,
    };
    // save the internal event metadata to asyncLocalStorage
    await asyncLocalStorage.run({ internalEventMetadata }, async () => {
      try {
        const { path, cleanup } = await cloneRepo(
          repository.full_name,
          prBranch,
          installationAuthentication.token,
        );

        console.log(`[${repository.full_name}] repo cloned to ${path}`);
        const repoSettings = getRepoSettings(path);

        try {
          if (issueOpened) {
            const issueTitle = event.payload.issue.title;
            const newFileName = extractFilePathWithArrow(issueTitle);

            publishInternalEventToQueue({
              ...internalEventMetadata,
              type: InternalEventType.Task,
              payload: {
                id: `task-${
                  repository.full_name
                }-${eventIssueOrPRNumber.toString()}`,
                name: event.payload.issue.title,
                type: newFileName
                  ? TaskType.CREATE_NEW_FILE
                  : TaskType.EDIT_FILES,
                description: event.payload.issue.body,
                storyPoints: 1, // TODO: calculate story points based on issue complexity
                status: TaskStatus.IN_PROGRESS,
              } as Task,
            });

            // Ensure that we capture a source map BEFORE we run the build check.
            // Once npm install has been run, the source map becomes much more
            // detailed and is too large for our LLM context window.
            const sourceMap = getSourceMap(path, repoSettings);
            await runBuildCheck(path, false, repoSettings);

            publishInternalEventToQueue({
              ...internalEventMetadata,
              type: InternalEventType.Issue,
              payload: {
                id: `issue-${
                  repository.full_name
                }-${eventIssueOrPRNumber.toString()}`,
                issueId: eventIssueOrPRNumber,
                title: issueTitle,
                description: event.payload.issue.body ?? "",
                createdAt: event.payload.issue.created_at,
                comments: [],
                author: event.payload.issue.user.login,
                assignee: event.payload.issue.assignee?.login ?? "",
                status:
                  event.payload.issue.state === "open" ? "open" : "closed",
                link: event.payload.issue.html_url,
              } as Issue,
            });

            if (newFileName) {
              await createNewFile(
                newFileName,
                repository,
                installationAuthentication.token,
                event.payload.issue,
                path,
                sourceMap,
                repoSettings,
              );
              posthogClient.capture({
                distinctId,
                event: "New File Created",
                properties: {
                  repo: repository.full_name,
                  file: newFileName,
                },
              });
            } else {
              await editFiles(
                repository,
                installationAuthentication.token,
                event.payload.issue,
                path,
                sourceMap,
                repoSettings,
              );
              posthogClient.capture({
                distinctId,
                event: "Files Edited",
                properties: {
                  repo: repository.full_name,
                },
              });
            }
          } else if (prReview) {
            if (!prBranch || !existingPr) {
              throw new Error("prBranch and existingPr when handling prReview");
            }
            await respondToCodeReview(
              repository,
              installationAuthentication.token,
              path,
              repoSettings,
              prBranch,
              existingPr,
              event.payload.review.state,
              body,
            );
            posthogClient.capture({
              distinctId,
              event: "Code Review Responded",
              properties: {
                repo: repository.full_name,
                pr: prBranch,
              },
            });
          } else if (prCommand) {
            if (!prBranch || !existingPr) {
              throw new Error(
                "prBranch and existingPr when handling prCommand",
              );
            }
            switch (prCommand) {
              case PRCommand.CreateStory:
                await createStory(
                  repository,
                  installationAuthentication.token,
                  path,
                  prBranch,
                  repoSettings,
                  existingPr,
                );
                posthogClient.capture({
                  distinctId,
                  event: "Story Created",
                  properties: {
                    repo: repository.full_name,
                    pr: prBranch,
                  },
                });
                break;
              case PRCommand.CodeReview:
                await codeReview(
                  repository,
                  installationAuthentication.token,
                  path,
                  prBranch,
                  repoSettings,
                  existingPr,
                );
                posthogClient.capture({
                  distinctId,
                  event: "Code Review Started",
                  properties: {
                    repo: repository.full_name,
                    pr: prBranch,
                  },
                });
                break;
              case PRCommand.FixError:
                await fixError(
                  repository,
                  installationAuthentication.token,
                  eventName === "pull_request" ? null : event.payload.issue,
                  eventName === "pull_request"
                    ? event.payload.pull_request.body
                    : event.payload.comment.body,
                  path,
                  prBranch,
                  repoSettings,
                  existingPr,
                );
                posthogClient.capture({
                  distinctId,
                  event: "Error Fix Started",
                  properties: {
                    repo: repository.full_name,
                    pr: prBranch,
                  },
                });
                break;
            }
          } else if (issueComment) {
            // NOTE: important tht we are handing issueComment ONLY after handling prCommand

            // NOTE: The only command we support on issue comments is to run a build check
            await runBuildCheck(path, false, repoSettings);
            await addCommentToIssue(
              repository,
              eventIssueOrPRNumber,
              installationAuthentication.token,
              "Good news!\n\nThe build was successful! :tada:",
            );
          }
        } finally {
          console.log(
            `[${repository.full_name}] cleaning up repo cloned to ${path}`,
          );
          cleanup();
        }
      } catch (error) {
        await addFailedWorkComment(
          repository,
          eventIssueOrPRNumber,
          installationAuthentication.token,
          issueOpened,
          prReview,
          error as Error,
        );
        posthogClient.capture({
          distinctId,
          event: "Work Failed",
          properties: {
            repo: repository.full_name,
            branch: prBranch,
            issue: eventIssueOrPRNumber,
          },
        });
      }
    });
  } else {
    console.error(
      `[${repository.full_name}] onGitHubEvent: ${event.id} ${eventName} : no installationId`,
    );
  }
  console.log(
    `[${repository.full_name}] onGitHubEvent: ${
      event.id
    } ${eventName} : complete after ${Date.now() - start}ms`,
  );
}

export type WebhookIssueOpenedEvent = EmitterWebhookEvent<"issues"> & {
  payload: {
    action: "opened";
  };
};

export type WebhookIssueCommentCreatedEvent =
  EmitterWebhookEvent<"issue_comment"> & {
    payload: {
      action: "created";
    };
  };

type WebhookIssueCommentPullRequest =
  EmitterWebhookEvent<"issue_comment">["payload"]["issue"]["pull_request"];

export type WebhookPRCommentCreatedEvent =
  EmitterWebhookEvent<"issue_comment"> & {
    payload: {
      action: "created";
      issue: {
        pull_request: NonNullable<WebhookIssueCommentPullRequest>;
      };
    };
  };

export type WebhookPullRequestOpenedEvent =
  EmitterWebhookEvent<"pull_request"> & {
    payload: {
      action: "opened";
    };
  };

export type WebhookPullRequestReviewWithCommentsSubmittedEvent =
  EmitterWebhookEvent<"pull_request_review"> & {
    payload: {
      action: "submitted";
      review: {
        state: "changes_requested" | "commented";
      };
    };
  };

export type WebhookInstallationRepositoriesAddedEvent =
  EmitterWebhookEvent<"installation_repositories"> & {
    payload: {
      action: "added";
    };
  };

export type WebhookQueuedEvent =
  | WebhookIssueOpenedEvent
  | WebhookIssueCommentCreatedEvent
  | WebhookPRCommentCreatedEvent
  | WebhookPullRequestOpenedEvent
  | WebhookPullRequestReviewWithCommentsSubmittedEvent
  | WebhookInstallationRepositoriesAddedEvent;

type WithOctokit<T> = T & {
  octokit: Octokit;
};

export type WebhookPRCommentCreatedEventWithOctokit =
  WithOctokit<WebhookPRCommentCreatedEvent>;

export type WebhookPullRequestReviewWithCommentsSubmittedEventWithOctokit =
  WithOctokit<WebhookPullRequestReviewWithCommentsSubmittedEvent>;

export const publishGitHubEventToQueue = async (
  event: WithOctokit<WebhookQueuedEvent>,
) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { octokit, ...eventWithoutOctokit } = event;
  channel?.sendToQueue(
    GITHUB_EVENT_QUEUE_NAME,
    Buffer.from(JSON.stringify(eventWithoutOctokit)),
    {
      persistent: true,
    },
  );
  const repoName =
    "repository" in event.payload
      ? event.payload.repository.full_name
      : event.payload.repositories_added
          .map(({ full_name }) => full_name)
          .join(",");
  console.log(
    `[${repoName}] publishGitHubEventToQueue: ${event.id} ${event.name}`,
  );
};

// Internal Event Queue

export enum InternalEventType {
  Task = "Task",
  Code = "Code",
  Design = "Design",
  Terminal = "Terminal",
  Plan = "Plan",
  Prompt = "Prompt",
  Issue = "Issue",
  PullRequest = "Pull Request",
  Command = "Command",
}

export enum TaskStatus {
  TODO = "todo",
  IN_PROGRESS = "in_progress",
  DONE = "done",
}

export enum TaskType {
  CREATE_NEW_FILE = "Create New File",
  EDIT_FILES = "Edit Files",
  CODE_REVIEW = "Code Review",
}

export type Task = {
  id: string;
  name: string;
  type: TaskType;
  description: string;
  storyPoints: number;
  status: TaskStatus;
};

export type Command = {
  command?: string;
  response?: string;
  directory?: string;
};

export type CodeFile = {
  fileName: string;
  filePath: string;
  language: Language;
  codeBlock: string;
};

export type Plan = {
  id?: string;
  title: string;
  description: string;
  position: number;
  isComplete: boolean;
};

export type Comment = {
  id: string;
  commentId: number;
  username: string;
  createdAt: string;
  content: string;
};

export type Issue = {
  id: string;
  issueId: number;
  title: string;
  description: string;
  createdAt: string;
  comments: Comment[];
  author: string;
  assignee: string;
  status: "open" | "closed";
  link: string;
};

export type PullRequest = {
  id: string;
  pullRequestId: number;
  title: string;
  description: string;
  link: string;
  status: "open" | "closed" | "merged";
  createdAt: string;
  author: string;
  comments: Comment[];
  changedFiles: number;
  additions: number;
  deletions: number;
};

export type Prompt = {
  promptType: "User" | "System" | "Assistant";
  prompt: string;
  timestamp: string;
};

export type PromptDetails = {
  metadata: {
    timestamp: string;
    cost: number;
    tokens: number;
    duration: number;
    model: string;
  };
  request: {
    prompts: Prompt[];
  };
  response: {
    prompt: Prompt;
  };
};

export type InternalEventMetadata = {
  repo?: string;
  issueId?: number | undefined;
  userId?: string;
};

export type InternalEvent = {
  id?: string;
  type: InternalEventType;
  pullRequestId?: number | undefined;
  payload:
    | Task
    | Plan
    | Issue
    | PullRequest
    | Command
    | CodeFile
    | PromptDetails;
} & InternalEventMetadata;

export const publishInternalEventToQueue = (event: InternalEvent) => {
  if (!INTERNAL_EVENT_BROADCAST_QUEUE_NAME) {
    console.log("Internal event broadcast queue name not found");
    return; // since the queue is optional, do not log an error here
  }
  if (!channel) {
    console.error("Channel not initialized");
    return;
  }
  if (!event.repo || !event.userId) {
    console.error("Event repo or userId not found");
    return;
  }
  // add a random id if one is not provided
  if (!event.id) {
    event.id = `${Math.random().toString(36).substring(7)}-${Date.now()}`;
  }

  channel?.sendToQueue(
    INTERNAL_EVENT_BROADCAST_QUEUE_NAME,
    Buffer.from(JSON.stringify(event)),
    {
      persistent: true,
    },
  );
  console.log(
    `[${event.repo}] publishInternalEventToQueue: ${event.id} ${event.type}`,
  );
};

if (process.env.NODE_ENV !== "test") {
  initRabbitMQ().then(() => {
    console.log("RabbitMQ initialized");
  });
}
