import { executeWithLogRequiringSuccess } from "../utils";

const appName = process.env.GITHUB_APP_NAME ?? "";
const appUsername = process.env.GITHUB_APP_USERNAME ?? "";

export async function addCommitAndPush(
  rootPath: string,
  branchName: string,
  commitMessage: string,
) {
  // Stage all files
  await executeWithLogRequiringSuccess(rootPath, "git add .");

  // Prepare author info
  await executeWithLogRequiringSuccess(
    rootPath,
    `git config --local user.name "${appName}[bot]"`,
  );
  await executeWithLogRequiringSuccess(
    rootPath,
    `git config --local user.email "${appUsername}+${appName}[bot]@users.noreply.github.com"`,
  );

  // Commit files
  await executeWithLogRequiringSuccess(
    rootPath,
    `git commit -m "${commitMessage}"`,
  );

  // Push branch to origin
  return await executeWithLogRequiringSuccess(
    rootPath,
    `git push --set-upstream origin ${branchName}`,
  );
}
