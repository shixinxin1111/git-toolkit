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
  createLocalBranch,
  deleteLocalBranch,
  discoverRepositories,
  forcePushLocalBranch,
  getLineBlame,
  listLocalBranches,
  listBranchCommits,
  listCommitChanges,
  listRemotes,
  listRemoteBranches,
  mergeBranchIntoCurrent,
  publishLocalBranch,
  pushLocalBranch,
  rebaseCurrentBranchOnto,
  renameLocalBranch,
  resetCurrentBranchToCommit,
  readGitBlob,
  resolveGitFile,
  setSkipWorktree,
} from "../src/git";

const execFileAsync = promisify(execFile);

test("gets commit details for a tracked line", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "git-toolkit-"),
  );
  const filePath = path.join(repositoryRoot, "tracked.txt");

  try {
    await runGit(repositoryRoot, ["init"]);
    await writeFile(filePath, "first line\nsecond line\n");
    await runGit(repositoryRoot, ["add", "tracked.txt"]);
    await runGit(repositoryRoot, [
      "-c",
      "user.name=Line Author",
      "-c",
      "user.email=line@example.com",
      "commit",
      "-m",
      "Add tracked lines",
    ]);

    const blame = await getLineBlame(repositoryRoot, "tracked.txt", 2);
    assert.equal(blame?.author, "Line Author");
    assert.equal(blame?.subject, "Add tracked lines");
    assert.equal(blame?.shortHash.length, 8);
    assert.ok((blame?.committedAt ?? 0) > 0);

    await writeFile(filePath, "first line\nchanged locally\n");
    assert.equal(
      await getLineBlame(repositoryRoot, "tracked.txt", 2),
      undefined,
    );
  } finally {
    await removeTestRepository(repositoryRoot);
  }
});

test("lists commit file changes and reads both blob versions", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "git-toolkit-"),
  );
  const originalPath = path.join(repositoryRoot, "original.txt");
  const renamedPath = path.join(repositoryRoot, "renamed.txt");

  try {
    await runGit(repositoryRoot, ["init"]);
    await writeFile(originalPath, "first\nsecond\nthird\nbefore\n");
    await runGit(repositoryRoot, ["add", "original.txt"]);
    await runGit(repositoryRoot, [
      "-c",
      "user.name=Git Toolkit Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Initial commit",
    ]);

    await runGit(repositoryRoot, ["mv", "original.txt", "renamed.txt"]);
    await writeFile(renamedPath, "first\nsecond\nthird\nafter\n");
    await writeFile(path.join(repositoryRoot, "added.txt"), "added\n");
    await runGit(repositoryRoot, ["add", "."]);
    await runGit(repositoryRoot, [
      "-c",
      "user.name=Git Toolkit Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Rename and add files",
    ]);
    const commit = await runGit(repositoryRoot, ["rev-parse", "HEAD"]);

    const changes = await listCommitChanges(repositoryRoot, commit);
    assert.deepEqual(
      changes.map((change) => [change.status, change.path]),
      [
        ["A", "added.txt"],
        ["R", "renamed.txt"],
      ],
    );
    const renamed = changes[1];
    assert.equal(renamed.previousPath, "original.txt");
    assert.equal(
      await readGitBlob(repositoryRoot, renamed.beforeBlob ?? ""),
      "first\nsecond\nthird\nbefore\n",
    );
    assert.equal(
      await readGitBlob(repositoryRoot, renamed.afterBlob ?? ""),
      "first\nsecond\nthird\nafter\n",
    );
  } finally {
    await removeTestRepository(repositoryRoot);
  }
});

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

test("resets the current branch to a commit in mixed mode", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "git-toolkit-"),
  );
  const filePath = path.join(repositoryRoot, "tracked.txt");

  try {
    await runGit(repositoryRoot, ["init"]);
    await writeFile(filePath, "first\n");
    await runGit(repositoryRoot, ["add", "tracked.txt"]);
    await runGit(repositoryRoot, [
      "-c",
      "user.name=Git Toolkit Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "First commit",
    ]);
    const firstCommit = await runGit(repositoryRoot, ["rev-parse", "HEAD"]);

    await writeFile(filePath, "second\n");
    await runGit(repositoryRoot, ["add", "tracked.txt"]);
    await runGit(repositoryRoot, [
      "-c",
      "user.name=Git Toolkit Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Second commit",
    ]);

    await resetCurrentBranchToCommit(
      repositoryRoot,
      firstCommit,
      "mixed",
    );

    assert.equal(
      await runGit(repositoryRoot, ["rev-parse", "HEAD"]),
      firstCommit,
    );
    assert.equal(await gitStatus(repositoryRoot), "M tracked.txt");
  } finally {
    await removeTestRepository(repositoryRoot);
  }
});

test("publishes a local branch and configures its upstream", async () => {
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
    const branchName = await runGit(repositoryRoot, [
      "branch",
      "--show-current",
    ]);
    await runGit(repositoryRoot, ["init", "--bare", "remote.git"]);
    await runGit(repositoryRoot, [
      "remote",
      "add",
      "origin",
      "./remote.git",
    ]);

    assert.deepEqual(await listRemotes(repositoryRoot), ["origin"]);
    await publishLocalBranch(repositoryRoot, branchName, "origin");

    assert.equal(
      await runGit(repositoryRoot, [
        "rev-parse",
        "--abbrev-ref",
        `${branchName}@{upstream}`,
      ]),
      `origin/${branchName}`,
    );
    assert.match(
      await runGit(path.join(repositoryRoot, "remote.git"), [
        "show-ref",
        `refs/heads/${branchName}`,
      ]),
      new RegExp(`refs/heads/${branchName}$`),
    );
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

    await createLocalBranch(
      repositoryRoot,
      "feature/test",
      "feature/created",
    );
    assert.equal(
      await runGit(repositoryRoot, ["rev-parse", "feature/created"]),
      await runGit(repositoryRoot, ["rev-parse", "feature/test"]),
    );
    assert.equal(
      await runGit(repositoryRoot, ["branch", "--show-current"]),
      "feature/created",
    );
    await checkoutLocalBranch(repositoryRoot, currentBranch);
    await deleteLocalBranch(repositoryRoot, "feature/created", false);

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
