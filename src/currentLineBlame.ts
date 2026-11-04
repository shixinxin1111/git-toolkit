import * as vscode from "vscode";
import {
  getLineBlame,
  GitFile,
  GitLineBlame,
  resolveGitFile,
} from "./git";

const CONFIGURATION_SECTION = "gitToolkit.currentLineBlame";
const UPDATE_DELAY = 120;

export class CurrentLineBlameController implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
      margin: "0 0 0 3em",
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly subscriptions: vscode.Disposable[] = [this.decoration];
  private readonly gitFiles = new Map<string, Promise<GitFile>>();
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private updateSequence = 0;

  constructor() {
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleUpdate()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.scheduleUpdate();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) {
          this.scheduleUpdate();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.gitFiles.delete(document.uri.toString());
        if (document === vscode.window.activeTextEditor?.document) {
          this.scheduleUpdate();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.gitFiles.delete(document.uri.toString());
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIGURATION_SECTION)) {
          this.scheduleUpdate();
        }
      }),
    );
    this.scheduleUpdate();
  }

  refresh(): void {
    this.scheduleUpdate();
  }

  dispose(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }
    this.updateSequence += 1;
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.gitFiles.clear();
  }

  private scheduleUpdate(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }
    const editor = vscode.window.activeTextEditor;
    editor?.setDecorations(this.decoration, []);
    const sequence = ++this.updateSequence;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      void this.update(editor, sequence);
    }, UPDATE_DELAY);
  }

  private async update(
    editor: vscode.TextEditor | undefined,
    sequence: number,
  ): Promise<void> {
    if (
      !editor ||
      editor !== vscode.window.activeTextEditor ||
      editor.document.uri.scheme !== "file" ||
      editor.document.isDirty ||
      !vscode.workspace
        .getConfiguration(CONFIGURATION_SECTION)
        .get("enabled", true)
    ) {
      return;
    }

    const line = editor.selection.active.line;
    try {
      const gitFile = await this.resolveGitFile(editor.document);
      const blame = await getLineBlame(
        gitFile.repositoryRoot,
        gitFile.relativePath,
        line + 1,
      );
      if (
        sequence !== this.updateSequence ||
        editor !== vscode.window.activeTextEditor ||
        line !== editor.selection.active.line ||
        !blame
      ) {
        return;
      }

      const end = editor.document.lineAt(line).range.end;
      editor.setDecorations(this.decoration, [
        {
          range: new vscode.Range(end, end),
          hoverMessage: createHoverMessage(blame),
          renderOptions: {
            after: {
              contentText: createInlineText(blame),
            },
          },
        },
      ]);
    } catch {
      // Non-Git and untracked files intentionally have no decoration.
    }
  }

  private resolveGitFile(document: vscode.TextDocument): Promise<GitFile> {
    const key = document.uri.toString();
    let result = this.gitFiles.get(key);
    if (!result) {
      result = resolveGitFile(document.uri.fsPath);
      this.gitFiles.set(key, result);
      void result.catch(() => this.gitFiles.delete(key));
    }
    return result;
  }
}

function createInlineText(blame: GitLineBlame): string {
  const subject =
    blame.subject.length > 80
      ? `${blame.subject.slice(0, 79)}…`
      : blame.subject;
  return `${blame.author}, ${formatRelativeTime(blame.committedAt)} • ${subject}`;
}

function createHoverMessage(blame: GitLineBlame): vscode.MarkdownString {
  const message = new vscode.MarkdownString();
  message.appendMarkdown("**");
  message.appendText(blame.author);
  message.appendMarkdown("**  \n");
  message.appendText(blame.subject);
  message.appendMarkdown("  \n\n");
  message.appendMarkdown(`\`${blame.shortHash}\` · `);
  message.appendText(formatDateTime(blame.committedAt));
  return message;
}

function formatRelativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (elapsed < minute) {
    return "刚刚";
  }
  if (elapsed < hour) {
    return `${Math.floor(elapsed / minute)}分钟前`;
  }
  if (elapsed < day) {
    return `${Math.floor(elapsed / hour)}小时前`;
  }
  if (elapsed < 30 * day) {
    return `${Math.floor(elapsed / day)}天前`;
  }
  if (elapsed < 365 * day) {
    return `${Math.floor(elapsed / (30 * day))}个月前`;
  }
  return `${Math.floor(elapsed / (365 * day))}年前`;
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
