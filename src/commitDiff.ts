import * as vscode from "vscode";
import { readGitBlob } from "./git";

export const COMMIT_CONTENT_SCHEME = "git-toolkit-commit";

export class CommitContentProvider
  implements vscode.TextDocumentContentProvider
{
  provideTextDocumentContent(uri: vscode.Uri): vscode.ProviderResult<string> {
    const params = new URLSearchParams(uri.query);
    const repositoryRoot = params.get("repository");
    const blob = params.get("blob");
    if (!blob) {
      return "";
    }
    if (!repositoryRoot || !/^[0-9a-f]{40,64}$/.test(blob)) {
      throw new Error("提交文件地址无效。");
    }
    return readGitBlob(repositoryRoot, blob);
  }
}

export function createCommitContentUri(
  repositoryRoot: string,
  relativePath: string,
  blob: string | undefined,
): vscode.Uri {
  const params = new URLSearchParams({ repository: repositoryRoot });
  if (blob) {
    params.set("blob", blob);
  }
  return vscode.Uri.from({
    scheme: COMMIT_CONTENT_SCHEME,
    path: `/${relativePath}`,
    query: params.toString(),
  });
}
