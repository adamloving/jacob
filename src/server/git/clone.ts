import { dir, type DirectoryResult } from "tmp-promise";
import {
  type BaseEventData,
  executeWithLogRequiringSuccess,
  type ExecAsyncException,
  executeWithLogRequiringSuccessWithoutEvent,
} from "../utils";

const HTTPS_PREFIX = "https://";
const HTTPS_SUFFIX = "github.com/";
const GIT_REPO_SUFFIX = ".git";

export interface CloneRepoParams {
  repoName: string;
  branch?: string;
  token?: string;
  baseEventData?: BaseEventData;
}

export async function cloneRepo({
  repoName,
  branch,
  token,
  baseEventData,
}: CloneRepoParams): Promise<DirectoryResult> {
  const tmpdir = process.env.TMP_DIR;
  const options = tmpdir
    ? { unsafeCleanup: true, tmpdir }
    : { unsafeCleanup: true };
  const result = await dir(options);
  const { path } = result;

  const args = branch ? `-b ${branch}` : "";
  const tokenArg = token ? `x-access-token:${token}@` : "";
  const cloneCommand = `git clone ${args} ${HTTPS_PREFIX}${tokenArg}${HTTPS_SUFFIX}${repoName}${GIT_REPO_SUFFIX} .`;
  try {
    if (baseEventData) {
      await executeWithLogRequiringSuccess({
        ...baseEventData,
        directory: path,
        command: cloneCommand,
      });
    } else {
      await executeWithLogRequiringSuccessWithoutEvent({
        directory: path,
        command: cloneCommand,
      });
    }
  } catch (error) {
    if (token) {
      // Throw this error, but with the token redacted from the message (as newError)
      // This prevents the actual token from being included in any github issue comments
      const originalError = error as ExecAsyncException;
      const message = originalError.message;
      const newMessage = message.replace(token, "<redacted>");
      const newError = new Error(newMessage);
      newError.name = originalError.name;
      newError.stack = originalError.stack;
      (newError as ExecAsyncException).cmd = originalError.cmd;
      (newError as ExecAsyncException).killed = originalError.killed;
      (newError as ExecAsyncException).code = originalError.code;
      (newError as ExecAsyncException).signal = originalError.signal;
      (newError as ExecAsyncException).stdout = originalError.stdout;
      (newError as ExecAsyncException).stderr = originalError.stderr;
      throw newError;
    } else {
      throw error;
    }
  }
  return result;
}
