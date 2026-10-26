import * as path from "node:path";
import * as vscode from "vscode";
import {
  BranchRecord,
  BranchScope,
  BranchPathNode,
  RemoteLayout,
  RemoteBranchGroup,
  buildBranchPathTree,
  createBranchId,
  filterRemoteBranches,
  formatRelativeTime,
  formatSyncCounts,
  groupRemoteBranches,
  isBranchScope,
  isRemoteLayout,
} from "./branches";
import {
  GitBranch,
  GitCommit,
  discoverRepositories,
  listBranchCommits,
  listLocalBranches,
  listRemoteBranches,
} from "./git";
import {
  IgnoreRecord,
  disableRecord,
  isIgnoreRecord,
  removeRecord,
  upsertActiveRecord,
} from "./records";

const IGNORE_STORAGE_KEY = "gitLocalIgnore.records";
const FAVORITES_KEY = "gitToolkit.remoteFavorites";
const REMOTE_SCOPE_KEY = "gitToolkit.remoteScope";
const LOCAL_LAYOUT_KEY = "gitToolkit.localLayout";
const REMOTE_LAYOUT_KEY = "gitToolkit.remoteLayout";
const COMMIT_PAGE_SIZE = 10;
const BRANCH_SCHEME = "git-toolkit-branch";

type BranchWithRepository = GitBranch & { repositoryRoot: string };
type BranchHistoryItem = LocalBranchTreeItem | RemoteBranchTreeItem;
type BranchIconPath = vscode.Uri | { light: vscode.Uri; dark: vscode.Uri };

export type BranchIconSet = {
  default: BranchIconPath;
  ahead: BranchIconPath;
  behind: BranchIconPath;
  diverged: BranchIconPath;
  current: BranchIconPath;
  currentAhead: BranchIconPath;
  currentBehind: BranchIconPath;
  currentDiverged: BranchIconPath;
};

class EmptyTreeItem extends vscode.TreeItem {
  constructor(label: string, description: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = "gitToolkit.empty";
  }
}

export class IgnoreTreeItem extends vscode.TreeItem {
  constructor(public readonly record: IgnoreRecord) {
    const absolutePath = path.join(
      record.repositoryRoot,
      record.relativePath,
    );
    super(path.basename(record.relativePath), vscode.TreeItemCollapsibleState.None);

    this.id = record.id;
    this.resourceUri = vscode.Uri.file(absolutePath);
    this.description = record.active
      ? record.relativePath
      : `已取消 · ${record.relativePath}`;
    this.tooltip = `${absolutePath}\n${record.active ? "本地忽略" : "已取消忽略"}`;
    this.contextValue = record.active
      ? "gitToolkit.ignore.active"
      : "gitToolkit.ignore.disabled";
    this.iconPath = new vscode.ThemeIcon(
      record.active ? "exclude" : "circle-slash",
      record.active
        ? undefined
        : new vscode.ThemeColor("disabledForeground"),
    );
    this.command = {
      command: "vscode.open",
      title: "打开文件",
      arguments: [this.resourceUri],
    };
  }
}

