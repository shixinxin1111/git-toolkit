import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitFile = {
  repositoryRoot: string;
  relativePath: string;
};

export type GitBranch = {
  name: string;
  current: boolean;
  lastCommitAt: number;
  upstream?: string;
  syncState: "ahead" | "behind" | "diverged" | "synced" | "none";
  ahead: number;
  behind: number;
};

export type GitCommit = {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  committedAt: number;
};

export type UpdateLocalBranchesResult = {
  updated: number;
  skipped: number;
  failed: number;
};

export async function discoverRepositories(
  directories: string[],
): Promise<string[]> {
  const roots = await Promise.all(
    directories.map(async (directory) => {
      try {
        return (
          await runGit(directory, ["rev-parse", "--show-toplevel"])
        ).trim();
      } catch {
        return undefined;
      }
    }),
  );

  return [...new Set(roots.filter((root): root is string => Boolean(root)))];
}

export async function listLocalBranches(
  repositoryRoot: string,
): Promise<GitBranch[]> {
  const output = await runGit(repositoryRoot, [
    "for-each-ref",
    "--format=%(refname:short)%00%(HEAD)%00%(committerdate:unix)%00%(upstream:short)%00%(upstream:trackshort)%00%(upstream:track,nobracket)",
    "refs/heads",
  ]);

  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [name, head, committedAt, upstream, track, tracking] =
        line.split("\0");
      const counts = parseTrackingCounts(tracking);
      return {
        name,
        current: head === "*",
        lastCommitAt: Number(committedAt) * 1000,
        upstream: upstream || undefined,
        syncState: parseSyncState(track),
        ...counts,
      };
    });
}

export async function listRemoteBranches(
  repositoryRoot: string,
): Promise<GitBranch[]> {
  const output = await runGit(repositoryRoot, [
    "for-each-ref",
    "--format=%(refname:short)%00%(symref)%00%(committerdate:unix)",
    "refs/remotes",
  ]);

  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [name, symref, committedAt] = line.split("\0");
      return { name, symref, committedAt };
    })
    .filter((branch) => !branch.symref)
    .map(({ name, committedAt }) => ({
      name,
      current: false,
      lastCommitAt: Number(committedAt) * 1000,
      syncState: "none" as const,
      ahead: 0,
      behind: 0,
    }));
}

export async function listBranchCommits(
  repositoryRoot: string,
  branch: string,
  offset: number,
  limit: number,
): Promise<GitCommit[]> {
  const output = await runGit(repositoryRoot, [
    "log",
    branch,
    `--skip=${offset}`,
    `--max-count=${limit}`,
    "--format=%H%x00%h%x00%ct%x00%an%x00%s",
  ]);

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, committedAt, author, subject] =
        line.split("\0");
      return {
        hash,
        shortHash,
        committedAt: Number(committedAt) * 1000,
        author,
        subject,
      };
    });
}

export async function fetchAllRemotes(
  repositoryRoot: string,
): Promise<void> {
  await runGit(repositoryRoot, ["fetch", "--all", "--prune"]);
}

export async function fetchRemote(
  repositoryRoot: string,
  remote: string,
): Promise<void> {
  await runGit(repositoryRoot, ["fetch", remote, "--prune"]);
}

