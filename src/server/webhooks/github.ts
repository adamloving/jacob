import { App } from "@octokit/app";
import * as dotenv from "dotenv";

import {
  publishGitHubEventToQueue,
  type WebhookPRCommentCreatedEventWithOctokit,
  type WebhookPullRequestReviewWithCommentsSubmittedEventWithOctokit,
} from "../messaging/queue";
import { PR_COMMAND_VALUES } from "../utils";
import { codeReviewCommandSuggestion } from "../github/issue";

dotenv.config();

export const ghApp = new App({
  appId: process.env.GITHUB_APP_ID ?? "",
  privateKey: process.env.GITHUB_PRIVATE_KEY ?? "",
  webhooks: {
    secret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
  },
  oauth: { clientId: "", clientSecret: "" },
});

const errorHandler = (error: Error) => {
  console.error(`Error in webhook event: ${String(error)}`);
};

ghApp.webhooks.onError(errorHandler);

ghApp.webhooks.on("issues.opened", async (event) => {
  const { payload } = event;
  const { repository } = payload;
  // Only add a new issue to the queue if the issue body contains the @jacob-ai-bot mention
  console.log(
    `[${repository.full_name}] Received issue #${payload.issue.number} opened event`,
  );
  // NOTE: We avoid reacting to our own command suggestion in the repo installed message
  if (
    payload?.issue.body?.includes("@jacob-ai-bot") &&
    !payload?.issue.body?.includes(codeReviewCommandSuggestion)
  ) {
    console.log(
      `[${repository.full_name}] Issue #${payload.issue.number} contains @jacob-ai-bot mention`,
    );
    void publishGitHubEventToQueue(event);
  } else {
    console.log(
      `[${repository.full_name}] Issue #${payload.issue.number} has no @jacob-ai-bot mention`,
    );
  }
});

// add a new webhook event handler for when an issue is edited
ghApp.webhooks.on("issues.edited", async (event) => {
  const { payload } = event;
  const { repository } = payload;
  // Only add a new issue to the queue if the issue body contains the @jacob-ai-bot mention for the first time
  console.log(
    `[${repository.full_name}] Received issue #${payload.issue.number} edited event`,
  );
  if (
    payload?.issue.body?.includes("@jacob-ai-bot") &&
    !payload?.issue.body?.includes(codeReviewCommandSuggestion) &&
    !payload.changes?.body?.from?.includes("@jacob-ai-bot")
  ) {
    console.log(
      `[${repository.full_name}] Issue #${payload.issue.number} contains @jacob-ai-bot mention`,
    );
    void publishGitHubEventToQueue(event);
  } else {
    console.log(
      `[${repository.full_name}] Issue #${payload.issue.number} has no @jacob-ai-bot mention`,
    );
  }
});

// add a new webhook event handler for when an issue is labeled
// ghApp.webhooks.on("issues.labeled", async (event) => {
//   const { payload } = event;
//   // Only add the issue to the queue if it is labeled with the "jacob" label
//   console.log(`Received issue #${payload.issue.number} labeled event`);
//   if (payload?.label?.name === "jacob") {
//     console.log(`Received issue #${payload.issue.number} with label "jacob"`);
//     publishGitHubEventToQueue(event);
//   } else {
//     console.log(`Received issue #${payload.issue.number} without label "jacob"`);
//   }
// });

// add a new webhook event handler for when an issue is assigned to a user
// ghApp.webhooks.on("issues.assigned", async (event) => {
//   const { payload } = event;
//   console.log(
//     `Received issue #${payload.issue.number} assigned event, ignoring...`,
//   );
// });

ghApp.webhooks.on("pull_request_review.submitted", async (event) => {
  const { payload } = event;
  const { repository } = payload;
  console.log(
    `[${repository.full_name}] Received PR #${payload.pull_request.number} submitted event`,
  );
  const appUsername = process.env.GITHUB_APP_USERNAME;

  const ottoShouldRespond =
    payload.review.body?.includes("@jacob-ai-bot") ??
    (appUsername && `${payload.pull_request.user.id}` === appUsername);

  if (
    ottoShouldRespond &&
    payload.action === "submitted" &&
    (payload.review.state === "changes_requested" ||
      payload.review.state === "commented")
  ) {
    console.log(
      `[${repository.full_name}] PR #${payload.pull_request.number} should be processed`,
    );
    void publishGitHubEventToQueue(
      event as WebhookPullRequestReviewWithCommentsSubmittedEventWithOctokit,
    );
  }
});

ghApp.webhooks.on("issue_comment.created", async (event) => {
  const { payload } = event;
  const { comment, issue, repository } = payload;
  console.log(
    `[${repository.full_name}] Received issue #${issue.number} comment created event`,
  );
  if (
    issue.pull_request &&
    PR_COMMAND_VALUES.some((cmd) => comment.body?.includes(cmd))
  ) {
    const prCommentCreatedEvent =
      event as WebhookPRCommentCreatedEventWithOctokit;
    console.log(
      `[${repository.full_name}] Pull request comment body contains @jacob-ai-bot <cmd> mention (PR #${issue.number})`,
    );
    void publishGitHubEventToQueue(prCommentCreatedEvent);
  } else if (comment.body?.includes("@jacob-ai-bot build")) {
    console.log(
      `[${repository.full_name}] Issue comment body contains @jacob-ai-bot build mention (Issue #${issue.number})`,
    );
    void publishGitHubEventToQueue(event);
  } else {
    console.log(
      `[${repository.full_name}] Issue comment is not a PR comment or body has no @jacob-ai-bot <cmd> mention (Issue #${issue.number})`,
    );
  }
});

ghApp.webhooks.on("pull_request.opened", async (event) => {
  const { payload } = event;
  const { pull_request, repository } = payload;
  console.log(
    `[${repository.full_name}] Received PR #${pull_request.number} comment created event`,
  );

  if (PR_COMMAND_VALUES.some((cmd) => pull_request.body?.includes(cmd))) {
    console.log(
      `[${repository.full_name}] Pull request body contains @jacob-ai-bot <cmd> mention (PR #${pull_request.number})`,
    );
    void publishGitHubEventToQueue(event);
  } else {
    console.log(
      `[${repository.full_name}] Pull request body has no @jacob-ai-bot fix <cmd> mention (Issue #${pull_request.number})`,
    );
  }
});

ghApp.webhooks.on("installation_repositories.added", async (event) => {
  const { payload } = event;
  const { repositories_added } = payload;
  const repos = repositories_added.map(({ full_name }) => full_name).join(",");

  console.log(`[${repos}] Received installation repositories added event`);

  void publishGitHubEventToQueue(event);
});

ghApp.webhooks.onAny(async ({ id, name }) => {
  console.log(`GitHub Webhook Handled: Event Name: ${name} (id: ${id})`);
});
