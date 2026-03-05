import type {
	CallGraph, CodeEdge, LayoutResult, NodeRole, NodeShape,
	PositionedGroup, PositionedNode, TldrFile, TldrRecord, TldrawVizMeta,
} from './types';

const NODE_WIDTH = 280;
const NODE_HEIGHT = 60;
const RANK_SEP = 80;
const NODE_SEP = 40;

/** Fallback color map when node has no role */
const TYPE_COLOR_MAP: Record<string, string> = {
	function: 'blue',
	method: 'green',
	class: 'violet',
	interface: 'orange',
	variable: 'yellow',
};

/** Role → tldraw color */
const ROLE_COLOR_MAP: Record<NodeRole, string> = {
	'user-action': 'blue',
	'process': 'black',
	'callback': 'green',
	'decision': 'violet',
	'display': 'yellow',
	'parent': 'light-red',
	'hidden': 'grey',
	'entrypoint': 'light-blue',
};

/** Role → tldraw geo shape */
const ROLE_SHAPE_MAP: Record<NodeShape, string> = {
	'rectangle': 'rectangle',
	'diamond': 'diamond',
	'ellipse': 'ellipse',
	'cloud': 'cloud',
	'hexagon': 'hexagon',
	'oval': 'oval',
};

/** Edge style → tldraw dash */
const EDGE_DASH_MAP: Record<string, string> = {
	solid: 'solid',
	dashed: 'dashed',
	dotted: 'dotted',
};

/** Generate a tldraw-compatible index string for ordering */
function makeIndex(i: number): string {
	return `a${i.toString().padStart(4, '0')}`;
}

/**
 * Layout nodes using a simple top-to-bottom grid (fallback).
 */
function layoutNodes(graph: CallGraph): PositionedNode[] {
	const positioned: PositionedNode[] = [];
	const cols = Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length)));

	for (let i = 0; i < graph.nodes.length; i++) {
		const col = i % cols;
		const row = Math.floor(i / cols);
		positioned.push({
			...graph.nodes[i],
			x: col * (NODE_WIDTH + NODE_SEP),
			y: row * (NODE_HEIGHT + RANK_SEP),
			width: NODE_WIDTH,
			height: NODE_HEIGHT,
		});
	}

	return positioned;
}

/** Create a frame shape for a group (subgraph) */
function makeFrameShape(
	group: PositionedGroup,
	index: string,
	pageId: string,
): TldrRecord {
	return {
		id: `shape:frame-${group.id}`,
		typeName: 'shape',
		type: 'frame',
		x: group.x,
		y: group.y,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		parentId: pageId,
		index,
		props: {
			w: group.width,
			h: group.height,
			name: group.label,
		},
		meta: {},
	};
}

/** Create a geo shape record with role-aware visual properties */
function makeGeoShape(
	node: PositionedNode,
	index: string,
	parentId: string,
): TldrRecord {
	const geo = node.shape ? (ROLE_SHAPE_MAP[node.shape] || 'rectangle') : 'rectangle';
	const color = node.color
		|| (node.role ? ROLE_COLOR_MAP[node.role] : undefined)
		|| TYPE_COLOR_MAP[node.type]
		|| 'black';
	const text = node.label || (node.parent ? `${node.parent}.${node.name}()` : `${node.name}()`);

	return {
		id: `shape:${node.id}`,
		typeName: 'shape',
		type: 'geo',
		x: node.x,
		y: node.y,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		parentId,
		index,
		props: {
			geo,
			w: node.width,
			h: node.height,
			text,
			color,
			size: 's',
			font: 'mono',
			dash: 'solid',
			fill: 'semi',
			align: 'middle',
			verticalAlign: 'middle',
			growY: 0,
			labelColor: 'black',
			url: '',
			scale: 1,
		},
		meta: {
			sourceLine: node.line,
			sourceType: node.type,
			sourceName: node.name,
			...(node.role ? { role: node.role } : {}),
		},
	};
}

/** Create an arrow shape record with optional label and style */
function makeArrowShape(
	arrowId: string,
	index: string,
	pageId: string,
	edge: CodeEdge,
): TldrRecord {
	const dash = edge.style ? (EDGE_DASH_MAP[edge.style] || 'solid') : 'solid';

	return {
		id: `shape:${arrowId}`,
		typeName: 'shape',
		type: 'arrow',
		x: 0,
		y: 0,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		parentId: pageId,
		index,
		props: {
			dash,
			size: 'm',
			fill: 'none',
			color: 'black',
			labelColor: 'black',
			bend: 0,
			start: { x: 0, y: 0 },
			end: { x: 0, y: 0 },
			arrowheadStart: 'none',
			arrowheadEnd: 'arrow',
			text: edge.label || '',
			labelPosition: 0.5,
			font: 'sans',
			scale: 1,
		},
		meta: {},
	};
}

