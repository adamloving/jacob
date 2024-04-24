import { Request, Response } from "express";

import { cloneRepo } from "../git/clone";
import { getSourceMap } from "../analyze/sourceMap";
import { traverseCodebase } from "../analyze/traverse";
import { parseTemplate, getRepoSettings } from "../utils";
import { getIssue } from "../github/issue";
import { Issue } from "../messaging/queue";

import {
  ExtractedIssueInfoSchema,
  ExtractedIssueInfo,
} from "../code/extractedIssue";
import { sendGptRequestWithSchema } from "../openai/request";
import { Octokit } from "@octokit/rest";

interface QueryParams {
  repo?: string;
  issues?: string;
}

export async function getExtractedIssues(req: Request, res: Response) {
  const { authorization } = req.headers;
  const token: string | undefined = (authorization ?? "").trim().split(" ")[1];

  const { repo, issues } = req.query as QueryParams;
  const [repoOwner, repoName] = repo?.split("/") ?? [];

  if (!repo || !repoOwner || !repoName) {
    return res.status(400).json({ errors: ["Invalid request"] });
  }

  let issueNumbers =
    issues?.split(",").map((issue) => parseInt(issue, 10)) ?? [];

  // if no issue numbers are provided, fetch the most recent issues
  if (issueNumbers.length === 0 || issueNumbers.some((issue) => isNaN(issue))) {
    const octokit = new Octokit({
      auth: token,
    });
    const openIssues = await octokit.rest.issues.listForRepo({
      owner: repoOwner,
      repo: repoName,
      sort: "created",
      direction: "desc",
      state: "open",
      per_page: 10, // only fetch the 10 most recent issues
      page: 1,
    });

    // filter out the PRs
    const issuesWithoutPRs = openIssues.data.filter(
      (issue) => !issue.pull_request,
    );
    issueNumbers = issuesWithoutPRs.map((issue) => issue.number);
  }

  if (issueNumbers.length === 0 || issueNumbers.some((issue) => isNaN(issue))) {
    return res.status(400).json({ errors: ["Invalid request"] });
  }

  let cleanupClone: (() => Promise<void>) | undefined;
  try {
    const { path, cleanup } = await cloneRepo(repo, undefined, token);
    cleanupClone = cleanup;

    const repoSettings = getRepoSettings(path);
    const sourceMap =
      getSourceMap(path, repoSettings) || (await traverseCodebase(path));

    const issueData = await Promise.all(
      issueNumbers.map((issueNumber) =>
        getIssue(
          { name: repoName, owner: { login: repoOwner } },
          token,
          issueNumber,
        ),
      ),
    );

    const extractedIssues = await Promise.all(
      issueData.map(async ({ data: issue }) => {
        const issueBody = issue.body ? `\n${issue.body}` : "";
        const issueText = `${issue.title}${issueBody}`;

        const extractedIssueTemplateParams = {
          sourceMap,
          issueText,
        };

        const extractedIssueSystemPrompt = parseTemplate(
          "dev",
          "extracted_issue",
          "system",
          extractedIssueTemplateParams,
        );
        const extractedIssueUserPrompt = parseTemplate(
          "dev",
          "extracted_issue",
          "user",
          extractedIssueTemplateParams,
        );
        const extractedIssue = (await sendGptRequestWithSchema(
          extractedIssueUserPrompt,
          extractedIssueSystemPrompt,
          ExtractedIssueInfoSchema,
          0.2,
        )) as Promise<ExtractedIssueInfo>;

        return {
          id: `issue-${repoOwner}/${repoName}-${issue.number}`,
          issueId: issue.number,
          title: issue.title,
          description: issue.body ?? "",
          createdAt: issue.created_at,
          comments: [],
          author: issue.user?.login ?? "",
          assignee: issue.assignee?.login ?? "",
          status: issue.state,
          link: issue.html_url,
          ...extractedIssue,
        };
      }),
    );

    return res.status(200).json(extractedIssues);
  } catch (error) {
    return res.status(500).json({ errors: [`${error}`] });
  } finally {
    await cleanupClone?.();
  }
}

export const updateGithubIssue = async (req: Request, res: Response) => {
  const { authorization } = req.headers;
  const token: string | undefined = (authorization ?? "").trim().split(" ")[1];

  const { issue } = req.body as { issue: Issue };

  const octokit = new Octokit({
    auth: token,
  });

  try {
    const body = {
      owner: issue.link.split("/")[3],
      repo: issue.link.split("/")[4],
      issue_number: issue.issueId,
      title: issue.title,
      body: issue.description,
    };
    await octokit.issues.update(body);

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ errors: [`${error}`] });
  }
};

export const createGithubIssue = async (req: Request, res: Response) => {
  const { authorization } = req.headers;
  const token: string | undefined = (authorization ?? "").trim().split(" ")[1];

  const { issue } = req.body as {
    issue: { title: string; description: string; repo: string };
  };

  const octokit = new Octokit({
    auth: token,
  });

  try {
    const [owner, repo] = issue!.repo!.split("/");

    const body = {
      owner,
      repo,
      title: issue.title,
      body: issue.description,
    };

    // Creating a new GitHub issue
    await octokit.issues.create(body);

    return res.status(201).json({ success: true });
  } catch (error) {
    return res.status(500).json({ errors: [`${error}`] });
  }
};