export class IgnoreTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly state: vscode.Memento,
    private readonly onCountChanged: (count: number) => void,
  ) {
    this.onCountChanged(this.getRecords().length);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  refresh(): void {
    this.onCountChanged(this.getRecords().length);
    this.changeEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const records = this.getRecords();
    this.onCountChanged(records.length);
    return records.length
      ? records.map((record) => new IgnoreTreeItem(record))
      : [new EmptyTreeItem("还没有本地忽略记录", "在文件右键菜单中添加")];
  }

  getRecords(): IgnoreRecord[] {
    const value = this.state.get<unknown>(IGNORE_STORAGE_KEY, []);
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter(isIgnoreRecord)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  findRecord(id: string): IgnoreRecord | undefined {
    return this.getRecords().find((record) => record.id === id);
  }

  async addOrEnable(
    repositoryRoot: string,
    relativePath: string,
  ): Promise<void> {
    await this.save(
      upsertActiveRecord(this.getRecords(), repositoryRoot, relativePath),
    );
  }

  async disable(id: string): Promise<void> {
    await this.save(disableRecord(this.getRecords(), id));
  }

  async remove(id: string): Promise<void> {
    await this.save(removeRecord(this.getRecords(), id));
  }

  private async save(records: IgnoreRecord[]): Promise<void> {
    await this.state.update(IGNORE_STORAGE_KEY, records);
    this.refresh();
  }
}

export class LocalBranchTreeItem extends vscode.TreeItem {
  constructor(
    public readonly branch: BranchRecord,
    icons: BranchIconSet,
    displayName = branch.name,
  ) {
    super(displayName, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = branch.id;
    this.description = [
      formatSyncCounts(branch.ahead, branch.behind),
      formatRelativeTime(branch.lastCommitAt),
    ]
      .filter(Boolean)
      .join(" · ");
    this.tooltip = createBranchTooltip(branch);
    this.contextValue = [
      "gitToolkit.localBranch",
      branch.upstream ? "withUpstream" : "withoutUpstream",
      branch.syncState,
      branch.current ? "current" : "other",
    ].join(".");
    this.iconPath = getBranchIcon(
      icons,
      branch.syncState,
      branch.current,
    );
    this.resourceUri = createBranchDecorationUri(branch);
  }
}

class BranchFolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly node: Extract<BranchPathNode, { kind: "folder" }>,
    public readonly scope: "local" | "remote",
  ) {
    super(node.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `${scope}\0${node.path}`;
    this.tooltip = node.path;
    this.contextValue = `gitToolkit.${scope}Folder`;
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

export class RemoteGroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly group: RemoteBranchGroup["remotes"][number],
    public readonly repositoryRoot: string,
    showRepository: boolean,
  ) {
    super(group.name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `${repositoryRoot}\0${group.name}`;
    this.description = showRepository
      ? path.basename(repositoryRoot)
      : undefined;
    this.tooltip = `远程：${group.name}\n仓库：${repositoryRoot}`;
    this.contextValue = "gitToolkit.remoteGroup";
    this.iconPath = new vscode.ThemeIcon("cloud");
  }
}

export class RemoteBranchTreeItem extends vscode.TreeItem {
  constructor(
    public readonly branch: BranchRecord,
    displayName: string,
    icons: BranchIconSet,
  ) {
    super(displayName, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = branch.id;
    this.description = [
      formatRelativeTime(branch.lastCommitAt),
      branch.favorite ? "★" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    this.tooltip = createBranchTooltip(branch);
    this.contextValue = branch.favorite
      ? "gitToolkit.remoteBranch.favorite"
      : "gitToolkit.remoteBranch";
    this.iconPath = icons.default;
  }
}

export class CommitTreeItem extends vscode.TreeItem {
  constructor(
    public readonly commit: GitCommit,
    public readonly repositoryRoot: string,
    branchId: string,
  ) {
    super(commit.subject, vscode.TreeItemCollapsibleState.None);
    this.id = `${branchId}\0${commit.hash}`;
    this.description = `${commit.shortHash} · ${commit.author} · ${formatRelativeTime(commit.committedAt)}`;
    this.tooltip = `${commit.subject}\n${commit.hash}\n${commit.author} · ${new Date(commit.committedAt).toLocaleString()}`;
    this.contextValue = "gitToolkit.commit";
    this.iconPath = new vscode.ThemeIcon("git-commit");
  }
}

class LoadMoreTreeItem extends vscode.TreeItem {
  constructor(branch: BranchHistoryItem, command: string) {
    super("查看更多", vscode.TreeItemCollapsibleState.None);
    this.description = `再显示 ${COMMIT_PAGE_SIZE} 条`;
    this.tooltip = `加载接下来的 ${COMMIT_PAGE_SIZE} 条提交`;
    this.contextValue = "gitToolkit.loadMore";
    this.iconPath = new vscode.ThemeIcon("ellipsis");
    this.command = {
      command,
      title: "查看更多提交",
      arguments: [branch],
    };
  }
}

abstract class BranchHistoryProvider implements vscode.Disposable {
  protected readonly changeEmitter = new vscode.EventEmitter<
    vscode.TreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly loadedCommitCounts = new Map<string, number>();

  dispose(): void {
    this.changeEmitter.dispose();
  }

  loadMore(branch: BranchHistoryItem): void {
    const loaded = this.loadedCommitCounts.get(branch.branch.id) ?? COMMIT_PAGE_SIZE;
    this.loadedCommitCounts.set(branch.branch.id, loaded + COMMIT_PAGE_SIZE);
    this.changeEmitter.fire(branch);
  }

  protected async getCommitChildren(
    branch: BranchHistoryItem,
    loadMoreCommand: string,
  ): Promise<vscode.TreeItem[]> {
    const limit =
      this.loadedCommitCounts.get(branch.branch.id) ?? COMMIT_PAGE_SIZE;
    const commits = await listBranchCommits(
      branch.branch.repositoryRoot,
      branch.branch.name,
      0,
      limit + 1,
    );
    const hasMore = commits.length > limit;
    const items: vscode.TreeItem[] = commits
      .slice(0, limit)
      .map(
        (commit) =>
          new CommitTreeItem(
            commit,
            branch.branch.repositoryRoot,
            branch.branch.id,
          ),
      );

    if (hasMore) {
      items.push(new LoadMoreTreeItem(branch, loadMoreCommand));
    }
    return items;
  }
}

export class LocalBranchTreeProvider
  extends BranchHistoryProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  constructor(
    private readonly state: vscode.Memento,
    private readonly icons: BranchIconSet,
    private readonly onCountChanged: (count: number) => void,
  ) {
    super();
  }

  refresh(): void {
    this.changeEmitter.fire();
    void this.updateCount();
  }

  async updateCount(): Promise<void> {
    this.onCountChanged((await loadBranches(listLocalBranches)).length);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (
      element instanceof BranchFolderTreeItem &&
      element.scope === "local"
    ) {
      return createBranchPathItems(
        element.node.children,
        "local",
        this.icons,
      );
    }
    if (element instanceof LocalBranchTreeItem) {
      return this.getCommitChildren(
        element,
        "gitToolkit.loadMoreLocalCommits",
      );
    }

    const branches = await loadBranches(listLocalBranches);
    this.onCountChanged(branches.length);
    if (branches.length === 0) {
      return [
        new EmptyTreeItem(
          "没有本地分支",
          "当前工作区中没有可用的 Git 仓库或分支",
        ),
      ];
    }

    const records = branches
      .map(toBranchRecord)
      .sort(compareBranches);

    if (this.getLayout() === "tree") {
      const currentBranches = records
        .filter((record) => record.current)
        .map((record) => new LocalBranchTreeItem(record, this.icons));
      const groupedBranches = createBranchPathItems(
        buildBranchPathTree(
          records
            .filter((record) => !record.current)
            .map((record) => ({
              displayName: record.name,
              record,
            })),
        ),
        "local",
        this.icons,
      );
      return [...currentBranches, ...groupedBranches];
    }

    return records.map(
      (branch) =>
        new LocalBranchTreeItem(branch, this.icons),
    );
  }

  getLayout(): RemoteLayout {
    const value = this.state.get<unknown>(LOCAL_LAYOUT_KEY);
    return isRemoteLayout(value) ? value : "list";
  }

  async setLayout(layout: RemoteLayout): Promise<void> {
    await this.state.update(LOCAL_LAYOUT_KEY, layout);
    this.refresh();
  }
}

export class RemoteBranchTreeProvider
  extends BranchHistoryProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  constructor(
    private readonly state: vscode.Memento,
    private readonly icons: BranchIconSet,
    private readonly onCountChanged: (count: number) => void,
  ) {
    super();
  }

  refresh(): void {
    this.changeEmitter.fire();
    void this.updateCount();
  }

  async updateCount(): Promise<void> {
    const groups = await this.getGroups();
    this.onCountChanged(
      groups.reduce((count, repository) => count + repository.remotes.length, 0),
    );
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element instanceof RemoteGroupTreeItem) {
      if (this.getLayout() === "list") {
        return element.group.branches.map(
          (branch) =>
            new RemoteBranchTreeItem(
              branch.record,
              branch.displayName,
              this.icons,
            ),
        );
      }
      return createBranchPathItems(
        buildBranchPathTree(element.group.branches),
        "remote",
        this.icons,
      );
    }
    if (
      element instanceof BranchFolderTreeItem &&
      element.scope === "remote"
    ) {
      return createBranchPathItems(
        element.node.children,
        "remote",
        this.icons,
      );
    }
    if (element instanceof RemoteBranchTreeItem) {
      return this.getCommitChildren(
        element,
        "gitToolkit.loadMoreRemoteCommits",
      );
    }

    const branches = await this.getBranches();
    const groups = groupRemoteBranches(branches);
    const remoteCount = groups.reduce(
      (count, repository) => count + repository.remotes.length,
      0,
    );
    this.onCountChanged(remoteCount);
    if (remoteCount === 0) {
      return [
        new EmptyTreeItem(
          this.getScope() === "favorites"
            ? "还没有收藏的远程分支"
            : "没有远程分支",
          "当前工作区中没有可展示的远程分支",
        ),
      ];
    }

    return groups.flatMap((repository) =>
      repository.remotes.map(
        (remote) =>
          new RemoteGroupTreeItem(
            remote,
            repository.repositoryRoot,
            groups.length > 1,
          ),
      ),
    );
  }

  getScope(): BranchScope {
    const value = this.state.get<unknown>(REMOTE_SCOPE_KEY);
    return isBranchScope(value) ? value : "all";
  }

  getLayout(): RemoteLayout {
    const value = this.state.get<unknown>(REMOTE_LAYOUT_KEY);
    return isRemoteLayout(value) ? value : "tree";
  }

  async setScope(scope: BranchScope): Promise<void> {
    await this.state.update(REMOTE_SCOPE_KEY, scope);
    this.refresh();
  }

  async setLayout(layout: RemoteLayout): Promise<void> {
    await this.state.update(REMOTE_LAYOUT_KEY, layout);
    this.refresh();
  }

  async setFavorite(branch: BranchRecord, favorite: boolean): Promise<void> {
    await this.setFavoriteByName(
      branch.repositoryRoot,
      branch.name,
      favorite,
    );
  }

  async setFavoriteByName(
    repositoryRoot: string,
    branchName: string,
    favorite: boolean,
  ): Promise<void> {
    const favoriteIds = this.getFavoriteIds();
    const id = createBranchId(repositoryRoot, branchName);
    if (favorite) {
      favoriteIds.add(id);
    } else {
      favoriteIds.delete(id);
    }
    await this.state.update(FAVORITES_KEY, [...favoriteIds]);
    this.refresh();
  }

  private async getBranches(): Promise<BranchRecord[]> {
    const favoriteIds = this.getFavoriteIds();
    const branches = (await loadBranches(listRemoteBranches)).map(
      (branch) => {
        const id = createBranchId(branch.repositoryRoot, branch.name);
        return {
          id,
          repositoryRoot: branch.repositoryRoot,
          name: branch.name,
          current: false,
          favorite: favoriteIds.has(id),
          lastCommitAt: branch.lastCommitAt,
          upstream: branch.upstream,
          syncState: branch.syncState,
          ahead: branch.ahead,
          behind: branch.behind,
        };
      },
    );
    return filterRemoteBranches(branches, this.getScope());
  }

  private async getGroups(): Promise<RemoteBranchGroup[]> {
    return groupRemoteBranches(await this.getBranches());
  }

  private getFavoriteIds(): Set<string> {
    const value = this.state.get<unknown>(FAVORITES_KEY, []);
    if (!Array.isArray(value)) {
      return new Set();
    }
    return new Set(value.filter((id): id is string => typeof id === "string"));
  }
}

export class BranchDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this.changeEmitter.event;

  dispose(): void {
    this.changeEmitter.dispose();
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== BRANCH_SCHEME) {
      return undefined;
    }

    const params = new URLSearchParams(uri.query);
    const current = params.get("current") === "true";
    const syncState = params.get("sync") as BranchRecord["syncState"] | null;
    const color = syncState ? getSyncColor(syncState) : undefined;
    const syncLabel = getSyncLabel(syncState ?? "none");

    return {
      badge: undefined,
      color,
      tooltip: [current ? "当前分支" : "", syncLabel]
        .filter(Boolean)
        .join(" · "),
      propagate: false,
    };
  }
}

