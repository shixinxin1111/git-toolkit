import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import { createSwimlaneInfo } from "./branches";
import {
  checkoutLocalBranch,
  checkoutRemoteBranch,
  createLocalBranch,
  deleteLocalBranch,
  deleteRemoteBranch,
  discoverRepositories,
  fetchRemote,
  forcePushLocalBranch,
  mergeBranchIntoCurrent,
  pullLocalBranch,
  pushLocalBranch,
  rebaseCurrentBranchOnto,
  renameLocalBranch,
  resetCurrentBranchToCommit,
  resolveGitFile,
  setSkipWorktree,
  updateAllLocalBranches,
} from "./git";
import {
  BranchDecorationProvider,
  CommitTreeItem,
  createBranchIconSet,
  IgnoreTreeItem,
  IgnoreTreeProvider,
  LocalBranchTreeItem,
  LocalBranchTreeProvider,
  RemoteBranchTreeItem,
  RemoteBranchTreeProvider,
  RemoteGroupTreeItem,
} from "./treeViews";

const IGNORE_VIEW_ID = "gitToolkit.ignoreView";
const LOCAL_BRANCHES_VIEW_ID = "gitToolkit.localBranchesView";
const REMOTE_BRANCHES_VIEW_ID = "gitToolkit.remoteBranchesView";

