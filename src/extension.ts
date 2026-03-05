import * as vscode from 'vscode';
import { ShadowDirectory } from './ShadowDirectory';
import { initParser, parseSource, extractNodes } from './CodeAnalyzer';
import { extractEdges } from './CallGraphExtractor';
import { layoutCallGraph } from './DiagramGenerator';
import { generateTldr, serializeTldr } from './TldrWriter';
import { getLanguageConfig } from './languages';
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
 * Extract call graph from source code using Tree-sitter.
 */
async function extractCallGraph(
	fileName: string,
	content: string,
	languageId: string,
): Promise<CallGraph | undefined> {
	const config = getLanguageConfig(languageId);
	if (!config) return undefined;

	await initParser();
	const tree = await parseSource(content, config);
	const nodes = extractNodes(tree, config);
	const edges = extractEdges(tree, config, nodes);

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
	const graph = await extractCallGraph(fileName, content, document.languageId);

	if (!graph) {
		vscode.window.showWarningMessage(
			`Language "${document.languageId}" is not supported for diagram generation.`,
		);
		return;
	}

	if (graph.nodes.length === 0) {
		vscode.window.showInformationMessage(
			`No functions found in ${fileName}. Diagram not generated.`,
		);
		return;
	}

	// Layout with dagre
	const positioned = layoutCallGraph(graph);

	// Generate .tldr
	const tldr = generateTldr(graph, {
		sourceFile: fileName,
		sourceHash: sd.computeHash(content),
		type: 'file',
	}, positioned);
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

					const graph = await extractCallGraph(fileName, content, doc.languageId);

					if (!graph || graph.nodes.length < 3) {
						skipped++;
						continue;
					}

					const positioned = layoutCallGraph(graph);
					const tldr = generateTldr(graph, {
						sourceFile: fileName,
						sourceHash: sd.computeHash(content),
						type: 'file',
					}, positioned);
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
