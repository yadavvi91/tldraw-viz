import type { MermaidGraph, MermaidShape, MermaidEdgeStyle } from './MermaidParser';
import type { CallGraph, CodeNode, CodeEdge, NodeGroup, NodeRole, NodeShape, EdgeStyle } from './types';
import type { SymbolTable } from './SymbolTable';
import { lookupSymbol } from './SymbolTable';

/** Map mermaid shapes to tldraw geo shapes */
const SHAPE_MAP: Record<MermaidShape, NodeShape> = {
	rectangle: 'rectangle',
	stadium: 'oval',
	diamond: 'diamond',
	circle: 'ellipse',
	'double-circle': 'ellipse',
	hexagon: 'hexagon',
	subroutine: 'rectangle',
	asymmetric: 'rectangle',
	parallelogram: 'rectangle',
	trapezoid: 'rectangle',
};

/** Map mermaid shapes to semantic roles (best guess from shape) */
const ROLE_MAP: Record<MermaidShape, NodeRole> = {
	rectangle: 'process',
	stadium: 'user-action',
	diamond: 'decision',
	circle: 'entrypoint',
	'double-circle': 'entrypoint',
	hexagon: 'callback',
	subroutine: 'process',
	asymmetric: 'process',
	parallelogram: 'process',
	trapezoid: 'process',
};

/** Map mermaid shapes to tldraw colors */
const COLOR_MAP: Record<MermaidShape, string> = {
	rectangle: 'black',
	stadium: 'blue',
	diamond: 'violet',
	circle: 'light-blue',
	'double-circle': 'light-blue',
	hexagon: 'green',
	subroutine: 'grey',
	asymmetric: 'black',
	parallelogram: 'black',
	trapezoid: 'black',
};

/** Map mermaid edge styles to our EdgeStyle */
const EDGE_STYLE_MAP: Record<MermaidEdgeStyle, EdgeStyle> = {
	solid: 'solid',
	dotted: 'dotted',
	thick: 'dashed',
};

/** Source mapping for architecture diagram nodes */
export type NodeSourceMapping = Record<string, { file: string; line: number; name: string }>;

/**
 * Convert a parsed MermaidGraph into a CallGraph that can be fed
 * into the existing dagre layout → TldrWriter pipeline.
 *
 * When a SymbolTable is provided, byte offsets from tree-sitter are used
 * for precise click-to-navigate (preferred over NODE_MAP line numbers).
 */
export function mermaidToCallGraph(
	graph: MermaidGraph,
	fileName: string,
	nodeMapping?: NodeSourceMapping,
	symbolTable?: SymbolTable,
): CallGraph {
	const nodes: CodeNode[] = [];
	const edges: CodeEdge[] = [];
	const groups: NodeGroup[] = [];

	// Build subgraph membership map
	const nodeToSubgraph = new Map<string, string>();
	for (const sg of graph.subgraphs) {
		for (const nodeId of sg.nodeIds) {
			nodeToSubgraph.set(nodeId, sg.id);
		}
	}

	// Convert nodes
	for (const mNode of graph.nodes) {
		const mapping = nodeMapping?.[mNode.id];
		// Extract just the function name from mermaid labels like
		// "extractReactDetails —\ncheck if node is React component,\nextract hooks & JSX info"
		// We want just "extractReactDetails" for source navigation.
		const rawName = mapping?.name || mNode.label || mNode.id;
		const funcName = rawName.split(/\s*[—–\-]\s*|\n/)[0].trim();
		// Line number priority: explicit nodeMapping > NODE_MAP from mermaid comments > 0
		const line = mapping?.line || graph.nodeLineMap?.[mNode.id] || 0;

		// Try to resolve byte offsets from the symbol table (ground truth from tree-sitter)
		let startByte: number | undefined;
		let endByte: number | undefined;
		let resolvedLine = line;
		if (symbolTable) {
			const symbol = lookupSymbol(symbolTable, funcName || rawName);
			if (symbol) {
				startByte = symbol.startByte;
				endByte = symbol.endByte;
				// Tree-sitter's line number is always correct
				resolvedLine = symbol.line;
			}
		}

		nodes.push({
			id: mNode.id,
			name: funcName || rawName,
			type: 'function',
			line: resolvedLine,
			startByte,
			endByte,
			role: ROLE_MAP[mNode.shape],
			shape: SHAPE_MAP[mNode.shape],
			color: COLOR_MAP[mNode.shape],
			label: mNode.label,
			groupId: nodeToSubgraph.get(mNode.id),
			sourceFile: mapping?.file,
		});
	}

	// Convert edges
	for (const mEdge of graph.edges) {
		edges.push({
			from: mEdge.from,
			to: mEdge.to,
			label: mEdge.label,
			style: EDGE_STYLE_MAP[mEdge.style],
		});
	}

	// Convert subgraphs
	for (const sg of graph.subgraphs) {
		groups.push({
			id: sg.id,
			label: sg.label,
			nodeIds: [...sg.nodeIds],
		});
	}

	return {
		nodes,
		edges,
		fileName,
		language: 'mermaid',
		groups,
	};
}
