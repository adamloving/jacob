import {
  describe,
  test,
  expect,
  afterEach,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { type Issue, type Repository } from "@octokit/webhooks-types";

import issueCommentCreatedPRCommandFixErrorPayload from "../../data/test/webhooks/issue_comment.created.prCommand.fixError.json";
import { fixError, type PullRequest } from "./fixError";
import { type CheckAndCommitOptions } from "./checkAndCommit";

const mockedCheckAndCommit = vi.hoisted(() => ({
  checkAndCommit: vi
    .fn()
    .mockImplementation(() => new Promise((resolve) => resolve(undefined))),
}));
vi.mock("./checkAndCommit", () => mockedCheckAndCommit);

const mockedPR = vi.hoisted(() => ({
  concatenatePRFiles: vi.fn().mockResolvedValue({
    code: "__FILEPATH__file.txt__\ncode-with-error",
    lineLengthMap: { "file.txt": 1 },
  }),
}));
vi.mock("../github/pr", () => mockedPR);

const mockedIssue = vi.hoisted(() => ({
  getIssue: vi
    .fn()
    .mockImplementation(
      () => new Promise((resolve) => resolve({ data: { body: "body" } })),
    ),
  addCommentToIssue: vi
    .fn()
    .mockImplementation(() => new Promise((resolve) => resolve({}))),
}));
vi.mock("../github/issue", () => mockedIssue);

const mockedSourceMap = vi.hoisted(() => ({
  getSourceMap: vi.fn().mockImplementation(() => "source map"),
  getTypes: vi.fn().mockImplementation(() => "types"),
  getImages: vi.fn().mockImplementation(() => "images"),
}));
vi.mock("../analyze/sourceMap", () => mockedSourceMap);

const mockedFiles = vi.hoisted(() => ({
  reconstructFiles: vi.fn().mockReturnValue([
    {
      fileName: "file.txt",
      filePath: "/rootpath",
      codeBlock: "fixed-file-content",
    },
  ]),
}));
vi.mock("../utils/files", () => mockedFiles);

const mockedEvents = vi.hoisted(() => ({
  emitCodeEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("~/server/utils/events", () => mockedEvents);

const mockedRequest = vi.hoisted(() => ({
  sendGptRequest: vi
    .fn()
    .mockImplementation(
      () =>
        new Promise((resolve) =>
          resolve("__FILEPATH__file.txt__fixed-file-content"),
        ),
    ),
}));
vi.mock("../openai/request", () => mockedRequest);

const mockedAssessBuildError = vi.hoisted(() => ({
  assessBuildError: vi.fn().mockImplementation(
    () =>
      new Promise((resolve) =>
        resolve({
          fileName: "file.txt",
          causeOfErrors: "something went wrong",
          ideasForFixingErrors: "change something",
          suggestedFixes: "change some code",
          filesToUpdate: ["src/file.txt"],
        }),
      ),
  ),
}));
vi.mock("./assessBuildError", () => mockedAssessBuildError);

const originalPromptsFolder = process.env.PROMPT_FOLDER ?? "src/server/prompts";

describe("fixError", () => {
  beforeEach(() => {
    process.env.PROMPT_FOLDER = originalPromptsFolder;
  });

  afterEach(() => {
    delete process.env.PROMPT_FOLDER;
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  test("fixError calls", async () => {
    const prIssue = issueCommentCreatedPRCommandFixErrorPayload.issue as Issue;
    const mockEventData = {
      projectId: 1,
      repoFullName: "test-login/test-repo",
      userId: "test-user",
    };

    await fixError({
      ...mockEventData,
      repository: {
        owner: { login: "test-login" },
        name: "test-repo",
      } as Repository,
      token: "token",
      prIssue,
      body: "## Error Message (Attempt Number 2):\n```\nbuild-error-info\n\n```\n## Something else\n\n",
      rootPath: "/rootpath",
      branch: "jacob-issue-48-test",
      existingPr: { number: 48 } as PullRequest,
    });

    expect(mockedAssessBuildError.assessBuildError).toHaveBeenCalledTimes(1);
    expect(mockedAssessBuildError.assessBuildError).toHaveBeenLastCalledWith({
      ...mockEventData,
      errors: "build-error-info\n\n",
      sourceMap: "source map",
    });

    expect(mockedPR.concatenatePRFiles).toHaveBeenCalledTimes(1);
    expect(mockedPR.concatenatePRFiles).toHaveBeenLastCalledWith(
      "/rootpath",
      { name: "test-repo", owner: { login: "test-login" } },
      "token",
      48,
      undefined,
      ["src/file.txt"],
      undefined,
    );

    expect(mockedRequest.sendGptRequest).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const systemPrompt = mockedRequest.sendGptRequest.mock.calls[0][1];
    expect(systemPrompt).toContain("-- Types\ntypes\n");
    expect(systemPrompt).toContain(
      "-- Source Map (this is a map of the codebase, you can use it to find the correct files/functions to import. It is NOT part of the task!)\nsource map\n-- END Source Map\n",
    );
    expect(systemPrompt).toContain(
      "-- Cause Of Errors\nsomething went wrong\n\n-- Ideas For Fixing Errors\nchange something\n\n-- Suggested Fixes\nchange some code\n",
    );
    expect(systemPrompt).toContain(
      '-- Instructions\nThe code that needs to be updated is a file called "code.txt":\n\n__FILEPATH__file.txt__\ncode-with-error\n',
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const eventData = mockedRequest.sendGptRequest.mock.calls[0][3];
    expect(eventData).toEqual(mockEventData);

    expect(mockedFiles.reconstructFiles).toHaveBeenCalledTimes(1);
    expect(mockedFiles.reconstructFiles).toHaveBeenLastCalledWith(
      "__FILEPATH__file.txt__fixed-file-content",
      "/rootpath",
    );

    expect(mockedEvents.emitCodeEvent).toHaveBeenCalledTimes(1);
    expect(mockedEvents.emitCodeEvent).toHaveBeenLastCalledWith({
      ...mockEventData,
      codeBlock: "fixed-file-content",
      fileName: "file.txt",
      filePath: "/rootpath",
    });

    expect(mockedCheckAndCommit.checkAndCommit).toHaveBeenCalledTimes(1);
    const checkAndCommitCalls = mockedCheckAndCommit.checkAndCommit.mock.calls;
    const checkAndCommitOptions =
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      checkAndCommitCalls[0][0] as CheckAndCommitOptions;
    expect(checkAndCommitOptions.commitMessage).toBe(
      "JACoB fix error: change some code",
    );
    expect(checkAndCommitOptions.buildErrorAttemptNumber).toBe(2);
  });
});
