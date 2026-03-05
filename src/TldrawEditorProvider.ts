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
	if (!workspaceRoot || !file) return;

	const freshLookup = vscode.workspace.getConfiguration('tldraw-viz')
		.get<boolean>('freshLineLookup', true);

	let resolvedLine = line;
	if (freshLookup && name) {
		resolvedLine = await findCurrentLine(workspaceRoot, file, name, line);
	}

	const fileUri = vscode.Uri.joinPath(workspaceRoot, file);

	try {
		const doc = await vscode.workspace.openTextDocument(fileUri);
		// Open beside the viewer so the tldraw panel stays visible
		const showOptions: vscode.TextDocumentShowOptions = {
			viewColumn: vscode.ViewColumn.Beside,
			preserveFocus: false,
		};
		// Only set cursor position if we have a real line number
		if (resolvedLine > 0) {
			const zeroBasedLine = resolvedLine - 1;
			showOptions.selection = new vscode.Range(zeroBasedLine, 0, zeroBasedLine, 0);
		}
		const editor = await vscode.window.showTextDocument(doc, showOptions);
		if (resolvedLine > 0) {
			const zeroBasedLine = resolvedLine - 1;
			editor.revealRange(
				new vscode.Range(zeroBasedLine, 0, zeroBasedLine, 0),
				vscode.TextEditorRevealType.InCenter,
			);
		}
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
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
			],
		};
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
						console.log('[tldraw-viz] shapeClicked received:', JSON.stringify(msg.data));
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
		#debug { position: fixed; top: 0; left: 0; right: 0; z-index: 99999; background: #ffe0e0; color: #900; padding: 8px 12px; font: 12px monospace; white-space: pre-wrap; display: none; }
	</style>
</head>
<body>
	<div id="debug"></div>
	<div id="root">Initializing tldraw viewer...</div>
	<script>
		window.onerror = function(msg, src, line, col, err) {
			var d = document.getElementById('debug');
			d.style.display = 'block';
			d.textContent = 'JS Error: ' + msg + '\\nSource: ' + src + ':' + line + ':' + col + '\\n' + (err && err.stack || '');
		};
		window.addEventListener('unhandledrejection', function(e) {
			var d = document.getElementById('debug');
			d.style.display = 'block';
			d.textContent = 'Unhandled promise rejection: ' + (e.reason && e.reason.message || e.reason) + '\\n' + (e.reason && e.reason.stack || '');
		});
	</script>
	<script type="module" src="${scriptUri}"></script>
</body>
</html>`;
	}
}
