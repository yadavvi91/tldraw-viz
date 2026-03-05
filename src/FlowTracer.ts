import type { LanguageConfig } from './languages';
import { getLanguageConfig, extensionToLanguage } from './languages';
import { initParser, parseSource, extractNodes } from './CodeAnalyzer';
import { extractEdges } from './CallGraphExtractor';
import { extractImports, resolveImportPath } from './ImportResolver';
import type { CallGraph, CodeNode, CodeEdge } from './types';
import path from 'path';

export interface FlowNode extends CodeNode {
	/** Source file (relative path) */
	sourceFile: string;
}

export interface FlowGraph {
	nodes: FlowNode[];
	edges: CodeEdge[];
	name: string;
	entrypoint: string;
}

export interface FileReader {
	readFile(absolutePath: string): Promise<string>;
	listFiles(): Promise<string[]>;
}

/**
 * Trace execution flow starting from an entrypoint function,
 * following imports across files.
 */
export async function traceFlow(
	entrypointFile: string,
	entrypointFunction: string,
	flowName: string,
	fileReader: FileReader,
	maxDepth: number = 5,
): Promise<FlowGraph> {
	await initParser();

	const allFiles = new Set(await fileReader.listFiles());
	const visitedFiles = new Map<string, {
		nodes: CodeNode[];
		edges: CodeEdge[];
		language: string;
	}>();

	const flowNodes: FlowNode[] = [];
	const flowEdges: CodeEdge[] = [];
	const processedFunctions = new Set<string>();

	// Parse the entrypoint file and start tracing
	await traceFromFile(
		entrypointFile,
		entrypointFunction,
		0,
		maxDepth,
		fileReader,
		allFiles,
		visitedFiles,
		flowNodes,
		flowEdges,
		processedFunctions,
	);

	return {
		nodes: flowNodes,
		edges: flowEdges,
		name: flowName,
		entrypoint: `${entrypointFile}:${entrypointFunction}`,
	};
}

async function traceFromFile(
	filePath: string,
	targetFunction: string | undefined,
	depth: number,
	maxDepth: number,
	fileReader: FileReader,
	allFiles: Set<string>,
	visitedFiles: Map<string, { nodes: CodeNode[]; edges: CodeEdge[]; language: string }>,
	flowNodes: FlowNode[],
	flowEdges: CodeEdge[],
	processedFunctions: Set<string>,
): Promise<void> {
	if (depth > maxDepth) return;

	// Parse file if not already done
	if (!visitedFiles.has(filePath)) {
		const ext = path.extname(filePath);
		const languageKey = extensionToLanguage(ext);
		if (!languageKey) return;

		const config = getLanguageConfig(languageKey);
		if (!config) return;

		let content: string;
		try {
			content = await fileReader.readFile(filePath);
		} catch {
			return;
		}

		const tree = await parseSource(content, config);
		const nodes = extractNodes(tree, config);
		const edges = extractEdges(tree, config, nodes);

		visitedFiles.set(filePath, { nodes, edges, language: languageKey });

		// Extract imports for cross-file resolution
		const imports = extractImports(tree, languageKey);
		for (const imp of imports) {
			const resolved = resolveImportPath(imp.source, filePath, allFiles);
			if (resolved && !visitedFiles.has(resolved)) {
				// Pre-parse imported files
				await traceFromFile(
					resolved,
					undefined,
					depth + 1,
					maxDepth,
					fileReader,
					allFiles,
					visitedFiles,
					flowNodes,
					flowEdges,
					processedFunctions,
				);
			}
		}
	}

	const fileData = visitedFiles.get(filePath);
	if (!fileData) return;

	const relPath = filePath;

	// Add nodes from this file to the flow
	for (const node of fileData.nodes) {
		if (node.type === 'class') continue; // Skip class declarations in flow view

		const flowNodeId = `${relPath}:${node.id}`;
		if (processedFunctions.has(flowNodeId)) continue;

		// If targeting a specific function, only include it and its callees
		if (targetFunction && depth === 0 && node.name !== targetFunction) continue;

		processedFunctions.add(flowNodeId);
		flowNodes.push({
			...node,
			id: flowNodeId,
			sourceFile: relPath,
		});
	}

	// Add intra-file edges
	for (const edge of fileData.edges) {
		const fromId = `${relPath}:${edge.from}`;
		const toId = `${relPath}:${edge.to}`;
		if (processedFunctions.has(fromId) && processedFunctions.has(toId)) {
			flowEdges.push({ from: fromId, to: toId });
		}
	}
}
