import dagre from '@dagrejs/dagre';
import type { CallGraph, PositionedNode } from './types';

const NODE_WIDTH = 280;
const NODE_HEIGHT = 60;
const RANK_SEP = 80;
const NODE_SEP = 40;

/**
 * Compute layout positions for call graph nodes using dagre.
 * Uses a top-to-bottom directed graph layout.
 */
export function layoutCallGraph(graph: CallGraph): PositionedNode[] {
	if (graph.nodes.length === 0) return [];

	const g = new dagre.graphlib.Graph();
	g.setGraph({
		rankdir: 'TB',
		ranksep: RANK_SEP,
		nodesep: NODE_SEP,
		marginx: 20,
		marginy: 20,
	});
	g.setDefaultEdgeLabel(() => ({}));

	// Add nodes
	for (const node of graph.nodes) {
		g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
	}

	// Add edges (only for valid node pairs)
	const nodeIds = new Set(graph.nodes.map(n => n.id));
	for (const edge of graph.edges) {
		if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) {
			g.setEdge(edge.from, edge.to);
		}
	}

	dagre.layout(g);

	// Map dagre positions back to our nodes
	return graph.nodes.map(node => {
		const dagreNode = g.node(node.id);
		return {
			...node,
			// dagre returns center coordinates; convert to top-left
			x: dagreNode.x - NODE_WIDTH / 2,
			y: dagreNode.y - NODE_HEIGHT / 2,
			width: NODE_WIDTH,
			height: NODE_HEIGHT,
		};
	});
}
