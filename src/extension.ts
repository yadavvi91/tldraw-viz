import * as vscode from 'vscode';
import path from 'path';
import { ShadowDirectory } from './ShadowDirectory';
import { initParser, parseSource, extractNodes } from './CodeAnalyzer';
import { extractEdges } from './CallGraphExtractor';
import { layoutCallGraph } from './DiagramGenerator';
import { generateTldr, serializeTldr } from './TldrWriter';
import { DEFAULT_CONFIG, parseConfig, shouldSkipFile, hasEnoughSubstance, type TldrawConfig } from './GranularityFilter';
import { traceFlow, type FileReader } from './FlowTracer';
import { analyze } from './SemanticAnalyzer';
import { getLanguageConfig } from './languages';
import { parseMermaid } from './MermaidParser';
import { mermaidToCallGraph } from './MermaidConverter';
import { generateOverviewPrompt, generateDetailPrompt, generateProjectPrompt } from './StructuralSummary';
import { ClaudeService, estimateCost } from './ClaudeService';
import { buildProjectGraph } from './ProjectAnalyzer';
import { scanDocumentation } from './DocumentationScanner';
import type { CallGraph } from './types';
import type Parser from 'web-tree-sitter';

let shadowDir: ShadowDirectory | undefined;
let claudeService: ClaudeService | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

async function loadTldrawConfig(workspaceRoot: vscode.Uri): Promise<TldrawConfig> {
	const configUri = vscode.Uri.joinPath(workspaceRoot, '.tldraw', 'tldraw.config.json');
	try {
		const raw = await vscode.workspace.fs.readFile(configUri);
		const parsed = JSON.parse(Buffer.from(raw).toString('utf-8'));
		return parseConfig(parsed);
	} catch {
		const vsConfig = vscode.workspace.getConfiguration('tldraw-viz');
		return {
			skip: vsConfig.get<string[]>('skipPatterns', DEFAULT_CONFIG.skip),
			minFunctions: vsConfig.get<number>('minFunctions', DEFAULT_CONFIG.minFunctions),
			flows: DEFAULT_CONFIG.flows,
		};
	}
}

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
 * Returns both the call graph and the parsed AST tree (for semantic analysis).
 */
async function extractCallGraph(
	fileName: string,
	content: string,
	languageId: string,
): Promise<{ graph: CallGraph; tree: Parser.Tree } | undefined> {
	const config = getLanguageConfig(languageId);
	if (!config) return undefined;

	await initParser();
	const tree = await parseSource(content, config);
	const nodes = extractNodes(tree, config);
	const edges = extractEdges(tree, config, nodes);

	const graph: CallGraph = { nodes, edges, fileName, language: languageId };

	// Run semantic analysis to enrich nodes with roles, shapes, colors, groups
	analyze(graph, tree, config);

	return { graph, tree };
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

	// Extract call graph with semantic analysis
	const result = await extractCallGraph(fileName, content, document.languageId);

	if (!result) {
		vscode.window.showWarningMessage(
			`Language "${document.languageId}" is not supported for diagram generation.`,
		);
		return;
	}

	const { graph } = result;

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
	const config = await loadTldrawConfig(workspaceRoot);
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

					const fileName = vscode.workspace.asRelativePath(fileUri);

					// Check skip patterns
					if (shouldSkipFile(fileName, config)) {
						skipped++;
						continue;
					}

					const doc = await vscode.workspace.openTextDocument(fileUri);
					const content = doc.getText();

					// Check cache
					if (await sd.isFresh(fileUri, content)) {
						skipped++;
						continue;
					}

					const result = await extractCallGraph(fileName, content, doc.languageId);

					if (!result || !hasEnoughSubstance(result.graph.nodes.length, result.graph.edges.length, config)) {
						skipped++;
						continue;
					}

					const positioned = layoutCallGraph(result.graph);
					const tldr = generateTldr(result.graph, {
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

			// Also generate flow diagrams from config
			if (config.flows.length > 0 && !token.isCancellationRequested) {
				progress.report({ message: 'Generating flow diagrams...' });
				const fileReader = createVscodeFileReader(workspaceRoot);

				for (const flowConfig of config.flows) {
					if (token.isCancellationRequested) break;

					const colonIdx = flowConfig.entrypoint.lastIndexOf(':');
					if (colonIdx === -1) continue;

					const filePath = flowConfig.entrypoint.slice(0, colonIdx);
					const funcName = flowConfig.entrypoint.slice(colonIdx + 1);
					const absolutePath = path.join(workspaceRoot.fsPath, filePath);

					try {
						const flow = await traceFlow(absolutePath, funcName, flowConfig.name, fileReader);
						if (flow.nodes.length === 0) continue;

						const callGraph: CallGraph = {
							nodes: flow.nodes.map(n => ({
								...n,
								name: `${n.name} [${path.basename(n.sourceFile)}]`,
							})),
							edges: flow.edges,
							fileName: flowConfig.name,
							language: 'flow',
						};

						const positioned = layoutCallGraph(callGraph);
						const tldr = generateTldr(callGraph, {
							sourceFile: flowConfig.entrypoint,
							type: 'flow',
						}, positioned);

						await sd.writeTldr(sd.getFlowUri(flowConfig.name), serializeTldr(tldr));
						generated++;
					} catch {
						// Skip flows that fail
					}
				}
			}

			vscode.window.showInformationMessage(
				`tldraw diagrams: ${generated} generated, ${skipped} skipped`,
			);
		},
	);
}

