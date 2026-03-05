import * as vscode from 'vscode';
import { ShadowDirectory } from './ShadowDirectory';
import { generateTldr, serializeTldr } from './TldrWriter';
import type { CallGraph } from './types';

let shadowDir: ShadowDirectory | undefined;

function getShadowDir(): ShadowDirectory {
	if (!shadowDir) {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!workspaceRoot) {
			throw new Error('No workspace folder open');
		}
		shadowDir = new ShadowDirectory(workspaceRoot);
	}
	return shadowDir;
}

/**
 * Placeholder: extract call graph from source code.
 * Will be replaced by Tree-sitter + CallGraphExtractor in Phase 2.
 */
function extractCallGraph(
	fileName: string,
	content: string,
	languageId: string,
): CallGraph {
	// For now, generate a demo graph to prove the pipeline works
	const lines = content.split('\n');
	const functionPattern = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|(\w+)\s*\([^)]*\)\s*\{)/;

	const nodes: CallGraph['nodes'] = [];
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(functionPattern);
		if (match) {
			const name = match[1] || match[2] || match[3];
			if (name && !['if', 'for', 'while', 'switch', 'catch'].includes(name)) {
				nodes.push({
					id: `func-${name}`,
					name,
					type: 'function',
					line: i + 1,
				});
			}
		}
	}

	// Simple heuristic edges: look for function calls within the file
	const edges: CallGraph['edges'] = [];
	const nodeNames = new Set(nodes.map(n => n.name));
	for (const caller of nodes) {
		// Find the caller's body (rough: from its line to the next function)
		const callerIdx = nodes.indexOf(caller);
		const startLine = caller.line;
		const endLine = callerIdx < nodes.length - 1
			? nodes[callerIdx + 1].line - 1
			: lines.length;

		for (let i = startLine; i < endLine; i++) {
			for (const target of nodeNames) {
				if (target !== caller.name && lines[i]?.includes(`${target}(`)) {
					const edgeId = `${caller.id}->${target}`;
					if (!edges.find(e => e.from === caller.id && e.to === `func-${target}`)) {
						edges.push({ from: caller.id, to: `func-${target}` });
					}
				}
			}
		}
	}

	return { nodes, edges, fileName, language: languageId };
}

async function showDiagram() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('No active file to visualize.');
		return;
	}

	const document = editor.document;
	const content = document.getText();
	const fileName = vscode.workspace.asRelativePath(document.uri);
	const sd = getShadowDir();

	// Check cache
	if (await sd.isFresh(document.uri, content)) {
		const tldrUri = sd.getTldrUri(document.uri);
		await vscode.commands.executeCommand(
			'vscode.openWith',
			tldrUri,
			'tldraw.tldr',
			vscode.ViewColumn.Beside,
		);
		return;
	}

	// Extract call graph
	const graph = extractCallGraph(fileName, content, document.languageId);

	if (graph.nodes.length === 0) {
		vscode.window.showInformationMessage(
			`No functions found in ${fileName}. Diagram not generated.`,
		);
		return;
	}

	// Generate .tldr
	const tldr = generateTldr(graph, {
		sourceFile: fileName,
		sourceHash: sd.computeHash(content),
		type: 'file',
	});
	const tldrContent = serializeTldr(tldr);

	// Write to shadow directory
	const tldrUri = sd.getTldrUri(document.uri);
	await sd.writeTldr(tldrUri, tldrContent);

	// Open with tldraw extension
	try {
		await vscode.commands.executeCommand(
			'vscode.openWith',
			tldrUri,
			'tldraw.tldr',
			vscode.ViewColumn.Beside,
		);
	} catch {
		// Fallback: open as text if tldraw extension not installed
		await vscode.commands.executeCommand(
			'vscode.open',
			tldrUri,
			{ viewColumn: vscode.ViewColumn.Beside },
		);
		vscode.window.showWarningMessage(
			'Install the tldraw extension (tldraw-org.tldraw-vscode) for visual diagrams.',
		);
	}

	vscode.window.showInformationMessage(
		`Generated diagram: ${graph.nodes.length} functions, ${graph.edges.length} calls`,
	);
}

async function generateAll() {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!workspaceRoot) {
		vscode.window.showWarningMessage('No workspace folder open.');
		return;
	}

	const sd = getShadowDir();
	const supportedExtensions = [
		'**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx',
		'**/*.py', '**/*.go', '**/*.rs', '**/*.java',
	];

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Generating tldraw diagrams',
			cancellable: true,
		},
		async (progress, token) => {
			let generated = 0;
			let skipped = 0;

			for (const pattern of supportedExtensions) {
				if (token.isCancellationRequested) break;

				const files = await vscode.workspace.findFiles(
					pattern,
					'**/node_modules/**',
				);

				for (const fileUri of files) {
					if (token.isCancellationRequested) break;

					const doc = await vscode.workspace.openTextDocument(fileUri);
					const content = doc.getText();
					const fileName = vscode.workspace.asRelativePath(fileUri);

					// Check cache
					if (await sd.isFresh(fileUri, content)) {
						skipped++;
						continue;
					}

					const graph = extractCallGraph(fileName, content, doc.languageId);

					if (graph.nodes.length < 3) {
						skipped++;
						continue;
					}

					const tldr = generateTldr(graph, {
						sourceFile: fileName,
						sourceHash: sd.computeHash(content),
						type: 'file',
					});
					await sd.writeTldr(sd.getTldrUri(fileUri), serializeTldr(tldr));
					generated++;

					progress.report({
						message: `${generated} generated, ${skipped} skipped`,
					});
				}
			}

			vscode.window.showInformationMessage(
				`tldraw diagrams: ${generated} generated, ${skipped} skipped`,
			);
		},
	);
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('tldraw-viz.showDiagram', showDiagram),
		vscode.commands.registerCommand('tldraw-viz.generateAll', generateAll),
	);
}

export function deactivate() {
	shadowDir = undefined;
}