export async function updateAllLocalBranches(
  repositoryRoot: string,
): Promise<UpdateLocalBranchesResult> {
  await fetchAllRemotes(repositoryRoot);
  const branches = await listLocalBranches(repositoryRoot);
  const result: UpdateLocalBranchesResult = {
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  for (const branch of branches) {
    if (!branch.upstream || branch.syncState !== "behind") {
      result.skipped += 1;
      continue;
    }

    try {
      if (branch.current) {
        await runGit(repositoryRoot, [
          "merge",
          "--ff-only",
          branch.upstream,
        ]);
      } else {
        await runGit(repositoryRoot, [
          "update-ref",
          `refs/heads/${branch.name}`,
          branch.upstream,
          `refs/heads/${branch.name}`,
        ]);
      }
      result.updated += 1;
    } catch {
      result.failed += 1;
    }
  }

  return result;
}

export async function resolveGitFile(filePath: string): Promise<GitFile> {
  const directory = await realpath(path.dirname(filePath));
  const normalizedFilePath = path.join(directory, path.basename(filePath));
  const repositoryRoot = (
    await runGit(directory, ["rev-parse", "--show-toplevel"])
  ).trim();
  const relativePath = path.relative(repositoryRoot, normalizedFilePath);

  if (
    !relativePath ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("所选文件不在当前 Git 仓库中。");
  }

  await runGit(repositoryRoot, [
    "ls-files",
    "--error-unmatch",
    "--",
    relativePath,
  ]);

  return { repositoryRoot, relativePath };
}

export async function setSkipWorktree(
  repositoryRoot: string,
  relativePath: string,
  enabled: boolean,
): Promise<void> {
  await runGit(repositoryRoot, [
    "update-index",
    enabled ? "--skip-worktree" : "--no-skip-worktree",
    "--",
    relativePath,
  ]);
}

export async function checkoutRemoteBranch(
  repositoryRoot: string,
  remoteBranch: string,
): Promise<string> {
  const separator = remoteBranch.indexOf("/");
  if (separator === -1 || separator === remoteBranch.length - 1) {
    throw new Error("远程分支名称无效。");
  }

  const localBranch = remoteBranch.slice(separator + 1);
  let localBranchExists = true;
  try {
    await runGit(repositoryRoot, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${localBranch}`,
    ]);
  } catch {
    localBranchExists = false;
  }

  await runGit(
    repositoryRoot,
    localBranchExists
      ? ["checkout", localBranch]
      : ["checkout", "-b", localBranch, remoteBranch],
  );
  return localBranch;
}

export async function checkoutLocalBranch(
  repositoryRoot: string,
  branch: string,
): Promise<void> {
  await runGit(repositoryRoot, ["checkout", branch]);
}

export async function createLocalBranch(
  repositoryRoot: string,
  sourceBranch: string,
  branch: string,
): Promise<void> {
  await runGit(repositoryRoot, [
    "checkout",
    "-b",
    branch,
    sourceBranch,
  ]);
}

export async function renameLocalBranch(
  repositoryRoot: string,
  branch: string,
  nextName: string,
): Promise<void> {
  await runGit(repositoryRoot, ["branch", "-m", branch, nextName]);
}

export async function deleteLocalBranch(
  repositoryRoot: string,
  branch: string,
  force: boolean,
): Promise<void> {
  await runGit(repositoryRoot, [
    "branch",
    force ? "-D" : "-d",
    branch,
  ]);
}

export async function deleteRemoteBranch(
  repositoryRoot: string,
  remoteBranch: string,
): Promise<void> {
  const separator = remoteBranch.indexOf("/");
  if (separator === -1 || separator === remoteBranch.length - 1) {
    throw new Error("远程分支名称无效。");
  }
  const remote = remoteBranch.slice(0, separator);
  const branch = remoteBranch.slice(separator + 1);
  await runGit(repositoryRoot, ["push", remote, "--delete", branch]);
}

export async function mergeBranchIntoCurrent(
  repositoryRoot: string,
  branch: string,
): Promise<void> {
  await runGit(repositoryRoot, ["merge", "--no-edit", branch]);
}

export async function rebaseCurrentBranchOnto(
  repositoryRoot: string,
  branch: string,
): Promise<void> {
  await runGit(repositoryRoot, ["rebase", branch]);
}

export async function resetCurrentBranchToCommit(
  repositoryRoot: string,
  commit: string,
): Promise<void> {
  await runGit(repositoryRoot, ["reset", "--mixed", commit]);
}

export async function pullLocalBranch(
  repositoryRoot: string,
  branchName: string,
  upstream: string | undefined,
): Promise<"updated" | "unchanged"> {
  if (!upstream) {
    throw new Error("该分支没有配置上游分支。");
  }

  const separator = upstream.indexOf("/");
  if (separator === -1) {
    throw new Error("上游分支名称无效。");
  }
  await fetchRemote(repositoryRoot, upstream.slice(0, separator));

  const branch = (await listLocalBranches(repositoryRoot)).find(
    (item) => item.name === branchName,
  );
  if (!branch) {
    throw new Error("本地分支已不存在。");
  }
  if (branch.syncState === "diverged") {
    throw new Error("本地与远程分支已经分叉，无法自动快进。");
  }
  if (branch.syncState !== "behind") {
    return "unchanged";
  }

  if (branch.current) {
    await runGit(repositoryRoot, ["merge", "--ff-only", upstream]);
  } else {
    await runGit(repositoryRoot, [
      "update-ref",
      `refs/heads/${branch.name}`,
      upstream,
      `refs/heads/${branch.name}`,
    ]);
  }
  return "updated";
}

export async function pushLocalBranch(
  repositoryRoot: string,
  branchName: string,
  upstream: string | undefined,
): Promise<void> {
  if (!upstream) {
    throw new Error("该分支没有配置上游分支。");
  }

  const separator = upstream.indexOf("/");
  if (separator === -1 || separator === upstream.length - 1) {
    throw new Error("上游分支名称无效。");
  }
  const remote = upstream.slice(0, separator);
  const remoteBranch = upstream.slice(separator + 1);
  await runGit(repositoryRoot, [
    "push",
    remote,
    `${branchName}:${remoteBranch}`,
  ]);
}

export async function forcePushLocalBranch(
  repositoryRoot: string,
  branchName: string,
  upstream: string | undefined,
): Promise<void> {
  if (!upstream) {
    throw new Error("该分支没有配置上游分支。");
  }

  const separator = upstream.indexOf("/");
  if (separator === -1 || separator === upstream.length - 1) {
    throw new Error("上游分支名称无效。");
  }
  const remote = upstream.slice(0, separator);
  const remoteBranch = upstream.slice(separator + 1);
  await runGit(repositoryRoot, [
    "push",
    "--force-with-lease",
    remote,
    `${branchName}:${remoteBranch}`,
  ]);
}

function parseSyncState(
  value: string | undefined,
): GitBranch["syncState"] {
  if (value === ">") {
    return "ahead";
  }
  if (value === "<") {
    return "behind";
  }
  if (value === "<>") {
    return "diverged";
  }
  if (value === "=") {
    return "synced";
  }
  return "none";
}

function parseTrackingCounts(value: string | undefined): {
  ahead: number;
  behind: number;
} {
  return {
    ahead: Number(value?.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(value?.match(/behind (\d+)/)?.[1] ?? 0),
  };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        LANG: "C",
        LC_ALL: "C",
      },
    });
    return result.stdout;
  } catch (error) {
    if (isExecError(error)) {
      const detail = error.stderr.trim() || error.message;
      throw new Error(detail);
    }
    throw error;
  }
}

function isExecError(
  error: unknown,
): error is Error & { stderr: string } {
  return (
    error instanceof Error &&
    "stderr" in error &&
    typeof error.stderr === "string"
  );
}