/** Create a FileReader that uses the VS Code workspace filesystem */
function createVscodeFileReader(workspaceRoot: vscode.Uri): FileReader {
	return {
		async readFile(absolutePath: string): Promise<string> {
			const uri = vscode.Uri.file(absolutePath);
			const data = await vscode.workspace.fs.readFile(uri);
			return Buffer.from(data).toString('utf-8');
		},
		async listFiles(): Promise<string[]> {
			const patterns = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.py', '**/*.go', '**/*.rs', '**/*.java'];
			const files: string[] = [];
			for (const pattern of patterns) {
				const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
				for (const uri of uris) {
					files.push(uri.fsPath);
				}
			}
			return files;
		},
	};
}

async function generateFlows() {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!workspaceRoot) {
		vscode.window.showWarningMessage('No workspace folder open.');
		return;
	}

	const sd = getShadowDir();
	const config = await loadTldrawConfig(workspaceRoot);

	if (config.flows.length === 0) {
		vscode.window.showInformationMessage(
			'No flows defined. Add flows to .tldraw/tldraw.config.json',
		);
		return;
	}

	const fileReader = createVscodeFileReader(workspaceRoot);
	let generated = 0;

	for (const flowConfig of config.flows) {
		// Parse entrypoint: "src/auth/login.ts:handleLogin"
		const colonIdx = flowConfig.entrypoint.lastIndexOf(':');
		if (colonIdx === -1) continue;

		const filePath = flowConfig.entrypoint.slice(0, colonIdx);
		const funcName = flowConfig.entrypoint.slice(colonIdx + 1);
		const absolutePath = path.join(workspaceRoot.fsPath, filePath);

		try {
			const flow = await traceFlow(absolutePath, funcName, flowConfig.name, fileReader);

			if (flow.nodes.length === 0) continue;

			// Convert FlowGraph to CallGraph for TldrWriter
			const callGraph: CallGraph = {
				nodes: flow.nodes.map(n => ({
					...n,
					// For flow diagrams, show source file in the label
					name: `${n.name} [${path.basename(n.sourceFile)}]`,
				})),
				edges: flow.edges,
				fileName: flowConfig.name,
				language: 'flow',
			};

			const positioned = layoutCallGraph(callGraph);
			const tldr = generateTldr(callGraph, {
				sourceFile: flowConfig.entrypoint,
				type: 'flow',
			}, positioned);

			const flowUri = sd.getFlowUri(flowConfig.name);
			await sd.writeTldr(flowUri, serializeTldr(tldr));
			generated++;
		} catch {
			// Skip flows that fail to trace
		}
	}

	vscode.window.showInformationMessage(
		`Generated ${generated} flow diagram${generated !== 1 ? 's' : ''}`,
	);
}

async function convertMermaid() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('No active file to convert.');
		return;
	}

	const document = editor.document;
	if (!document.fileName.endsWith('.mmd') && !document.fileName.endsWith('.mermaid')) {
		vscode.window.showWarningMessage('Active file must be a .mmd or .mermaid file.');
		return;
	}

	const content = document.getText();
	const sd = getShadowDir();

	const mermaidGraph = parseMermaid(content);
	if (mermaidGraph.nodes.length === 0) {
		vscode.window.showWarningMessage('No nodes found in mermaid diagram.');
		return;
	}

	const fileName = vscode.workspace.asRelativePath(document.uri);
	const callGraph = mermaidToCallGraph(mermaidGraph, fileName);
	const layout = layoutCallGraph(callGraph);
	const tldr = generateTldr(callGraph, {
		sourceFile: fileName,
		sourceHash: sd.computeHash(content),
		type: 'file',
	}, layout);
	const tldrContent = serializeTldr(tldr);

	// Write .tldr alongside the .mmd file
	const tldrUri = vscode.Uri.file(document.fileName.replace(/\.mmd$|\.mermaid$/, '.tldr'));
	await vscode.workspace.fs.writeFile(tldrUri, Buffer.from(tldrContent, 'utf-8'));

	// Open with tldraw extension
	try {
		await vscode.commands.executeCommand(
			'vscode.openWith',
			tldrUri,
			'tldraw.tldr',
			vscode.ViewColumn.Beside,
		);
	} catch {
		await vscode.commands.executeCommand(
			'vscode.open',
			tldrUri,
			{ viewColumn: vscode.ViewColumn.Beside },
		);
	}

	vscode.window.showInformationMessage(
		`Converted mermaid → tldraw: ${callGraph.nodes.length} nodes, ${callGraph.edges.length} edges, ${callGraph.groups?.length || 0} groups`,
	);
}

/**
 * Extract call graph from the active editor and generate a prompt.
 * Shared logic for copySummary and copyDetailSummary.
 */
async function extractAndGeneratePrompt(
	promptType: 'overview' | 'detail',
): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('No active file.');
		return;
	}

	const document = editor.document;
	const content = document.getText();
	const fileName = vscode.workspace.asRelativePath(document.uri);

	const config = getLanguageConfig(document.languageId);
	if (!config) {
		vscode.window.showWarningMessage(
			`Language "${document.languageId}" is not supported. Summary requires a supported source file.`,
		);
		return;
	}

	await initParser();
	const tree = await parseSource(content, config);
	const nodes = extractNodes(tree, config);
	const edges = extractEdges(tree, config, nodes);
	const graph: CallGraph = { nodes, edges, fileName, language: document.languageId };
	analyze(graph, tree, config);

	const sd = getShadowDir();

	// Generate prompt
	const generateFn = promptType === 'overview' ? generateOverviewPrompt : generateDetailPrompt;
	const prompt = generateFn(graph, content, config);
	await vscode.env.clipboard.writeText(prompt);

	// Create .mermaid placeholder files
	const mmdUri = promptType === 'overview'
		? sd.getMermaidOverviewUri(document.uri)
		: sd.getMermaidDetailUri(document.uri);

	try {
		// Only create if it doesn't exist yet
		await vscode.workspace.fs.stat(mmdUri);
	} catch {
		const placeholder = `%% Paste Claude's mermaid output here\n%% Source: ${fileName}\n%% Type: ${promptType}\n`;
		await vscode.workspace.fs.writeFile(mmdUri, Buffer.from(placeholder, 'utf-8'));
	}

	// Open the .mmd file for pasting
	await vscode.commands.executeCommand('vscode.open', mmdUri);

	const label = promptType === 'overview' ? 'Overview' : 'Detail';
	vscode.window.showInformationMessage(
		`${label} prompt copied! Paste into Claude, then paste the mermaid output into the opened .mmd file.`,
	);
}

async function copySummary() {
	await extractAndGeneratePrompt('overview');
}

async function copyDetailSummary() {
	await extractAndGeneratePrompt('detail');
}

/**
 * Extract call graph from the active editor — shared helper for both
 * clipboard-based and API-based workflows.
 */
async function buildCallGraphFromEditor(): Promise<{
	graph: CallGraph;
	content: string;
	config: ReturnType<typeof getLanguageConfig> & {};
	fileName: string;
	sourceUri: vscode.Uri;
} | undefined> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('No active file.');
		return undefined;
	}

	const document = editor.document;
	const content = document.getText();
	const fileName = vscode.workspace.asRelativePath(document.uri);

	const config = getLanguageConfig(document.languageId);
	if (!config) {
		vscode.window.showWarningMessage(
			`Language "${document.languageId}" is not supported.`,
		);
		return undefined;
	}

	await initParser();
	const tree = await parseSource(content, config);
	const nodes = extractNodes(tree, config);
	const edges = extractEdges(tree, config, nodes);
	const graph: CallGraph = { nodes, edges, fileName, language: document.languageId };
	analyze(graph, tree, config);

	return { graph, content, config, fileName, sourceUri: document.uri };
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
	const key = await vscode.window.showInputBox({
		prompt: 'Enter your Anthropic API key',
		password: true,
		placeHolder: 'sk-ant-...',
		ignoreFocusOut: true,
	});
	if (key) {
		await context.secrets.store('tldraw-viz.anthropicApiKey', key);
		claudeService = new ClaudeService(key);
		vscode.window.showInformationMessage('Anthropic API key saved.');
	}
}

