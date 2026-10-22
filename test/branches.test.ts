import assert from "node:assert/strict";
import test from "node:test";
import {
  BranchRecord,
  buildBranchPathTree,
  createBranchId,
  createSwimlaneInfo,
  filterRemoteBranches,
  formatRelativeTime,
  formatSyncCounts,
  groupRemoteBranches,
} from "../src/branches";

const repositoryRoot = "/workspace/project";
const branches: BranchRecord[] = [
  {
    id: createBranchId(repositoryRoot, "origin/main"),
    repositoryRoot,
    name: "origin/main",
    current: false,
    favorite: true,
    lastCommitAt: 1,
    syncState: "none",
    ahead: 0,
    behind: 0,
  },
  {
    id: createBranchId(repositoryRoot, "origin/feature/search"),
    repositoryRoot,
    name: "origin/feature/search",
    current: false,
    favorite: false,
    lastCommitAt: 2,
    syncState: "none",
    ahead: 0,
    behind: 0,
  },
  {
    id: createBranchId(repositoryRoot, "upstream/release"),
    repositoryRoot,
    name: "upstream/release",
    current: false,
    favorite: true,
    lastCommitAt: 3,
    syncState: "none",
    ahead: 0,
    behind: 0,
  },
];

test("shows all remote branches without filters", () => {
  assert.equal(filterRemoteBranches(branches, "all").length, 3);
});

test("shows only favorite remote branches", () => {
  assert.deepEqual(
    filterRemoteBranches(branches, "favorites").map(
      (branch) => branch.name,
    ),
    ["origin/main", "upstream/release"],
  );
});

test("groups remote branches by remote name", () => {
  const groups = groupRemoteBranches(branches);

  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].remotes.map((remote) => ({
      name: remote.name,
      branches: remote.branches.map((branch) => branch.displayName),
    })),
    [
      {
        name: "origin",
        branches: ["feature/search", "main"],
      },
      {
        name: "upstream",
        branches: ["release"],
      },
    ],
  );
});

test("formats relative commit times", () => {
  const now = Date.UTC(2026, 0, 1);

  assert.equal(formatRelativeTime(now - 30_000, now), "刚刚");
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), "5 分钟前");
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), "3 小时前");
  assert.equal(formatRelativeTime(now - 8 * 86_400_000, now), "8 天前");
  assert.equal(formatRelativeTime(now - 90 * 86_400_000, now), "3 个月前");
});

test("formats remote and local update counts", () => {
  assert.equal(formatSyncCounts(0, 0), "");
  assert.equal(formatSyncCounts(0, 24), "24↓ 0↑");
  assert.equal(formatSyncCounts(7, 0), "0↓ 7↑");
  assert.equal(formatSyncCounts(3, 2), "2↓ 3↑");
});

test("creates swimlane info from a branch name", () => {
  assert.equal(
    createSwimlaneInfo("feat/canvas-v2.foo"),
    "x-fe-env: canvas_v2_foo",
  );
  assert.equal(
    createSwimlaneInfo("apaas_feature-test"),
    "x-fe-env: feature_test",
  );
  assert.equal(
    createSwimlaneInfo("feature/plain"),
    "x-fe-env: feature_plain",
  );
});

test("groups slash-delimited branch names into folders", () => {
  const tree = buildBranchPathTree([
    {
      displayName: "feat/canvas",
      record: { ...branches[0], name: "feat/canvas" },
    },
    {
      displayName: "feat/editor",
      record: { ...branches[1], name: "feat/editor" },
    },
    {
      displayName: "master",
      record: { ...branches[2], name: "master" },
    },
  ]);

  assert.equal(tree[0].kind, "folder");
  assert.equal(tree[0].name, "feat");
  assert.equal(
    tree[0].kind === "folder" ? tree[0].children.length : 0,
    2,
  );
  assert.equal(tree[1].name, "master");
});
