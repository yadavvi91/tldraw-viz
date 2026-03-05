import type { CallGraph, PositionedNode, TldrFile, TldrRecord, TldrawVizMeta } from './types';

const NODE_WIDTH = 280;
const NODE_HEIGHT = 60;
const RANK_SEP = 80;
const NODE_SEP = 40;

const COLOR_MAP: Record<string, string> = {
	function: 'blue',
	method: 'green',
	class: 'violet',
	interface: 'orange',
	variable: 'yellow',
};

/** Generate a tldraw-compatible index string for ordering */
function makeIndex(i: number): string {
	return `a${i.toString().padStart(4, '0')}`;
}

/**
 * Layout nodes using a simple top-to-bottom grid.
 * For now this is a basic layout; dagre integration comes in Issue #9.
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

/** Create a geo shape record (rectangle with text) */
function makeGeoShape(
	node: PositionedNode,
	index: string,
	pageId: string,
): TldrRecord {
	return {
		id: `shape:${node.id}`,
		typeName: 'shape',
		type: 'geo',
		x: node.x,
		y: node.y,
		rotation: 0,
		isLocked: false,
		opacity: 1,
		parentId: pageId,
		index,
		props: {
			geo: 'rectangle',
			w: node.width,
			h: node.height,
			text: node.parent ? `${node.parent}.${node.name}()` : `${node.name}()`,
			color: COLOR_MAP[node.type] || 'black',
			size: 's',
			font: 'mono',
			dash: 'draw',
			fill: 'semi',
			align: 'middle',
			verticalAlign: 'middle',
			growY: 0,
			labelColor: 'black',
			url: '',
		},
		meta: {
			sourceLine: node.line,
			sourceType: node.type,
			sourceName: node.name,
		},
	};
}

/** Create an arrow shape record */
function makeArrowShape(
	arrowId: string,
	index: string,
	pageId: string,
): TldrRecord {
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
			dash: 'draw',
			size: 'm',
			fill: 'none',
			color: 'black',
			labelColor: 'black',
			bend: 0,
			start: { x: 0, y: 0 },
			end: { x: 0, y: 0 },
			arrowheadStart: 'none',
			arrowheadEnd: 'arrow',
			text: '',
			labelPosition: 0.5,
			font: 'draw',
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
 */
export function generateTldr(
	graph: CallGraph,
	meta?: Partial<TldrawVizMeta>,
): TldrFile {
	const pageId = 'page:page';
	const records: TldrRecord[] = [];

	// Document record
	records.push({
		id: 'document:document',
		typeName: 'document',
		name: '',
		meta: {
			tldrawViz: {
				sourceFile: meta?.sourceFile || graph.fileName,
				sourceHash: meta?.sourceHash || '',
				generatedAt: meta?.generatedAt || new Date().toISOString(),
				generatorVersion: meta?.generatorVersion || '0.1.0',
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

	// Layout nodes
	const positioned = layoutNodes(graph);

	// Create geo shapes for each node
	let shapeIndex = 0;
	for (const node of positioned) {
		records.push(makeGeoShape(node, makeIndex(shapeIndex++), pageId));
	}

	// Create arrows and bindings for each edge
	const nodeIdSet = new Set(graph.nodes.map(n => n.id));
	for (const edge of graph.edges) {
		if (!nodeIdSet.has(edge.from) || !nodeIdSet.has(edge.to)) continue;

		const arrowId = `arrow-${edge.from}-${edge.to}`;
		records.push(makeArrowShape(arrowId, makeIndex(shapeIndex++), pageId));
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
				'com.tldraw.shape': 4,
				'com.tldraw.shape.arrow': 5,
				'com.tldraw.shape.geo': 9,
				'com.tldraw.shape.text': 2,
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
