import * as vscode from 'vscode';
import type { ExtensionToWebview, WebviewToExtension } from './messages';

/**
 * Navigate to a source file at a given line.
 * Accepts a findCurrentLine callback for fresh line resolution.
 */
async function navigateToSource(
	file: string,
	line: number,
	name: string,
	findCurrentLine: (root: vscode.Uri, file: string, name: string, fallback: number) => Promise<number>,
): Promise<void> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!workspaceRoot || !file || line === 0) return;

	const freshLookup = vscode.workspace.getConfiguration('tldraw-viz')
		.get<boolean>('freshLineLookup', true);

	let resolvedLine = line;
	if (freshLookup && name && line > 0) {
		resolvedLine = await findCurrentLine(workspaceRoot, file, name, line);
	}

	const zeroBasedLine = Math.max(0, resolvedLine - 1);
	const fileUri = vscode.Uri.joinPath(workspaceRoot, file);

	try {
		const doc = await vscode.workspace.openTextDocument(fileUri);
		const editor = await vscode.window.showTextDocument(doc, {
			viewColumn: vscode.ViewColumn.One,
			selection: new vscode.Range(zeroBasedLine, 0, zeroBasedLine, 0),
		});
		editor.revealRange(
			new vscode.Range(zeroBasedLine, 0, zeroBasedLine, 0),
			vscode.TextEditorRevealType.InCenter,
		);
	} catch {
		// Silently fail — file may have been deleted
	}
}

class TldrawDocument implements vscode.CustomDocument {
	constructor(
		public readonly uri: vscode.Uri,
		public readonly fileContents: string,
	) {}

	dispose(): void {}
}

export class TldrawEditorProvider implements vscode.CustomReadonlyEditorProvider<TldrawDocument> {
	private static readonly viewType = 'tldraw-viz.tldr';

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly findCurrentLine: (root: vscode.Uri, file: string, name: string, fallback: number) => Promise<number>,
	) {}

	static register(
		context: vscode.ExtensionContext,
		findCurrentLine: (root: vscode.Uri, file: string, name: string, fallback: number) => Promise<number>,
	): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			TldrawEditorProvider.viewType,
			new TldrawEditorProvider(context, findCurrentLine),
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: true,
			},
		);
	}

	async openCustomDocument(uri: vscode.Uri): Promise<TldrawDocument> {
		const raw = await vscode.workspace.fs.readFile(uri);
		const fileContents = Buffer.from(raw).toString('utf-8');
		return new TldrawDocument(uri, fileContents);
	}

	async resolveCustomEditor(
		document: TldrawDocument,
		webviewPanel: vscode.WebviewPanel,
	): Promise<void> {
		webviewPanel.webview.options = { enableScripts: true };
		webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

		webviewPanel.webview.onDidReceiveMessage(
			async (msg: WebviewToExtension) => {
				switch (msg.type) {
					case 'ready-to-receive-file': {
						const message: ExtensionToWebview = {
							type: 'opened-file',
							data: {
								fileContents: document.fileContents,
								uri: document.uri.toString(),
							},
						};
						webviewPanel.webview.postMessage(message);
						break;
					}
					case 'shapeClicked': {
						await navigateToSource(
							msg.data.file,
							msg.data.line,
							msg.data.name,
							this.findCurrentLine,
						);
						break;
					}
				}
			},
		);
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
		);
		const cssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'),
		);

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<link rel="stylesheet" href="${cssUri}" />
	<style>
		html, body, #root { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
	</style>
</head>
<body>
	<div id="root"></div>
	<script src="${scriptUri}"></script>
</body>
</html>`;
	}
}