async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
	await context.secrets.delete('tldraw-viz.anthropicApiKey');
	claudeService = undefined;
	vscode.window.showInformationMessage('Anthropic API key removed.');
}

async function generateDiagram(
	promptType: 'overview' | 'detail',
	context: vscode.ExtensionContext,
): Promise<void> {
	if (!claudeService) {
		const choice = await vscode.window.showWarningMessage(
			'No Anthropic API key set. Set one now, or use manual copy-paste.',
			'Set API Key',
			'Copy to Clipboard',
		);
		if (choice === 'Set API Key') return setApiKey(context);
		if (choice === 'Copy to Clipboard') return extractAndGeneratePrompt(promptType);
		return;
	}

	const built = await buildCallGraphFromEditor();
	if (!built) return;

	const { graph, content, config, fileName, sourceUri } = built;

	const generateFn = promptType === 'overview' ? generateOverviewPrompt : generateDetailPrompt;
	const prompt = generateFn(graph, content, config);

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Generating ${promptType} diagram with Claude...`,
			cancellable: false,
		},
		async () => {
			const result = await claudeService!.generateMermaid(prompt);

			const sd = getShadowDir();

			// Write mermaid to .mmd file
			const mmdUri = promptType === 'overview'
				? sd.getMermaidOverviewUri(sourceUri)
				: sd.getMermaidDetailUri(sourceUri);
			await vscode.workspace.fs.writeFile(mmdUri, Buffer.from(result.mermaidCode, 'utf-8'));

			// Convert to .tldr directly
			const mermaidGraph = parseMermaid(result.mermaidCode);
			const callGraph = mermaidToCallGraph(mermaidGraph, fileName);
			const layout = layoutCallGraph(callGraph);
			const tldr = generateTldr(callGraph, {
				sourceFile: fileName,
				sourceHash: sd.computeHash(result.mermaidCode),
				type: 'file',
			}, layout);
			const tldrUri = vscode.Uri.file(mmdUri.fsPath.replace(/\.mmd$/, '.tldr'));
			await vscode.workspace.fs.writeFile(tldrUri, Buffer.from(serializeTldr(tldr), 'utf-8'));

			// Open in tldraw
			try {
				await vscode.commands.executeCommand(
					'vscode.openWith',
					tldrUri,
					'tldraw.tldr',
					vscode.ViewColumn.Beside,
				);
			} catch {
				await vscode.commands.executeCommand(
					'vscode.open',
					tldrUri,
					{ viewColumn: vscode.ViewColumn.Beside },
				);
			}

			// Show token usage in status bar
			updateStatusBar(result.inputTokens, result.outputTokens);
		},
	);
}

function updateStatusBar(inputTokens: number, outputTokens: number): void {
	if (!statusBarItem) return;
	const totalTokens = inputTokens + outputTokens;
	const cost = estimateCost(inputTokens, outputTokens);
	statusBarItem.text = `$(sparkle) ${totalTokens.toLocaleString()} tokens · ~$${cost.toFixed(4)}`;
	statusBarItem.tooltip = `Input: ${inputTokens.toLocaleString()} · Output: ${outputTokens.toLocaleString()}`;
	statusBarItem.show();
	setTimeout(() => statusBarItem?.hide(), 30_000);
}

async function generateProjectArchitecture(
	context: vscode.ExtensionContext,
): Promise<void> {
	if (!claudeService) {
		const choice = await vscode.window.showWarningMessage(
			'No Anthropic API key set. Set one to generate project architecture.',
			'Set API Key',
		);
		if (choice === 'Set API Key') return setApiKey(context);
		return;
	}

	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!workspaceRoot) {
		vscode.window.showWarningMessage('No workspace folder open.');
		return;
	}

	const config = await loadTldrawConfig(workspaceRoot);
	const fileReader = createVscodeFileReader(workspaceRoot);
	const projectName = path.basename(workspaceRoot.fsPath);

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Generating project architecture with Claude...',
			cancellable: false,
		},
		async (progress) => {
			// Scan for project documentation (CLAUDE.md, README.md, plan.md, etc.)
			progress.report({ message: 'Scanning project documentation...' });
			const mdUris = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**');
			const mdFiles = mdUris.map(u => u.fsPath);
			const docs = await scanDocumentation(fileReader, workspaceRoot.fsPath, mdFiles);

			progress.report({ message: 'Analyzing project structure...' });
			const projectGraph = await buildProjectGraph(
				fileReader,
				workspaceRoot.fsPath,
				config.modules.length > 0 ? config.modules : undefined,
				projectName,
				docs,
			);

			if (projectGraph.modules.length === 0 && !docs.hasDocumentation) {
				vscode.window.showWarningMessage('No modules or documentation found in project.');
				return;
			}

			progress.report({ message: 'Generating diagram with Claude...' });
			const prompt = generateProjectPrompt(projectGraph);
			const result = await claudeService!.generateMermaid(prompt, 8192);

			const sd = getShadowDir();
			const mmdUri = sd.getProjectMermaidUri();
			await vscode.workspace.fs.writeFile(mmdUri, Buffer.from(result.mermaidCode, 'utf-8'));

			const mermaidGraph = parseMermaid(result.mermaidCode);
			const callGraph = mermaidToCallGraph(mermaidGraph, 'project-architecture');
			const layout = layoutCallGraph(callGraph);
			const tldr = generateTldr(callGraph, {
				sourceFile: 'project-architecture',
				sourceHash: sd.computeHash(result.mermaidCode),
				type: 'project',
			}, layout);
			const tldrUri = sd.getProjectUri();
			await sd.writeTldr(tldrUri, serializeTldr(tldr));

			try {
				await vscode.commands.executeCommand(
					'vscode.openWith',
					tldrUri,
					'tldraw.tldr',
					vscode.ViewColumn.Beside,
				);
			} catch {
				await vscode.commands.executeCommand(
					'vscode.open',
					tldrUri,
					{ viewColumn: vscode.ViewColumn.Beside },
				);
			}

			updateStatusBar(result.inputTokens, result.outputTokens);

			const docInfo = docs.hasDocumentation
				? ` (${docs.files.length} doc files scanned)`
				: ' (no docs found, using structure only)';
			vscode.window.showInformationMessage(
				`Project architecture: ${projectGraph.modules.length} modules, ${projectGraph.dependencies.length} dependencies${docInfo}`,
			);
		},
	);
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let mermaidDebounceTimer: ReturnType<typeof setTimeout> | undefined;

function setupFileWatcher(context: vscode.ExtensionContext): void {
	const watcher = vscode.workspace.createFileSystemWatcher(
		'**/*.{ts,tsx,js,jsx,py,go,rs,java}',
	);

	watcher.onDidChange(async (uri) => {
		// Only regenerate if a .tldr already exists for this file
		const sd = getShadowDir();
		const tldrUri = sd.getTldrUri(uri);
		try {
			await vscode.workspace.fs.stat(tldrUri);
		} catch {
			return; // No existing diagram, skip
		}

		// Debounce: 500ms
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(async () => {
			try {
				const doc = await vscode.workspace.openTextDocument(uri);
				const content = doc.getText();
				const fileName = vscode.workspace.asRelativePath(uri);

				if (await sd.isFresh(uri, content)) return;

				const result = await extractCallGraph(fileName, content, doc.languageId);
				if (!result || result.graph.nodes.length === 0) return;

				const positioned = layoutCallGraph(result.graph);
				const tldr = generateTldr(result.graph, {
					sourceFile: fileName,
					sourceHash: sd.computeHash(content),
					type: 'file',
				}, positioned);
				await sd.writeTldr(tldrUri, serializeTldr(tldr));
			} catch {
				// Silently ignore errors during auto-regeneration
			}
		}, 500);
	});

	context.subscriptions.push(watcher);
}

function setupMermaidWatcher(context: vscode.ExtensionContext): void {
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.{mmd,mermaid}');

	watcher.onDidChange(async (uri) => {
		// Auto-convert .mmd to .tldr on save
		if (mermaidDebounceTimer) clearTimeout(mermaidDebounceTimer);
		mermaidDebounceTimer = setTimeout(async () => {
			try {
				const doc = await vscode.workspace.openTextDocument(uri);
				const content = doc.getText();
				const fileName = vscode.workspace.asRelativePath(uri);

				const mermaidGraph = parseMermaid(content);
				if (mermaidGraph.nodes.length === 0) return;

				const sd = getShadowDir();
				const callGraph = mermaidToCallGraph(mermaidGraph, fileName);
				const layout = layoutCallGraph(callGraph);
				const tldr = generateTldr(callGraph, {
					sourceFile: fileName,
					sourceHash: sd.computeHash(content),
					type: 'file',
				}, layout);

				const tldrUri = vscode.Uri.file(
					uri.fsPath.replace(/\.mmd$|\.mermaid$/, '.tldr'),
				);
				await vscode.workspace.fs.writeFile(
					tldrUri,
					Buffer.from(serializeTldr(tldr), 'utf-8'),
				);
			} catch {
				// Silently ignore errors during auto-regeneration
			}
		}, 500);
	});

	context.subscriptions.push(watcher);
}

export async function activate(context: vscode.ExtensionContext) {
	// Restore API key from secure storage
	const apiKey = await context.secrets.get('tldraw-viz.anthropicApiKey');
	if (apiKey) {
		claudeService = new ClaudeService(apiKey);
	}

	// Status bar item for token usage
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	context.subscriptions.push(statusBarItem);

	context.subscriptions.push(
		vscode.commands.registerCommand('tldraw-viz.showDiagram', showDiagram),
		vscode.commands.registerCommand('tldraw-viz.generateAll', generateAll),
		vscode.commands.registerCommand('tldraw-viz.generateFlows', generateFlows),
		vscode.commands.registerCommand('tldraw-viz.convertMermaid', convertMermaid),
		vscode.commands.registerCommand('tldraw-viz.copySummary', copySummary),
		vscode.commands.registerCommand('tldraw-viz.copyDetailSummary', copyDetailSummary),
		vscode.commands.registerCommand('tldraw-viz.generateOverview', () => generateDiagram('overview', context)),
		vscode.commands.registerCommand('tldraw-viz.generateDetail', () => generateDiagram('detail', context)),
		vscode.commands.registerCommand('tldraw-viz.setApiKey', () => setApiKey(context)),
		vscode.commands.registerCommand('tldraw-viz.clearApiKey', () => clearApiKey(context)),
		vscode.commands.registerCommand('tldraw-viz.generateProjectArchitecture', () => generateProjectArchitecture(context)),
	);

	setupFileWatcher(context);
	setupMermaidWatcher(context);
}

export function deactivate() {
	shadowDir = undefined;
	if (debounceTimer) clearTimeout(debounceTimer);
	if (mermaidDebounceTimer) clearTimeout(mermaidDebounceTimer);
}