export function createBranchIconSet(
  extensionUri: vscode.Uri,
): BranchIconSet {
  const icon = (name: string) =>
    vscode.Uri.joinPath(extensionUri, "resources", "icons", name);
  return {
    default: {
      light: icon("branch-light.svg"),
      dark: icon("branch-dark.svg"),
    },
    ahead: icon("branch-ahead.svg"),
    behind: icon("branch-behind.svg"),
    diverged: icon("branch-diverged.svg"),
    current: {
      light: icon("current-light.svg"),
      dark: icon("current-dark.svg"),
    },
    currentAhead: icon("current-ahead.svg"),
    currentBehind: icon("current-behind.svg"),
    currentDiverged: icon("current-diverged.svg"),
  };
}

function createBranchPathItems(
  nodes: BranchPathNode[],
  scope: "local" | "remote",
  icons: BranchIconSet,
): vscode.TreeItem[] {
  return nodes.map((node) => {
    if (node.kind === "folder") {
      return new BranchFolderTreeItem(node, scope);
    }
    return scope === "local"
      ? new LocalBranchTreeItem(
          node.record,
          icons,
          node.name,
        )
      : new RemoteBranchTreeItem(node.record, node.name, icons);
  });
}

function getBranchIcon(
  icons: BranchIconSet,
  syncState: BranchRecord["syncState"],
  current = false,
): BranchIconPath {
  if (current) {
    if (syncState === "ahead") {
      return icons.currentAhead;
    }
    if (syncState === "behind") {
      return icons.currentBehind;
    }
    if (syncState === "diverged") {
      return icons.currentDiverged;
    }
    return icons.current;
  }
  if (syncState === "ahead") {
    return icons.ahead;
  }
  if (syncState === "behind") {
    return icons.behind;
  }
  if (syncState === "diverged") {
    return icons.diverged;
  }
  return icons.default;
}

