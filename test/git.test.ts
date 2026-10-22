import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  checkoutLocalBranch,
  checkoutRemoteBranch,
  deleteLocalBranch,
  discoverRepositories,
  forcePushLocalBranch,
  listLocalBranches,
  listBranchCommits,
  listRemoteBranches,
  mergeBranchIntoCurrent,
  pushLocalBranch,
  rebaseCurrentBranchOnto,
  renameLocalBranch,
  resolveGitFile,
  setSkipWorktree,
} from "../src/git";

const execFileAsync = promisify(execFile);

test("skip-worktree hides changes until the record is disabled", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "git-toolkit-"),
  );
  const filePath = path.join(repositoryRoot, "tracked.txt");

  try {
    await runGit(repositoryRoot, ["init"]);
    await writeFile(filePath, "original\n");
    await runGit(repositoryRoot, ["add", "tracked.txt"]);
    await runGit(repositoryRoot, [
      "-c",
      "user.name=Git Local Ignore Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Initial commit",
    ]);

    const gitFile = await resolveGitFile(filePath);
    assert.deepEqual(gitFile, {
      repositoryRoot: await realpath(repositoryRoot),
      relativePath: "tracked.txt",
    });

    await setSkipWorktree(repositoryRoot, "tracked.txt", true);
    await writeFile(filePath, "changed\n");
    assert.equal(await gitStatus(repositoryRoot), "");

    await setSkipWorktree(repositoryRoot, "tracked.txt", false);
    assert.match(await gitStatus(repositoryRoot), /tracked\.txt/);
  } finally {
    await removeTestRepository(repositoryRoot);
  }
});

test("lists local and remote branches from a repository", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "git-toolkit-"),
  );

  try {
    await runGit(repositoryRoot, ["init"]);
    await writeFile(path.join(repositoryRoot, "tracked.txt"), "content\n");
    await runGit(repositoryRoot, ["add", "tracked.txt"]);
    await runGit(repositoryRoot, [
      "-c",
      "user.name=Git Toolkit Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Initial commit",
    ]);
    const currentBranch = await runGit(repositoryRoot, [
      "branch",
      "--show-current",
    ]);
    await runGit(repositoryRoot, ["branch", "feature/test"]);
    await runGit(repositoryRoot, ["init", "--bare", "remote.git"]);
    await runGit(repositoryRoot, [
      "remote",
      "add",
      "test-remote",
      "./remote.git",
    ]);
    await pushLocalBranch(
      repositoryRoot,
      currentBranch,
      `test-remote/${currentBranch}`,
    );
    await forcePushLocalBranch(
      repositoryRoot,
      currentBranch,
      `test-remote/${currentBranch}`,
    );
    assert.match(
      await runGit(path.join(repositoryRoot, "remote.git"), [
        "show-ref",
        `refs/heads/${currentBranch}`,
      ]),
      new RegExp(`refs/heads/${currentBranch}$`),
    );
    await runGit(repositoryRoot, [
      "update-ref",
      "refs/remotes/origin/main",
      "HEAD",
    ]);
    await runGit(repositoryRoot, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    await runGit(repositoryRoot, [
      "update-ref",
      "refs/remotes/upstream/release",
      "HEAD",
    ]);
    await runGit(repositoryRoot, [
      "update-ref",
      "refs/remotes/origin/remote-only",
      "HEAD",
    ]);

    assert.deepEqual(await discoverRepositories([repositoryRoot]), [
      await realpath(repositoryRoot),
    ]);

    const localBranches = await listLocalBranches(repositoryRoot);
    assert.deepEqual(
      localBranches.map((branch) => branch.name).sort(),
      [currentBranch, "feature/test"].sort(),
    );
    assert.equal(
      localBranches.find((branch) => branch.name === currentBranch)?.current,
      true,
    );

    await mergeBranchIntoCurrent(repositoryRoot, "feature/test");
    await rebaseCurrentBranchOnto(repositoryRoot, "feature/test");

    await renameLocalBranch(
      repositoryRoot,
      "feature/test",
      "feature/renamed",
    );
    await checkoutLocalBranch(repositoryRoot, "feature/renamed");
    assert.equal(
      await runGit(repositoryRoot, ["branch", "--show-current"]),
      "feature/renamed",
    );
    await checkoutLocalBranch(repositoryRoot, currentBranch);
    await deleteLocalBranch(repositoryRoot, "feature/renamed", false);
    await runGit(repositoryRoot, ["branch", "force-delete"]);
    await deleteLocalBranch(repositoryRoot, "force-delete", true);

    assert.deepEqual(
      (await listRemoteBranches(repositoryRoot))
        .map((branch) => branch.name)
        .sort(),
      [
        "origin/main",
        "origin/remote-only",
        `test-remote/${currentBranch}`,
        "upstream/release",
      ],
    );

    const commits = await listBranchCommits(
      repositoryRoot,
      currentBranch,
      0,
      10,
    );
    assert.equal(commits.length, 1);
    assert.equal(commits[0].subject, "Initial commit");
    assert.ok(commits[0].committedAt > 0);

    assert.equal(
      await checkoutRemoteBranch(repositoryRoot, "origin/remote-only"),
      "remote-only",
    );
    assert.equal(
      await runGit(repositoryRoot, ["branch", "--show-current"]),
      "remote-only",
    );
  } finally {
    await removeTestRepository(repositoryRoot);
  }
});

async function gitStatus(repositoryRoot: string): Promise<string> {
  return runGit(repositoryRoot, ["status", "--porcelain"]);
}

async function removeTestRepository(repositoryRoot: string): Promise<void> {
  await rm(repositoryRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

async function runGit(
  repositoryRoot: string,
  args: string[],
): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return result.stdout.trim();
}