export function activate(context: vscode.ExtensionContext): void {
  let ignoreTreeView: vscode.TreeView<vscode.TreeItem> | undefined;
  let localBranchTreeView: vscode.TreeView<vscode.TreeItem> | undefined;
  let remoteBranchTreeView: vscode.TreeView<vscode.TreeItem> | undefined;
  const branchIcons = createBranchIconSet(context.extensionUri);
  const branchDecorationProvider = new BranchDecorationProvider();

  const ignoreProvider = new IgnoreTreeProvider(
    context.workspaceState,
    (count) => {
      if (ignoreTreeView) {
        ignoreTreeView.title = formatViewTitle("本地忽略", count);
      }
    },
  );
  const localBranchProvider = new LocalBranchTreeProvider(
    context.workspaceState,
    branchIcons,
    (count) => {
      if (localBranchTreeView) {
        localBranchTreeView.title = formatViewTitle("分支", count);
      }
    },
  );
  const remoteBranchProvider = new RemoteBranchTreeProvider(
    context.workspaceState,
    branchIcons,
    (count) => {
      if (remoteBranchTreeView) {
        remoteBranchTreeView.title = formatViewTitle("远程", count);
      }
    },
  );

  ignoreTreeView = vscode.window.createTreeView(IGNORE_VIEW_ID, {
    treeDataProvider: ignoreProvider,
    showCollapseAll: false,
  });
  localBranchTreeView = vscode.window.createTreeView(
    LOCAL_BRANCHES_VIEW_ID,
    {
      treeDataProvider: localBranchProvider,
      showCollapseAll: false,
    },
  );
  remoteBranchTreeView = vscode.window.createTreeView(
    REMOTE_BRANCHES_VIEW_ID,
    {
      treeDataProvider: remoteBranchProvider,
      showCollapseAll: false,
    },
  );

  ignoreTreeView.title = formatViewTitle(
    "本地忽略",
    ignoreProvider.getRecords().length,
  );
  void localBranchProvider.updateCount();
  void remoteBranchProvider.updateCount();
  void setRemoteScopeContext(remoteBranchProvider.getScope());
  void setLocalLayoutContext(localBranchProvider.getLayout());
  void setRemoteLayoutContext(remoteBranchProvider.getLayout());

  context.subscriptions.push(
    ignoreProvider,
    localBranchProvider,
    remoteBranchProvider,
    branchDecorationProvider,
    ignoreTreeView,
    localBranchTreeView,
    remoteBranchTreeView,
    vscode.window.registerFileDecorationProvider(
      branchDecorationProvider,
    ),
    vscode.window.onDidChangeActiveColorTheme(() => {
      branchDecorationProvider.refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      localBranchProvider.refresh();
      remoteBranchProvider.refresh();
    }),
    vscode.commands.registerCommand(
      "gitToolkit.ignoreFile",
      async (
        resource?: vscode.Uri | vscode.SourceControlResourceState,
      ) => {
        const target =
          getResourceUri(resource) ??
          vscode.window.activeTextEditor?.document.uri;
        if (!target || target.scheme !== "file") {
          vscode.window.showWarningMessage("请先选择一个本地文件。");
          return;
        }

        try {
          const stat = await fs.stat(target.fsPath);
          if (!stat.isFile()) {
            vscode.window.showWarningMessage("当前仅支持忽略文件。");
            return;
          }

          const gitFile = await resolveGitFile(target.fsPath);
          const existing = ignoreProvider
            .getRecords()
            .find(
              (record) =>
                record.repositoryRoot === gitFile.repositoryRoot &&
                record.relativePath === gitFile.relativePath,
            );

          await setSkipWorktree(
            gitFile.repositoryRoot,
            gitFile.relativePath,
            true,
          );
          await ignoreProvider.addOrEnable(
            gitFile.repositoryRoot,
            gitFile.relativePath,
          );

          if (existing?.active) {
            vscode.window.setStatusBarMessage(
              "该文件已处于本地忽略状态。",
              1500,
            );
          }
        } catch (error) {
          showGitError("无法忽略该文件", error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.showIgnoreRecords",
      async () => {
        await vscode.commands.executeCommand("workbench.view.scm");
        await vscode.commands.executeCommand(`${IGNORE_VIEW_ID}.focus`);
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.disableIgnore",
      async (item?: IgnoreTreeItem) => {
        const record = item?.record;
        if (!record?.active || !ignoreProvider.findRecord(record.id)) {
          return;
        }
        try {
          await setSkipWorktree(
            record.repositoryRoot,
            record.relativePath,
            false,
          );
          await ignoreProvider.disable(record.id);
        } catch (error) {
          showGitError("无法取消忽略", error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.enableIgnore",
      async (item?: IgnoreTreeItem) => {
        const record = item?.record;
        if (
          record?.active !== false ||
          !ignoreProvider.findRecord(record.id)
        ) {
          return;
        }
        try {
          await setSkipWorktree(
            record.repositoryRoot,
            record.relativePath,
            true,
          );
          await ignoreProvider.addOrEnable(
            record.repositoryRoot,
            record.relativePath,
          );
        } catch (error) {
          showGitError("无法重新添加忽略", error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.deleteIgnore",
      async (item?: IgnoreTreeItem) => {
        const record = item?.record;
        if (!record || !ignoreProvider.findRecord(record.id)) {
          return;
        }
        try {
          await setSkipWorktree(
            record.repositoryRoot,
            record.relativePath,
            false,
          );
          await ignoreProvider.remove(record.id);
        } catch (error) {
          showGitError("无法删除记录", error);
        }
      },
    ),
    vscode.commands.registerCommand("gitToolkit.refreshIgnore", () => {
      ignoreProvider.refresh();
    }),
    vscode.commands.registerCommand(
      "gitToolkit.refreshLocalBranches",
      () => {
        localBranchProvider.refresh();
      },
    ),
    vscode.commands.registerCommand("gitToolkit.showLocalList", async () => {
      await localBranchProvider.setLayout("list");
      await setLocalLayoutContext("list");
    }),
    vscode.commands.registerCommand("gitToolkit.showLocalTree", async () => {
      await localBranchProvider.setLayout("tree");
      await setLocalLayoutContext("tree");
    }),
    vscode.commands.registerCommand(
      "gitToolkit.updateAllLocalBranches",
      async () => {
        const repositories = await getWorkspaceRepositories();
        const summary = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: "正在更新所有本地分支",
          },
          async () => {
            const total = { updated: 0, skipped: 0, failed: 0 };
            for (const repository of repositories) {
              try {
                const result = await updateAllLocalBranches(repository);
                total.updated += result.updated;
                total.skipped += result.skipped;
                total.failed += result.failed;
              } catch {
                total.failed += 1;
              }
            }
            return total;
          },
        );
        localBranchProvider.refresh();
        remoteBranchProvider.refresh();
        const message = `本地分支更新完成：更新 ${summary.updated} 个，跳过 ${summary.skipped} 个，失败 ${summary.failed} 个。`;
        if (summary.failed > 0) {
          vscode.window.showWarningMessage(message);
        } else {
          vscode.window.setStatusBarMessage(message, 3000);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.refreshRemoteBranches",
      () => {
        remoteBranchProvider.refresh();
      },
    ),
    vscode.commands.registerCommand("gitToolkit.showRemoteList", async () => {
      await remoteBranchProvider.setLayout("list");
      await setRemoteLayoutContext("list");
    }),
    vscode.commands.registerCommand("gitToolkit.showRemoteTree", async () => {
      await remoteBranchProvider.setLayout("tree");
      await setRemoteLayoutContext("tree");
    }),
    vscode.commands.registerCommand(
      "gitToolkit.showFavoriteRemoteBranches",
      async () => {
        await remoteBranchProvider.setScope("favorites");
        await setRemoteScopeContext("favorites");
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.showAllRemoteBranches",
      async () => {
        await remoteBranchProvider.setScope("all");
        await setRemoteScopeContext("all");
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.favoriteRemoteBranch",
      async (item?: RemoteBranchTreeItem) => {
        if (!item?.branch || item.branch.favorite) {
          return;
        }
        await remoteBranchProvider.setFavorite(item.branch, true);
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.unfavoriteRemoteBranch",
      async (item?: RemoteBranchTreeItem) => {
        if (!item?.branch?.favorite) {
          return;
        }
        await remoteBranchProvider.setFavorite(item.branch, false);
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.checkoutRemoteBranch",
      async (item?: RemoteBranchTreeItem) => {
        const branch = item?.branch;
        if (!branch) {
          return;
        }
        try {
          await checkoutRemoteBranch(
            branch.repositoryRoot,
            branch.name,
          );
          localBranchProvider.refresh();
          remoteBranchProvider.refresh();
        } catch (error) {
          showGitError("无法检出远程分支", error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.fetchRemote",
      async (item?: RemoteGroupTreeItem) => {
        if (!item) {
          return;
        }
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Window,
              title: `正在获取远程 ${item.group.name}`,
            },
            () => fetchRemote(item.repositoryRoot, item.group.name),
          );
          localBranchProvider.refresh();
          remoteBranchProvider.refresh();
        } catch (error) {
          showGitError(`无法获取远程“${item.group.name}”`, error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.pullLocalBranch",
      async (item?: LocalBranchTreeItem) => {
        const branch = item?.branch;
        if (!branch) {
          return;
        }
        try {
          const result = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Window,
              title: `正在拉取分支 ${branch.name}`,
            },
            () =>
              pullLocalBranch(
                branch.repositoryRoot,
                branch.name,
                branch.upstream,
              ),
          );
          localBranchProvider.refresh();
          remoteBranchProvider.refresh();
          if (result === "unchanged") {
            vscode.window.setStatusBarMessage(
              `分支“${branch.name}”已经是最新状态。`,
              2000,
            );
          }
        } catch (error) {
          showGitError(`无法拉取分支“${branch.name}”`, error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.pushLocalBranch",
      async (item?: LocalBranchTreeItem) => {
        const branch = item?.branch;
        if (!branch) {
          return;
        }
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Window,
              title: `正在推送分支 ${branch.name}`,
            },
            () =>
              pushLocalBranch(
                branch.repositoryRoot,
                branch.name,
                branch.upstream,
              ),
          );
          localBranchProvider.refresh();
          remoteBranchProvider.refresh();
        } catch (error) {
          showGitError(`无法推送分支“${branch.name}”`, error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.forcePushLocalBranch",
      async (item?: LocalBranchTreeItem) => {
        const branch = item?.branch;
        if (!branch) {
          return;
        }
        const confirmed = await vscode.window.showWarningMessage(
          `强制推送分支“${branch.name}”可能覆盖远端提交。`,
          { modal: true },
          "强制推送",
        );
        if (confirmed !== "强制推送") {
          return;
        }
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Window,
              title: `正在强制推送 ${branch.name}`,
            },
            () =>
              forcePushLocalBranch(
                branch.repositoryRoot,
                branch.name,
                branch.upstream,
              ),
          );
          localBranchProvider.refresh();
          remoteBranchProvider.refresh();
          vscode.window.setStatusBarMessage(
            `分支“${branch.name}”已强制推送。`,
            2000,
          );
        } catch (error) {
          showGitError(`无法强制推送“${branch.name}”`, error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.favoriteUpstreamBranch",
      async (item?: LocalBranchTreeItem) => {
        const branch = item?.branch;
        if (!branch?.upstream) {
          return;
        }
        await remoteBranchProvider.setFavoriteByName(
          branch.repositoryRoot,
          branch.upstream,
          true,
        );
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.copyLocalBranchName",
      async (item?: LocalBranchTreeItem) => {
        const branchName = item?.branch.name;
        if (!branchName) {
          return;
        }
        await vscode.env.clipboard.writeText(branchName);
        vscode.window.setStatusBarMessage("已复制分支名。", 1500);
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.copySwimlaneInfo",
      async (item?: LocalBranchTreeItem) => {
        const branchName = item?.branch.name;
        if (!branchName) {
          return;
        }
        await vscode.env.clipboard.writeText(
          createSwimlaneInfo(branchName),
        );
        vscode.window.setStatusBarMessage("已复制泳道信息。", 1500);
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.checkoutLocalBranch",
      async (item?: LocalBranchTreeItem) => {
        const branch = item?.branch;
        if (!branch) {
          return;
        }
        try {
          await checkoutLocalBranch(
            branch.repositoryRoot,
            branch.name,
          );
          localBranchProvider.refresh();
        } catch (error) {
          showGitError(`无法检出分支“${branch.name}”`, error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.createLocalBranch",
      async (item?: LocalBranchTreeItem) => {
        const sourceBranch = item?.branch;
        if (!sourceBranch) {
          return;
        }
        const branchName = await vscode.window.showInputBox({
          title: `基于“${sourceBranch.name}”创建分支`,
          prompt: "输入新分支名",
          placeHolder: "例如：feature/new-feature",
          validateInput: (value) =>
            value.trim() ? undefined : "分支名不能为空",
        });
        if (!branchName) {
          return;
        }
        try {
          await createLocalBranch(
            sourceBranch.repositoryRoot,
            sourceBranch.name,
            branchName.trim(),
          );
          localBranchProvider.refresh();
          vscode.window.setStatusBarMessage(
            `已创建并检出分支“${branchName.trim()}”。`,
            2000,
          );
        } catch (error) {
          showGitError(`无法创建分支“${branchName.trim()}”`, error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.mergeLocalBranchIntoCurrent",
      async (item?: LocalBranchTreeItem) => {
        const branch = item?.branch;
        if (!branch) {
          return;
        }
        try {
          await mergeBranchIntoCurrent(
            branch.repositoryRoot,
            branch.name,
          );
          localBranchProvider.refresh();
          vscode.window.setStatusBarMessage(
            `已合并分支“${branch.name}”。`,
            2000,
          );
        } catch (error) {
          showGitError(`无法合并分支“${branch.name}”`, error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.rebaseCurrentOntoLocalBranch",
      async (item?: LocalBranchTreeItem) => {
        const branch = item?.branch;
        if (!branch) {
          return;
        }
        try {
          await rebaseCurrentBranchOnto(
            branch.repositoryRoot,
            branch.name,
          );
          localBranchProvider.refresh();
          vscode.window.setStatusBarMessage(
            `已变基到分支“${branch.name}”。`,
            2000,
          );
        } catch (error) {
          showGitError(`无法变基到分支“${branch.name}”`, error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.rebaseCurrentOntoRemoteBranch",
      async (item?: RemoteBranchTreeItem) => {
        const branch = item?.branch;
        if (!branch) {
          return;
        }
        try {
          await rebaseCurrentBranchOnto(
            branch.repositoryRoot,
            branch.name,
          );
          localBranchProvider.refresh();
          remoteBranchProvider.refresh();
          vscode.window.setStatusBarMessage(
            `已变基到分支“${branch.name}”。`,
            2000,
          );
        } catch (error) {
          showGitError(`无法变基到分支“${branch.name}”`, error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.resetToCommit",
      async (item?: CommitTreeItem) => {
        if (!item?.commit) {
          return;
        }
        try {
          await resetCurrentBranchToCommit(
            item.repositoryRoot,
            item.commit.hash,
          );
          localBranchProvider.refresh();
          remoteBranchProvider.refresh();
          vscode.window.setStatusBarMessage(
            `已重置到提交 ${item.commit.shortHash}（Mixed）。`,
            2000,
          );
        } catch (error) {
          showGitError(
            `无法重置到提交 ${item.commit.shortHash}`,
            error,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.renameLocalBranch",
      async (item?: LocalBranchTreeItem) => {
        const branch = item?.branch;
        if (!branch) {
          return;
        }
        const nextName = await vscode.window.showInputBox({
          title: "重命名分支",
          prompt: "输入新分支名",
          value: branch.name,
          validateInput: (value) =>
            value.trim() ? undefined : "分支名不能为空",
        });
        if (!nextName || nextName === branch.name) {
          return;
        }
        try {
          await renameLocalBranch(
            branch.repositoryRoot,
            branch.name,
            nextName.trim(),
          );
          localBranchProvider.refresh();
        } catch (error) {
          showGitError(`无法重命名分支“${branch.name}”`, error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.deleteLocalBranch",
      async (item?: LocalBranchTreeItem) => {
        const branch = item?.branch;
        if (!branch) {
          return;
        }
        try {
          await deleteLocalBranch(
            branch.repositoryRoot,
            branch.name,
            false,
          );
          localBranchProvider.refresh();
        } catch (error) {
          showGitError(`无法删除分支“${branch.name}”`, error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.forceDeleteLocalBranch",
      async (item?: LocalBranchTreeItem) => {
        const branch = item?.branch;
        if (!branch) {
          return;
        }
        const confirmed = await vscode.window.showWarningMessage(
          `强制删除本地分支“${branch.name}”将丢失其中未合并的提交。`,
          { modal: true },
          "强制删除",
        );
        if (confirmed !== "强制删除") {
          return;
        }
        try {
          await deleteLocalBranch(
            branch.repositoryRoot,
            branch.name,
            true,
          );
          localBranchProvider.refresh();
        } catch (error) {
          showGitError(`无法强制删除分支“${branch.name}”`, error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.deleteRemoteBranch",
      async (item?: RemoteBranchTreeItem) => {
        const branch = item?.branch;
        if (!branch) {
          return;
        }
        const confirmed = await vscode.window.showWarningMessage(
          `确定从远程删除分支“${branch.name}”吗？此操作会影响其他协作者。`,
          { modal: true },
          "删除远程分支",
        );
        if (confirmed !== "删除远程分支") {
          return;
        }
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Window,
              title: `正在删除 ${branch.name}`,
            },
            () =>
              deleteRemoteBranch(
                branch.repositoryRoot,
                branch.name,
              ),
          );
          remoteBranchProvider.refresh();
          localBranchProvider.refresh();
        } catch (error) {
          showGitError(`无法删除远程分支“${branch.name}”`, error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.loadMoreLocalCommits",
      (item?: LocalBranchTreeItem) => {
        if (item) {
          localBranchProvider.loadMore(item);
        }
      },
    ),
    vscode.commands.registerCommand(
      "gitToolkit.loadMoreRemoteCommits",
      (item?: RemoteBranchTreeItem) => {
        if (item) {
          remoteBranchProvider.loadMore(item);
        }
      },
    ),
  );

  queueMicrotask(() => {
    branchDecorationProvider.refresh();
  });
  void registerGitAutoRefresh(context, () => {
    localBranchProvider.refresh();
    remoteBranchProvider.refresh();
    branchDecorationProvider.refresh();
  });
}

async function setRemoteScopeContext(scope: "all" | "favorites"): Promise<void> {
  await vscode.commands.executeCommand(
    "setContext",
    "gitToolkit.remoteScope",
    scope,
  );
}

async function setRemoteLayoutContext(layout: "tree" | "list"): Promise<void> {
  await vscode.commands.executeCommand(
    "setContext",
    "gitToolkit.remoteLayout",
    layout,
  );
}

async function setLocalLayoutContext(layout: "tree" | "list"): Promise<void> {
  await vscode.commands.executeCommand(
    "setContext",
    "gitToolkit.localLayout",
    layout,
  );
}

function formatViewTitle(title: string, count: number): string {
  return `${title} · ${count}`;
}

async function getWorkspaceRepositories(): Promise<string[]> {
  const directories =
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ??
    [];
  return discoverRepositories(directories);
}

function getResourceUri(
  resource?: vscode.Uri | vscode.SourceControlResourceState,
): vscode.Uri | undefined {
  if (!resource) {
    return undefined;
  }
  return "resourceUri" in resource ? resource.resourceUri : resource;
}

type GitRepository = {
  rootUri: vscode.Uri;
  state: {
    onDidChange: vscode.Event<void>;
  };
};

type GitApi = {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
};

type GitExtensionExports = {
  getAPI(version: 1): GitApi;
};

async function registerGitAutoRefresh(
  context: vscode.ExtensionContext,
  refresh: () => void,
): Promise<void> {
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refresh();
    }, 250);
  };
  const repositorySubscriptions = new Map<string, vscode.Disposable>();
  const attachRepository = (repository: GitRepository) => {
    const key = repository.rootUri.toString();
    if (repositorySubscriptions.has(key)) {
      return;
    }
    repositorySubscriptions.set(
      key,
      repository.state.onDidChange(scheduleRefresh),
    );
  };
  const detachRepository = (repository: GitRepository) => {
    const key = repository.rootUri.toString();
    repositorySubscriptions.get(key)?.dispose();
    repositorySubscriptions.delete(key);
  };

  try {
    const extension =
      vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
    if (!extension) {
      registerGitFileWatchers(context, scheduleRefresh);
      return;
    }

    const exports = extension.isActive
      ? extension.exports
      : await extension.activate();
    const api = exports.getAPI(1);
    api.repositories.forEach(attachRepository);
    context.subscriptions.push(
      api.onDidOpenRepository(attachRepository),
      api.onDidCloseRepository(detachRepository),
    );
  } catch {
    registerGitFileWatchers(context, scheduleRefresh);
  }

  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      for (const disposable of repositorySubscriptions.values()) {
        disposable.dispose();
      }
      repositorySubscriptions.clear();
    }),
  );
}

function registerGitFileWatchers(
  context: vscode.ExtensionContext,
  refresh: () => void,
): void {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        folder,
        ".git/{HEAD,index,packed-refs,refs/**}",
      ),
    );
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate(refresh),
      watcher.onDidChange(refresh),
      watcher.onDidDelete(refresh),
    );
  }
}

function showGitError(prefix: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  let message = detail;

  if (detail.includes("not a git repository")) {
    message = "该文件不在 Git 仓库中。";
  } else if (detail.includes("pathspec") || detail.includes("did not match")) {
    message = "该文件尚未被 Git 跟踪，无法使用本地忽略。";
  }

  vscode.window.showErrorMessage(`${prefix}：${message}`);
}

export function deactivate(): void {}
