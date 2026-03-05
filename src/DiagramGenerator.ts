import dagre from '@dagrejs/dagre';
import type { CallGraph, CodeNode, LayoutResult, NodeShape, PositionedGroup, PositionedNode } from './types';

/** Shape-specific dimensions (width × height) */
const SHAPE_DIMENSIONS: Record<NodeShape, { width: number; height: number }> = {
	rectangle: { width: 280, height: 60 },
	diamond: { width: 300, height: 80 },
	ellipse: { width: 280, height: 60 },
	cloud: { width: 300, height: 80 },
	hexagon: { width: 280, height: 60 },
	oval: { width: 240, height: 50 },
};

const DEFAULT_WIDTH = 280;
const DEFAULT_HEIGHT = 60;
const RANK_SEP = 80;
const NODE_SEP = 40;
const GROUP_PADDING = 40;

function getNodeDimensions(node: CodeNode): { width: number; height: number } {
	if (node.shape && SHAPE_DIMENSIONS[node.shape]) {
		return SHAPE_DIMENSIONS[node.shape];
	}
	return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

/**
 * Compute layout positions for call graph nodes using dagre.
 * Supports compound graphs when groups are present.
 * Returns a LayoutResult with positioned nodes and groups.
 */
export function layoutCallGraph(graph: CallGraph): LayoutResult {
	if (graph.nodes.length === 0) return { nodes: [], groups: [] };

	const hasGroups = graph.groups && graph.groups.length > 0;

	const g = new dagre.graphlib.Graph({ compound: hasGroups });
	g.setGraph({
		rankdir: 'TB',
		ranksep: RANK_SEP,
		nodesep: NODE_SEP,
		marginx: 20,
		marginy: 20,
	});
	g.setDefaultEdgeLabel(() => ({}));

	// Add group nodes (compound parents)
	if (hasGroups) {
		for (const group of graph.groups!) {
			g.setNode(group.id, {
				label: group.label,
				clusterLabelPos: 'top',
				style: 'fill: none',
				paddingTop: GROUP_PADDING,
				paddingBottom: GROUP_PADDING / 2,
				paddingLeft: GROUP_PADDING / 2,
				paddingRight: GROUP_PADDING / 2,
			});
		}
	}

	// Add nodes with shape-specific dimensions
	for (const node of graph.nodes) {
		const dims = getNodeDimensions(node);
		g.setNode(node.id, { width: dims.width, height: dims.height });
	}

	// Set parent relationships for grouped nodes
	if (hasGroups) {
		for (const group of graph.groups!) {
			for (const nodeId of group.nodeIds) {
				if (g.hasNode(nodeId)) {
					g.setParent(nodeId, group.id);
				}
			}
		}
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
	const nodes: PositionedNode[] = graph.nodes.map(node => {
		const dagreNode = g.node(node.id);
		const dims = getNodeDimensions(node);
		return {
			...node,
			// dagre returns center coordinates; convert to top-left
			x: dagreNode.x - dims.width / 2,
			y: dagreNode.y - dims.height / 2,
			width: dims.width,
			height: dims.height,
		};
	});

	// Extract group bounding boxes
	const groups: PositionedGroup[] = [];
	if (hasGroups) {
		for (const group of graph.groups!) {
			const dagreGroup = g.node(group.id);
			if (dagreGroup) {
				groups.push({
					...group,
					x: dagreGroup.x - (dagreGroup.width || 0) / 2,
					y: dagreGroup.y - (dagreGroup.height || 0) / 2,
					width: dagreGroup.width || 0,
					height: dagreGroup.height || 0,
				});
			}
		}
	}

	return { nodes, groups };
}