async function loadBranches(
  loader: (repositoryRoot: string) => Promise<GitBranch[]>,
): Promise<BranchWithRepository[]> {
  const directories =
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ??
    [];
  const repositories = await discoverRepositories(directories);
  const results = await Promise.all(
    repositories.map(async (repositoryRoot) => {
      try {
        const branches = await loader(repositoryRoot);
        return branches.map((branch) => ({ ...branch, repositoryRoot }));
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}

function toBranchRecord(branch: BranchWithRepository): BranchRecord {
  return {
    id: createBranchId(branch.repositoryRoot, branch.name),
    repositoryRoot: branch.repositoryRoot,
    name: branch.name,
    current: branch.current,
    favorite: false,
    lastCommitAt: branch.lastCommitAt,
    upstream: branch.upstream,
    syncState: branch.syncState,
    ahead: branch.ahead,
    behind: branch.behind,
  };
}

function compareBranches(left: BranchRecord, right: BranchRecord): number {
  if (left.current !== right.current) {
    return left.current ? -1 : 1;
  }
  if (left.repositoryRoot !== right.repositoryRoot) {
    return left.repositoryRoot.localeCompare(right.repositoryRoot);
  }
  return left.name.localeCompare(right.name);
}

function createBranchTooltip(branch: BranchRecord): string {
  return [
    `分支：${branch.name}`,
    branch.upstream ? `上游：${branch.upstream}` : "",
    formatSyncCounts(branch.ahead, branch.behind),
    `最后提交：${new Date(branch.lastCommitAt).toLocaleString()}`,
    getSyncLabel(branch.syncState),
    `仓库：${branch.repositoryRoot}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function createBranchDecorationUri(branch: BranchRecord): vscode.Uri {
  return vscode.Uri.from({
    scheme: BRANCH_SCHEME,
    path: `/${Buffer.from(branch.id).toString("base64url")}`,
    query: `current=${branch.current}&sync=${branch.syncState}&palette=muted-v3`,
  });
}

function getSyncColor(
  syncState: BranchRecord["syncState"],
): vscode.ThemeColor | undefined {
  if (syncState === "ahead") {
    return new vscode.ThemeColor(
      "gitToolkit.branchLocalAheadMutedForeground",
    );
  }
  if (syncState === "behind") {
    return new vscode.ThemeColor(
      "gitToolkit.branchRemoteAheadMutedForeground",
    );
  }
  if (syncState === "diverged") {
    return new vscode.ThemeColor(
      "gitToolkit.branchDivergedMutedForeground",
    );
  }
  return undefined;
}

function getSyncLabel(syncState: BranchRecord["syncState"]): string {
  if (syncState === "ahead") {
    return "本地有更新";
  }
  if (syncState === "behind") {
    return "远程有更新";
  }
  if (syncState === "diverged") {
    return "本地和远程都有更新";
  }
  if (syncState === "synced") {
    return "已同步";
  }
  return "";
}
