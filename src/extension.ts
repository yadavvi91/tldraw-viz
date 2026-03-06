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
import { getLanguageConfig, extensionToLanguage } from './languages';
import { parseMermaid } from './MermaidParser';
import { mermaidToCallGraph, type NodeSourceMapping } from './MermaidConverter';
import { generateOverviewPrompt, generateDetailPrompt, generateProjectPrompt, generateFlowPrompt } from './StructuralSummary';
import { ClaudeService, estimateCost } from './ClaudeService';
import { buildProjectGraph } from './ProjectAnalyzer';
import { scanDocumentation } from './DocumentationScanner';
import { detectEntrypoints, entrypointsToFlowConfigs } from './EntrypointDetector';
import type { CallGraph } from './types';
import type { FlowConfig } from './GranularityFilter';
import { TldrawEditorProvider } from './TldrawEditorProvider';
import type Parser from 'web-tree-sitter';

let shadowDir: ShadowDirectory | undefined;
let claudeService: ClaudeService | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
const log = vscode.window.createOutputChannel('tldraw-viz', { log: true });

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
			modules: DEFAULT_CONFIG.modules,
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
			'tldraw-viz.tldr',
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
			'tldraw-viz.tldr',
			vscode.ViewColumn.Beside,
		);
	} catch {
		// Fallback: open as text
		await vscode.commands.executeCommand(
			'vscode.open',
			tldrUri,
			{ viewColumn: vscode.ViewColumn.Beside },
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

			// Also generate flow diagrams (from config or auto-detected)
			const fileReader = createVscodeFileReader(workspaceRoot);
			let flowConfigs = config.flows;
			if (flowConfigs.length === 0 && !token.isCancellationRequested) {
				progress.report({ message: 'Auto-detecting flow entrypoints...' });
				const detected = await detectEntrypoints(fileReader, workspaceRoot.fsPath);
				flowConfigs = entrypointsToFlowConfigs(detected);
			}

			if (flowConfigs.length > 0 && !token.isCancellationRequested) {
				progress.report({ message: 'Generating flow diagrams...' });

				for (const flowConfig of flowConfigs) {
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
								sourceFile: path.relative(workspaceRoot.fsPath, n.sourceFile),
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
	const fileReader = createVscodeFileReader(workspaceRoot);

	const flowConfigs = await resolveFlowConfigs(config.flows, fileReader, workspaceRoot, { multiSelect: true });
	if (!flowConfigs) return; // User cancelled
	if (flowConfigs.length === 0) {
		vscode.window.showInformationMessage(
			'No flows configured and no entrypoints auto-detected. Add flows to .tldraw/tldraw.config.json',
		);
		return;
	}

	let generated = 0;

	for (const flowConfig of flowConfigs) {
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
					sourceFile: path.relative(workspaceRoot.fsPath, n.sourceFile),
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

/**
 * Fallback line resolution for nodes without NODE_MAP entries.
 * Tries AST matching, then prefix inheritance, then group inheritance.
 * This is only needed for old mermaid files generated before NODE_MAP was added.
 */
async function resolveSourceLines(callGraph: CallGraph, sourceFile: string): Promise<void> {
	// If all nodes already have lines (from NODE_MAP), nothing to do
	const unresolved = callGraph.nodes.filter(n => n.line === 0);
	if (unresolved.length === 0) {
		log.info(`resolveSourceLines: all ${callGraph.nodes.length} nodes already have lines from NODE_MAP`);
		return;
	}

	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!workspaceRoot) return;

	try {
		const fileUri = vscode.Uri.joinPath(workspaceRoot, sourceFile);
		log.info(`resolveSourceLines: ${unresolved.length}/${callGraph.nodes.length} nodes need resolution for "${sourceFile}"`);
		const doc = await vscode.workspace.openTextDocument(fileUri);
		const ext = path.extname(sourceFile);
		const langKey = extensionToLanguage(ext);
		if (!langKey) return;

		const config = getLanguageConfig(langKey);
		if (!config) return;

		await initParser();
		const tree = await parseSource(doc.getText(), config);
		const astNodes = extractNodes(tree, config);
		const astLineMap = new Map(astNodes.map(n => [n.name, n.line]));

		// Pass 1: direct AST match on node name/id
		for (const node of callGraph.nodes) {
			if (node.line === 0) {
				node.line = astLineMap.get(node.name) || astLineMap.get(node.id) || 0;
			}
		}

		// Pass 2: sub-step nodes inherit parent line (e.g., "func_step" → "func")
		const resolved = new Map(
			callGraph.nodes.filter(n => n.line > 0).map(n => [n.id, n.line]),
		);
		for (const node of callGraph.nodes) {
			if (node.line === 0) {
				for (const [funcId, funcLine] of resolved) {
					if (node.id.startsWith(funcId + '_') || node.id.startsWith(funcId + '-')) {
						node.line = funcLine;
						break;
					}
				}
			}
		}

		// Pass 3: group siblings inherit from resolved members
		if (callGraph.groups) {
			for (const group of callGraph.groups) {
				const groupLine = group.nodeIds
					.map(id => callGraph.nodes.find(n => n.id === id))
					.find(n => n && n.line > 0)?.line;
				if (groupLine) {
					for (const nodeId of group.nodeIds) {
						const node = callGraph.nodes.find(n => n.id === nodeId);
						if (node && node.line === 0) node.line = groupLine;
					}
				}
			}
		}

		const remaining = callGraph.nodes.filter(n => n.line === 0);
		if (remaining.length > 0) {
			log.warn(`resolveSourceLines: ${remaining.length} nodes still at line 0`);
		} else {
			log.info(`resolveSourceLines: all nodes resolved`);
		}
	} catch (err) {
		log.error(`resolveSourceLines failed for "${sourceFile}": ${err}`);
	}
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
	// Derive source file: .mermaid/path/to/file.ts.overview.mmd → path/to/file.ts
	const sourceFile = fileName
		.replace(new RegExp(`^${sd.getMermaidDir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), '')
		.replace(/\.(overview|detail)(-\d+)?\.mmd$/, '');
	const callGraph = mermaidToCallGraph(mermaidGraph, sourceFile);

	// Resolve line numbers from AST-parsed source file
	await resolveSourceLines(callGraph, sourceFile);

	const layout = layoutCallGraph(callGraph);
	const tldr = generateTldr(callGraph, {
		sourceFile: sourceFile,
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
			'tldraw-viz.tldr',
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

			// Strip markdown code fences from Claude's response
			let mermaidCode = result.mermaidCode.trim();
			if (mermaidCode.startsWith('```')) {
				mermaidCode = mermaidCode.replace(/^```(?:mermaid)?\s*\n/, '');
				mermaidCode = mermaidCode.replace(/\n```\s*$/, '');
			}

			const sd = getShadowDir();

			// Write mermaid to .mmd file (clean, without code fences)
			const mmdUri = promptType === 'overview'
				? sd.getMermaidOverviewUri(sourceUri)
				: sd.getMermaidDetailUri(sourceUri);
			await vscode.workspace.fs.writeFile(mmdUri, Buffer.from(mermaidCode, 'utf-8'));

			// Convert to .tldr directly
			const mermaidGraph = parseMermaid(mermaidCode);
			const callGraph = mermaidToCallGraph(mermaidGraph, fileName);

			// Resolve lines from AST-parsed call graph for Claude-generated nodes
			const astLineMap = new Map(graph.nodes.map(n => [n.name, n.line]));
			for (const node of callGraph.nodes) {
				if (node.line === 0) {
					node.line = astLineMap.get(node.name) || astLineMap.get(node.id) || astLineMap.get(node.label || '') || 0;
				}
			}

			const layout = layoutCallGraph(callGraph);
			const tldr = generateTldr(callGraph, {
				sourceFile: fileName,
				sourceHash: sd.computeHash(mermaidCode),
				type: 'file',
			}, layout);
			const tldrUri = vscode.Uri.file(mmdUri.fsPath.replace(/\.mmd$/, '.tldr'));
			await vscode.workspace.fs.writeFile(tldrUri, Buffer.from(serializeTldr(tldr), 'utf-8'));

			// Open in tldraw
			try {
				await vscode.commands.executeCommand(
					'vscode.openWith',
					tldrUri,
					'tldraw-viz.tldr',
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

/** Parse NODE_MAP comments from Claude's raw output */
function parseNodeMap(rawText: string): NodeSourceMapping {
	const mapping: NodeSourceMapping = {};
	const regex = /%%\s*NODE_MAP:\s*(\S+)\s*->\s*([^:]+):(\d+):(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(rawText)) !== null) {
		mapping[match[1]] = {
			file: match[2].trim(),
			line: parseInt(match[3], 10),
			name: match[4].trim(),
		};
	}
	return mapping;
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

			// Strip markdown code fences from Claude's response
			let mermaidCode = result.mermaidCode.trim();
			if (mermaidCode.startsWith('```')) {
				mermaidCode = mermaidCode.replace(/^```(?:mermaid)?\s*\n/, '');
				mermaidCode = mermaidCode.replace(/\n```\s*$/, '');
			}

			const sd = getShadowDir();
			const mmdUri = sd.getProjectMermaidUri();
			await vscode.workspace.fs.writeFile(mmdUri, Buffer.from(mermaidCode, 'utf-8'));

			const nodeMapping = parseNodeMap(result.rawText);
			const mermaidGraph = parseMermaid(mermaidCode);
			const callGraph = mermaidToCallGraph(mermaidGraph, 'project-architecture', nodeMapping);
			const layout = layoutCallGraph(callGraph);
			const tldr = generateTldr(callGraph, {
				sourceFile: 'project-architecture',
				sourceHash: sd.computeHash(mermaidCode),
				type: 'project',
			}, layout);
			const tldrUri = sd.getProjectUri();
			await sd.writeTldr(tldrUri, serializeTldr(tldr));

			try {
				await vscode.commands.executeCommand(
					'vscode.openWith',
					tldrUri,
					'tldraw-viz.tldr',
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

/**
 * Resolve flow configs from config, falling back to auto-detection.
 * Returns null if user cancels the QuickPick.
 */
async function resolveFlowConfigs(
	configFlows: FlowConfig[],
	fileReader: FileReader,
	workspaceRoot: vscode.Uri,
	options?: { multiSelect?: boolean },
): Promise<FlowConfig[] | null> {
	let flowConfigs = configFlows;

	if (flowConfigs.length === 0) {
		const detected = await detectEntrypoints(fileReader, workspaceRoot.fsPath);
		flowConfigs = entrypointsToFlowConfigs(detected);
	}

	if (flowConfigs.length === 0) return [];

	if (flowConfigs.length === 1 && !options?.multiSelect) return flowConfigs;

	const items = flowConfigs.map(f => ({
		label: f.name,
		description: f.entrypoint,
		picked: options?.multiSelect ?? false,
	}));

	if (options?.multiSelect) {
		const selected = await vscode.window.showQuickPick(items, {
			canPickMany: true,
			placeHolder: `${flowConfigs.length} flows available. Select which to generate:`,
		});
		if (!selected) return null;
		return selected.map(s => flowConfigs.find(f => f.name === s.label)!);
	} else {
		const picked = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select a flow:',
		});
		if (!picked) return null;
		return [flowConfigs.find(f => f.name === picked.label)!];
	}
}

async function generateFlowWithClaude(
	context: vscode.ExtensionContext,
): Promise<void> {
	if (!claudeService) {
		const choice = await vscode.window.showWarningMessage(
			'No Anthropic API key set. Set one to generate flow diagrams with Claude.',
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

	const sd = getShadowDir();
	const config = await loadTldrawConfig(workspaceRoot);
	const fileReader = createVscodeFileReader(workspaceRoot);

	const flowConfigs = await resolveFlowConfigs(config.flows, fileReader, workspaceRoot);

	if (!flowConfigs) return; // User cancelled
	if (flowConfigs.length === 0) {
		vscode.window.showWarningMessage(
			'No flows configured and no entrypoints auto-detected. Add flows to .tldraw/tldraw.config.json',
		);
		return;
	}

	const selectedFlow = flowConfigs[0];
	const colonIdx = selectedFlow.entrypoint.lastIndexOf(':');
	if (colonIdx === -1) {
		vscode.window.showWarningMessage(`Invalid entrypoint format: ${selectedFlow.entrypoint}`);
		return;
	}

	const filePath = selectedFlow.entrypoint.slice(0, colonIdx);
	const funcName = selectedFlow.entrypoint.slice(colonIdx + 1);
	const absolutePath = path.join(workspaceRoot.fsPath, filePath);

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Generating "${selectedFlow.name}" flow with Claude...`,
			cancellable: false,
		},
		async (progress) => {
			progress.report({ message: 'Tracing flow...' });
			const flowGraph = await traceFlow(absolutePath, funcName, selectedFlow.name, fileReader);

			if (flowGraph.nodes.length === 0) {
				vscode.window.showWarningMessage(
					`No functions found for flow "${selectedFlow.name}". Check the entrypoint.`,
				);
				return;
			}

			progress.report({ message: 'Generating diagram with Claude...' });
			const prompt = generateFlowPrompt(flowGraph);
			const result = await claudeService!.generateMermaid(prompt, 8192);

			// Strip markdown code fences from Claude's response
			let mermaidCode = result.mermaidCode.trim();
			if (mermaidCode.startsWith('```')) {
				mermaidCode = mermaidCode.replace(/^```(?:mermaid)?\s*\n/, '');
				mermaidCode = mermaidCode.replace(/\n```\s*$/, '');
			}

			// Write .mmd to .mermaid/flows/
			const mmdUri = sd.getFlowMermaidUri(selectedFlow.name);
			await vscode.workspace.fs.writeFile(mmdUri, Buffer.from(mermaidCode, 'utf-8'));

			// Convert mermaid → CallGraph → layout → .tldr
			const mermaidGraph = parseMermaid(mermaidCode);
			const callGraph = mermaidToCallGraph(mermaidGraph, selectedFlow.name);
			const layout = layoutCallGraph(callGraph);
			const tldr = generateTldr(callGraph, {
				sourceFile: selectedFlow.entrypoint,
				sourceHash: sd.computeHash(mermaidCode),
				type: 'flow',
			}, layout);

			const flowUri = sd.getFlowUri(selectedFlow.name);
			await sd.writeTldr(flowUri, serializeTldr(tldr));

			try {
				await vscode.commands.executeCommand(
					'vscode.openWith',
					flowUri,
					'tldraw-viz.tldr',
					vscode.ViewColumn.Beside,
				);
			} catch {
				await vscode.commands.executeCommand(
					'vscode.open',
					flowUri,
					{ viewColumn: vscode.ViewColumn.Beside },
				);
			}

			updateStatusBar(result.inputTokens, result.outputTokens);

			const fileCount = new Set(flowGraph.nodes.map(n => n.sourceFile)).size;
			vscode.window.showInformationMessage(
				`Flow "${selectedFlow.name}": ${flowGraph.nodes.length} functions across ${fileCount} files`,
			);
		},
	);
}

/**
 * Quick-parse a source file to find the current line number of a function.
 * Used to resolve stale line numbers when navigating from diagrams.
 */
async function findCurrentLine(
	workspaceRoot: vscode.Uri,
	file: string,
	functionName: string,
	fallbackLine: number,
): Promise<number> {
	// If we already have a good line from NODE_MAP, just use it
	if (fallbackLine > 0) return fallbackLine;

	try {
		const fileUri = vscode.Uri.joinPath(workspaceRoot, file);
		const doc = await vscode.workspace.openTextDocument(fileUri);
		const ext = path.extname(file);
		const langKey = extensionToLanguage(ext);
		if (!langKey) return fallbackLine;

		const config = getLanguageConfig(langKey);
		if (!config) return fallbackLine;

		await initParser();
		const tree = await parseSource(doc.getText(), config);
		const nodes = extractNodes(tree, config);

		// Clean the name
		const cleaned = functionName
			.replace(/^["'/]+|["'/]+$/g, '')
			.replace(/\\n/g, ' ')
			.trim();

		// Try exact AST match
		const exact = nodes.find(n => n.name === functionName) || nodes.find(n => n.name === cleaned);
		if (exact) {
			log.info(`findCurrentLine: AST match "${exact.name}" → line ${exact.line}`);
			return exact.line;
		}

		// Try AST keyword match (function name appears in the label)
		for (const n of [...nodes].sort((a, b) => b.name.length - a.name.length)) {
			if (n.name.length < 3) continue;
			const re = new RegExp(`\\b${n.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
			if (re.test(cleaned)) {
				log.info(`findCurrentLine: AST keyword "${n.name}" → line ${n.line}`);
				return n.line;
			}
		}

		return fallbackLine;
	} catch (err) {
		log.error(`findCurrentLine failed: ${err}`);
		return fallbackLine;
	}
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
				const mmdRelPath = vscode.workspace.asRelativePath(uri);

				const mermaidGraph = parseMermaid(content);
				if (mermaidGraph.nodes.length === 0) return;

				const sd = getShadowDir();
				// Derive source file from .mmd path:
				// .mermaid/path/to/file.ts.overview.mmd → path/to/file.ts
				const sourceFile = mmdRelPath
					.replace(new RegExp(`^${sd.getMermaidDir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), '')
					.replace(/\.(overview|detail)(-\d+)?\.mmd$/, '');
				const callGraph = mermaidToCallGraph(mermaidGraph, sourceFile);

				// Resolve line numbers from AST-parsed source file
				await resolveSourceLines(callGraph, sourceFile);

				const layout = layoutCallGraph(callGraph);
				const tldr = generateTldr(callGraph, {
					sourceFile,
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

/** URI handler for vscode://yadavvi91.tldraw-viz/navigate?file=X&line=Y&name=Z */
class NavigationUriHandler implements vscode.UriHandler {
	async handleUri(uri: vscode.Uri): Promise<void> {
		if (uri.path !== '/navigate') return;

		const params = new URLSearchParams(uri.query);
		const file = params.get('file');
		const lineStr = params.get('line');
		const name = params.get('name');

		if (!file) {
			vscode.window.showWarningMessage('Navigation URI missing file parameter.');
			return;
		}

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!workspaceRoot) {
			vscode.window.showWarningMessage('No workspace folder open.');
			return;
		}

		const storedLine = lineStr ? parseInt(lineStr, 10) : 0;
		const freshLookup = vscode.workspace.getConfiguration('tldraw-viz')
			.get<boolean>('freshLineLookup', true);

		let line = storedLine;
		if (freshLookup && name && storedLine > 0) {
			line = await findCurrentLine(workspaceRoot, file, name, storedLine);
		}

		const zeroBasedLine = Math.max(0, line - 1);
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
			vscode.window.showWarningMessage(
				`Could not open file: ${file}` + (name ? ` (function: ${name})` : ''),
			);
		}
	}
}

/** Quick Pick command to navigate to a function in the currently open diagram */
async function navigateToFunction(): Promise<void> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!workspaceRoot) {
		vscode.window.showWarningMessage('No workspace folder open.');
		return;
	}

	// Find the currently visible .tldr tab
	let tldrUri: vscode.Uri | undefined;
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const input = tab.input;
			if (input && typeof input === 'object' && 'uri' in input) {
				const uri = (input as { uri: vscode.Uri }).uri;
				if (uri.fsPath.endsWith('.tldr')) {
					tldrUri = uri;
					break;
				}
			}
		}
		if (tldrUri) break;
	}

	if (!tldrUri) {
		vscode.window.showWarningMessage('No .tldr diagram is currently open. Open a diagram first.');
		return;
	}

	let data: { records?: Array<Record<string, unknown>> };
	try {
		const raw = await vscode.workspace.fs.readFile(tldrUri);
		data = JSON.parse(Buffer.from(raw).toString('utf-8'));
	} catch {
		vscode.window.showWarningMessage('Could not read the diagram file.');
		return;
	}

	const docRecord = data.records?.find(
		(r) => r.id === 'document:document',
	) as { meta?: { tldrawViz?: { sourceFile?: string; type?: string } } } | undefined;
	const documentSourceFile = docRecord?.meta?.tldrawViz?.sourceFile || '';

	// Extract all navigable shapes
	interface NavigableShape {
		name: string;
		line: number;
		file: string;
		displayText: string;
	}

	const navigableShapes: NavigableShape[] = [];
	for (const r of data.records || []) {
		if (r.typeName !== 'shape' || r.type !== 'geo') continue;
		const meta = r.meta as { sourceLine?: number; sourceName?: string; sourceFile?: string } | undefined;
		if (!meta) continue;

		const sourceFile = meta.sourceFile || documentSourceFile;
		const line = meta.sourceLine || 0;
		const name = meta.sourceName || '';
		if (!sourceFile || line === 0) continue;

		const props = r.props as { text?: string } | undefined;
		navigableShapes.push({
			name,
			line,
			file: sourceFile,
			displayText: props?.text || name,
		});
	}

	if (navigableShapes.length === 0) {
		vscode.window.showInformationMessage('No navigable functions found in this diagram.');
		return;
	}

	const items = navigableShapes.map(s => ({
		label: s.displayText,
		description: `${s.file}:${s.line}`,
		shape: s,
	}));

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: 'Navigate to function in source...',
		matchOnDescription: true,
	});

	if (!picked) return;

	const freshLookup = vscode.workspace.getConfiguration('tldraw-viz')
		.get<boolean>('freshLineLookup', true);

	let line = picked.shape.line;
	if (freshLookup && picked.shape.name) {
		line = await findCurrentLine(workspaceRoot, picked.shape.file, picked.shape.name, line);
	}

	const zeroBasedLine = Math.max(0, line - 1);
	const fileUri = vscode.Uri.joinPath(workspaceRoot, picked.shape.file);

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
		vscode.window.showWarningMessage(`Could not open: ${picked.shape.file}`);
	}
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
		vscode.commands.registerCommand('tldraw-viz.generateFlowWithClaude', () => generateFlowWithClaude(context)),
		vscode.commands.registerCommand('tldraw-viz.navigateToFunction', navigateToFunction),
	);

	// Register URI handler for shape click-to-navigate
	context.subscriptions.push(
		vscode.window.registerUriHandler(new NavigationUriHandler()),
	);

	// Register custom editor for .tldr files (renders tldraw + click-to-navigate)
	try {
		context.subscriptions.push(
			TldrawEditorProvider.register(context, findCurrentLine),
		);
		console.log('[tldraw-viz] Extension activation complete');
	} catch (err) {
		console.error('[tldraw-viz] FAILED to register custom editor:', err);
	}

	setupFileWatcher(context);
	setupMermaidWatcher(context);
}

export function deactivate() {
	shadowDir = undefined;
	if (debounceTimer) clearTimeout(debounceTimer);
	if (mermaidDebounceTimer) clearTimeout(mermaidDebounceTimer);
}
