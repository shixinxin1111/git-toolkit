export type BranchScope = "all" | "favorites";
export type RemoteLayout = "tree" | "list";

export type BranchRecord = {
  id: string;
  repositoryRoot: string;
  name: string;
  current: boolean;
  favorite: boolean;
  lastCommitAt: number;
  upstream?: string;
  syncState: "ahead" | "behind" | "diverged" | "synced" | "none";
  ahead: number;
  behind: number;
};

export type RemoteBranchGroup = {
  repositoryRoot: string;
  remotes: Array<{
    name: string;
    branches: Array<{ displayName: string; record: BranchRecord }>;
  }>;
};

export type BranchPathNode =
  | {
      kind: "folder";
      name: string;
      path: string;
      children: BranchPathNode[];
    }
  | {
      kind: "branch";
      name: string;
      record: BranchRecord;
    };

export function createBranchId(
  repositoryRoot: string,
  branchName: string,
): string {
  return `${repositoryRoot}\0${branchName}`;
}

export function filterRemoteBranches(
  branches: BranchRecord[],
  scope: BranchScope,
): BranchRecord[] {
  return scope === "favorites"
    ? branches.filter((branch) => branch.favorite)
    : branches;
}

export function groupRemoteBranches(
  branches: BranchRecord[],
): RemoteBranchGroup[] {
  const repositories = new Map<
    string,
    Map<string, Array<{ displayName: string; record: BranchRecord }>>
  >();

  for (const branch of branches) {
    const separator = branch.name.indexOf("/");
    const remote =
      separator === -1 ? "remote" : branch.name.slice(0, separator);
    const displayName =
      separator === -1 ? branch.name : branch.name.slice(separator + 1);
    const remoteMap =
      repositories.get(branch.repositoryRoot) ??
      new Map<string, Array<{ displayName: string; record: BranchRecord }>>();
    const remoteBranches = remoteMap.get(remote) ?? [];
    remoteBranches.push({ displayName, record: branch });
    remoteMap.set(remote, remoteBranches);
    repositories.set(branch.repositoryRoot, remoteMap);
  }

  return [...repositories.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([repositoryRoot, remotes]) => ({
      repositoryRoot,
      remotes: [...remotes.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, remoteBranches]) => ({
          name,
          branches: remoteBranches.sort((left, right) =>
            left.displayName.localeCompare(right.displayName),
          ),
        })),
    }));
}

export function buildBranchPathTree(
  branches: Array<{ displayName: string; record: BranchRecord }>,
): BranchPathNode[] {
  const root: BranchPathNode[] = [];

  for (const branch of branches) {
    const segments = branch.displayName.split("/").filter(Boolean);
    let nodes = root;
    let currentPath = "";

    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let folder = nodes.find(
        (node): node is Extract<BranchPathNode, { kind: "folder" }> =>
          node.kind === "folder" && node.name === segment,
      );
      if (!folder) {
        folder = {
          kind: "folder",
          name: segment,
          path: currentPath,
          children: [],
        };
        nodes.push(folder);
      }
      nodes = folder.children;
    }

    nodes.push({
      kind: "branch",
      name: segments[segments.length - 1] ?? branch.displayName,
      record: branch.record,
    });
  }

  sortBranchPathNodes(root);
  return root;
}

function sortBranchPathNodes(nodes: BranchPathNode[]): void {
  nodes.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "folder" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  for (const node of nodes) {
    if (node.kind === "folder") {
      sortBranchPathNodes(node.children);
    }
  }
}

export function isBranchScope(value: unknown): value is BranchScope {
  return value === "all" || value === "favorites";
}

export function isRemoteLayout(value: unknown): value is RemoteLayout {
  return value === "tree" || value === "list";
}

export function formatRelativeTime(
  timestamp: number,
  now = Date.now(),
): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) {
    return "刚刚";
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }

  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days} 天前`;
  }

  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months} 个月前`;
  }

  return `${Math.floor(months / 12)} 年前`;
}

export function formatSyncCounts(ahead: number, behind: number): string {
  return ahead > 0 || behind > 0 ? `${behind}↓ ${ahead}↑` : "";
}

export function createSwimlaneInfo(branchName: string): string {
  const swimlane = branchName
    .replace(/[\/.\-]/g, "_")
    .replace(/^(apaas_|feat_)/, "");
  return `x-fe-env: ${swimlane}`;
}
