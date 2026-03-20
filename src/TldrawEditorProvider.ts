import * as vscode from 'vscode';
import type { WebviewToExtension } from './messages';

const navLog = vscode.window.createOutputChannel('tldraw-viz-nav', { log: true });

/**
 * Navigate to a source file at a given line.
 * Accepts a findCurrentLine callback for fresh line resolution.
 */
async function navigateToSource(
	file: string,
	line: number,
	name: string,
	findCurrentLine: (root: vscode.Uri, file: string, name: string, fallback: number) => Promise<number>,
	startByte?: number,
	endByte?: number,
): Promise<void> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!workspaceRoot || !file) return;

	navLog.info(`navigateToSource: file="${file}", line=${line}, name="${name}"`);

	const freshLookup = vscode.workspace.getConfiguration('tldraw-viz')
		.get<boolean>('freshLineLookup', true);

	let resolvedLine = line;
	if (freshLookup && name) {
		resolvedLine = await findCurrentLine(workspaceRoot, file, name, line);
		navLog.info(`navigateToSource: findCurrentLine resolved ${line} → ${resolvedLine}`);
	} else {
		navLog.info(`navigateToSource: freshLookup=${freshLookup}, name="${name}" — skipping findCurrentLine`);
	}

	const fileUri = vscode.Uri.joinPath(workspaceRoot, file);

	try {
		const doc = await vscode.workspace.openTextDocument(fileUri);
		// Open beside the viewer so the tldraw panel stays visible
		const showOptions: vscode.TextDocumentShowOptions = {
			viewColumn: vscode.ViewColumn.Beside,
			preserveFocus: false,
		};

		// Prefer byte offsets from tree-sitter (exact) over line numbers
		if (startByte != null && endByte != null) {
			const startPos = doc.positionAt(startByte);
			const endPos = doc.positionAt(endByte);
			showOptions.selection = new vscode.Range(startPos, endPos);
		} else if (resolvedLine > 0) {
			const zeroBasedLine = resolvedLine - 1;
			showOptions.selection = new vscode.Range(zeroBasedLine, 0, zeroBasedLine, 0);
		}

		const editor = await vscode.window.showTextDocument(doc, showOptions);

		if (startByte != null && endByte != null) {
			const startPos = doc.positionAt(startByte);
			editor.revealRange(
				new vscode.Range(startPos, startPos),
				vscode.TextEditorRevealType.InCenter,
			);
		} else if (resolvedLine > 0) {
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
		console.log('[tldraw-viz] Registering custom editor provider for viewType:', TldrawEditorProvider.viewType);
		const disposable = vscode.window.registerCustomEditorProvider(
			TldrawEditorProvider.viewType,
			new TldrawEditorProvider(context, findCurrentLine),
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: true,
			},
		);
		console.log('[tldraw-viz] Custom editor provider registered successfully');
		return disposable;
	}

	async openCustomDocument(uri: vscode.Uri): Promise<TldrawDocument> {
		console.log('[tldraw-viz] openCustomDocument:', uri.toString());
		const raw = await vscode.workspace.fs.readFile(uri);
		const fileContents = Buffer.from(raw).toString('utf-8');
		console.log('[tldraw-viz] openCustomDocument: read', fileContents.length, 'bytes');
		return new TldrawDocument(uri, fileContents);
	}

	async resolveCustomEditor(
		document: TldrawDocument,
		webviewPanel: vscode.WebviewPanel,
	): Promise<void> {
		console.log('[tldraw-viz] resolveCustomEditor called for:', document.uri.toString());
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
			],
		};
		const html = this.getHtml(webviewPanel.webview, document.fileContents);
		console.log('[tldraw-viz] Setting webview HTML, length:', html.length);
		webviewPanel.webview.html = html;

		webviewPanel.webview.onDidReceiveMessage(
			async (msg: WebviewToExtension) => {
				if (msg.type === 'shapeClicked') {
					console.log('[tldraw-viz] shapeClicked received:', JSON.stringify(msg.data));
					await navigateToSource(
						msg.data.file,
						msg.data.line,
						msg.data.name,
						this.findCurrentLine,
						msg.data.startByte,
						msg.data.endByte,
					);
				}
			},
		);
	}

	private getHtml(webview: vscode.Webview, fileContents: string): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
		);
		const cssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'),
		);

		// Embed file data directly in HTML via base64 to avoid message-passing races
		const b64 = Buffer.from(fileContents, 'utf-8').toString('base64');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<link rel="stylesheet" href="${cssUri}" />
	<style>
		html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
		#root { position: absolute; top: 0; left: 0; right: 0; bottom: 0; overflow: hidden; }
		#debug { position: fixed; top: 0; left: 0; right: 0; z-index: 99999; background: #ffe0e0; color: #900; padding: 8px 12px; font: 12px monospace; white-space: pre-wrap; display: none; }
	</style>
</head>
<body>
	<div id="debug"></div>
	<div id="root">Initializing tldraw viewer...</div>
	<script id="tldraw-data" type="application/json">${b64}</script>
	<script>
		window.onerror = function(msg, src, line, col, err) {
			if (typeof msg === 'string' && msg.indexOf('ResizeObserver') !== -1) return true;
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