/** Create a binding record connecting an arrow to a shape */
function makeBinding(
	bindingId: string,
	arrowShapeId: string,
	targetShapeId: string,
	terminal: 'start' | 'end',
): TldrRecord {
	return {
		id: `binding:${bindingId}`,
		typeName: 'binding',
		type: 'arrow',
		fromId: `shape:${arrowShapeId}`,
		toId: `shape:${targetShapeId}`,
		props: {
			terminal,
			normalizedAnchor: terminal === 'start'
				? { x: 0.5, y: 1.0 }
				: { x: 0.5, y: 0.0 },
			isExact: false,
			isPrecise: false,
		},
		meta: {},
	};
}

/**
 * Generate a complete .tldr file from a call graph.
 * Produces valid JSON compatible with the official tldraw VS Code extension.
 *
 * If `layout` is provided (from dagre layout), uses those positions.
 * Accepts either a LayoutResult or a PositionedNode[] for backward compat.
 * Otherwise falls back to a simple grid layout.
 */
export function generateTldr(
	graph: CallGraph,
	meta?: Partial<TldrawVizMeta>,
	layout?: LayoutResult | PositionedNode[],
): TldrFile {
	const pageId = 'page:page';
	const records: TldrRecord[] = [];

	// Document record — gridSize is required by tldraw's validator
	records.push({
		id: 'document:document',
		typeName: 'document',
		gridSize: 10,
		name: '',
		meta: {
			tldrawViz: {
				sourceFile: meta?.sourceFile || graph.fileName,
				sourceHash: meta?.sourceHash || '',
				generatedAt: meta?.generatedAt || new Date().toISOString(),
				generatorVersion: meta?.generatorVersion || '0.6.0',
				type: meta?.type || 'file',
			} satisfies TldrawVizMeta,
		},
	});

	// Page record
	records.push({
		id: pageId,
		typeName: 'page',
		name: 'Page 1',
		index: 'a1',
		meta: {},
	});

	// Resolve layout
	const layoutResult: LayoutResult | null = layout
		? (Array.isArray(layout) ? { nodes: layout, groups: [] } : layout)
		: null;
	const positioned = layoutResult?.nodes || layoutNodes(graph);
	const groups = layoutResult?.groups || [];

	// Build a set of node IDs to their group for parent assignment
	const nodeToFrame = new Map<string, string>();

	let shapeIndex = 0;

	// Create frame shapes for groups first (so child shapes can reference them)
	for (const group of groups) {
		records.push(makeFrameShape(group, makeIndex(shapeIndex++), pageId));
		for (const nodeId of group.nodeIds) {
			nodeToFrame.set(nodeId, `shape:frame-${group.id}`);
		}
	}

	// Create geo shapes for each node
	for (const node of positioned) {
		const parentShapeId = nodeToFrame.get(node.id) || pageId;
		// If node is inside a frame, make coordinates relative to the frame
		let x = node.x;
		let y = node.y;
		if (parentShapeId !== pageId) {
			const group = groups.find(g => `shape:frame-${g.id}` === parentShapeId);
			if (group) {
				x = node.x - group.x;
				y = node.y - group.y;
			}
		}
		const adjusted = { ...node, x, y };
		records.push(makeGeoShape(adjusted, makeIndex(shapeIndex++), parentShapeId));
	}

	// Create arrows and bindings for each edge
	const nodeIdSet = new Set(graph.nodes.map(n => n.id));
	for (const edge of graph.edges) {
		if (!nodeIdSet.has(edge.from) || !nodeIdSet.has(edge.to)) continue;

		const arrowId = `arrow-${edge.from}-${edge.to}`;
		records.push(makeArrowShape(arrowId, makeIndex(shapeIndex++), pageId, edge));
		records.push(makeBinding(`${arrowId}-start`, arrowId, edge.from, 'start'));
		records.push(makeBinding(`${arrowId}-end`, arrowId, edge.to, 'end'));
	}

	return {
		tldrawFileFormatVersion: 1,
		schema: {
			schemaVersion: 2,
			sequences: {
				'com.tldraw.store': 4,
				'com.tldraw.asset': 1,
				'com.tldraw.camera': 1,
				'com.tldraw.document': 2,
				'com.tldraw.instance': 25,
				'com.tldraw.instance_page_state': 5,
				'com.tldraw.page': 1,
				'com.tldraw.pointer': 1,
				'com.tldraw.instance_presence': 5,
				'com.tldraw.shape': 4,
				'com.tldraw.shape.arrow': 5,
				'com.tldraw.shape.frame': 0,
				'com.tldraw.shape.geo': 9,
				'com.tldraw.shape.text': 2,
				'com.tldraw.binding': 0,
				'com.tldraw.binding.arrow': 0,
			},
		},
		records,
	};
}

/** Serialize a TldrFile to a formatted JSON string */
export function serializeTldr(file: TldrFile): string {
	return JSON.stringify(file, null, '\t');
}
