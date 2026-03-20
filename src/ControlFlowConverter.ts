import type {
	CallGraph, CodeEdge, CodeNode, ControlFlowGraph, ControlFlowNodeType,
	NodeRole, NodeShape,
} from './types';

/** Map control flow node type → visual role */
const CF_ROLE_MAP: Partial<Record<ControlFlowNodeType, NodeRole>> = {
	'entry': 'entrypoint',
	'exit': 'process',
	'call': 'callback',
	'assignment': 'process',
	'return': 'display',
	'if-condition': 'decision',
	'for-loop': 'decision',
	'while-loop': 'decision',
	'try': 'process',
	'catch': 'callback',
	'finally': 'process',
	'throw': 'display',
	'await': 'callback',
	'expression': 'process',
};

/** Map control flow node type → visual shape */
const CF_SHAPE_MAP: Partial<Record<ControlFlowNodeType, NodeShape>> = {
	'entry': 'ellipse',
	'exit': 'ellipse',
	'if-condition': 'diamond',
	'for-loop': 'diamond',
	'while-loop': 'diamond',
	'try': 'hexagon',
	'catch': 'hexagon',
	'finally': 'hexagon',
	'return': 'oval',
	'throw': 'oval',
};

/** Map control flow node type → tldraw color */
const CF_COLOR_MAP: Partial<Record<ControlFlowNodeType, string>> = {
	'entry': 'green',
	'exit': 'light-red',
	'call': 'light-blue',
	'assignment': 'black',
	'return': 'orange',
	'if-condition': 'violet',
	'for-loop': 'blue',
	'while-loop': 'blue',
	'try': 'yellow',
	'catch': 'yellow',
	'finally': 'yellow',
	'throw': 'red',
	'await': 'light-green',
	'expression': 'grey',
};

/**
 * Convert a ControlFlowGraph into a CallGraph so we can reuse
 * the existing dagre layout + TldrWriter pipeline.
 */
export function controlFlowToCallGraph(cfg: ControlFlowGraph): CallGraph {
	const nodes: CodeNode[] = cfg.nodes.map(cfNode => ({
		id: cfNode.id,
		name: cfNode.label,
		type: 'function' as const,
		line: cfNode.line,
		startByte: cfNode.startByte,
		endByte: cfNode.endByte,
		role: cfNode.role || CF_ROLE_MAP[cfNode.cfType],
		shape: cfNode.shape || CF_SHAPE_MAP[cfNode.cfType],
		color: cfNode.color || CF_COLOR_MAP[cfNode.cfType],
		label: cfNode.label,
		sourceFile: cfg.sourceFile,
	}));

	const edges: CodeEdge[] = cfg.edges.map(cfEdge => ({
		from: cfEdge.from,
		to: cfEdge.to,
		label: cfEdge.label,
		style: cfEdge.label === 'loop' ? 'dashed' as const : undefined,
	}));

	return {
		nodes,
		edges,
		fileName: cfg.sourceFile,
		language: 'typescript',
		groups: cfg.groups,
	};
}
