/** Shape types that mermaid flowchart syntax supports */
export type MermaidShape =
	| 'rectangle'
	| 'stadium'
	| 'diamond'
	| 'circle'
	| 'asymmetric'
	| 'subroutine'
	| 'hexagon'
	| 'parallelogram'
	| 'trapezoid'
	| 'double-circle';

/** Edge line style */
export type MermaidEdgeStyle = 'solid' | 'dotted' | 'thick';

/** Flowchart direction */
export type MermaidDirection = 'TD' | 'TB' | 'LR' | 'BT' | 'RL';

export interface MermaidNode {
	id: string;
	label: string;
	shape: MermaidShape;
}

export interface MermaidEdge {
	from: string;
	to: string;
	label?: string;
	style: MermaidEdgeStyle;
}

export interface MermaidSubgraph {
	id: string;
	label: string;
	nodeIds: string[];
}

export interface MermaidGraph {
	direction: MermaidDirection;
	nodes: MermaidNode[];
	edges: MermaidEdge[];
	subgraphs: MermaidSubgraph[];
}

/**
 * Parse a node definition and return shape + label.
 * Handles: [text], ([text]), {text}, ((text)), >text], [[text]], {{text}}, [/text/], [\text\]
 */
function parseNodeDef(raw: string): { label: string; shape: MermaidShape } | null {
	const s = raw.trim();
	if (!s) return null;

	// Double-circle: ((text))
	if (s.startsWith('((') && s.endsWith('))')) {
		return { label: s.slice(2, -2).trim(), shape: 'double-circle' };
	}
	// Stadium/pill: ([text])
	if (s.startsWith('([') && s.endsWith('])')) {
		return { label: s.slice(2, -2).trim(), shape: 'stadium' };
	}
	// Hexagon: {{text}}
	if (s.startsWith('{{') && s.endsWith('}}')) {
		return { label: s.slice(2, -2).trim(), shape: 'hexagon' };
	}
	// Subroutine: [[text]]
	if (s.startsWith('[[') && s.endsWith(']]')) {
		return { label: s.slice(2, -2).trim(), shape: 'subroutine' };
	}
	// Circle: (text)  — single parens, NOT stadium
	if (s.startsWith('(') && s.endsWith(')') && !s.startsWith('([')) {
		return { label: s.slice(1, -1).trim(), shape: 'circle' };
	}
	// Diamond: {text}
	if (s.startsWith('{') && s.endsWith('}') && !s.startsWith('{{')) {
		return { label: s.slice(1, -1).trim(), shape: 'diamond' };
	}
	// Asymmetric: >text]
	if (s.startsWith('>') && s.endsWith(']')) {
		return { label: s.slice(1, -1).trim(), shape: 'asymmetric' };
	}
	// Parallelogram: [/text/]
	if (s.startsWith('[/') && s.endsWith('/]')) {
		return { label: s.slice(2, -2).trim(), shape: 'parallelogram' };
	}
	// Trapezoid: [\text\]
	if (s.startsWith('[\\') && s.endsWith('\\]')) {
		return { label: s.slice(2, -2).trim(), shape: 'trapezoid' };
	}
	// Rectangle: [text]
	if (s.startsWith('[') && s.endsWith(']')) {
		return { label: s.slice(1, -1).trim(), shape: 'rectangle' };
	}

	return null;
}

/**
 * Register a node (deduplicate by id).
 */
function registerNode(
	nodeMap: Map<string, MermaidNode>,
	id: string,
	label?: string,
	shape?: MermaidShape,
): void {
	if (!nodeMap.has(id)) {
		nodeMap.set(id, {
			id,
			label: label || id,
			shape: shape || 'rectangle',
		});
	} else if (label && label !== id) {
		// Update label/shape if we now have a richer definition
		const existing = nodeMap.get(id)!;
		existing.label = label;
		if (shape) existing.shape = shape;
	}
}

/**
 * Try to parse an inline node reference (id + optional shape definition).
 * Returns the node id and optionally registers the node.
 *
 * Patterns:
 *   nodeId             — bare id
 *   nodeId[label]      — rectangle
 *   nodeId([label])    — stadium
 *   nodeId{label}      — diamond
 *   nodeId((label))    — circle
 */
function parseInlineNode(
	token: string,
	nodeMap: Map<string, MermaidNode>,
): string {
	// Strip :::className suffix before parsing
	const t = token.trim().replace(/:::\w+$/, '').trim();
	if (!t) return t;

	// Find where the shape definition starts
	const shapeStarts = ['([', '((', '{{', '[[', '[/', '[\\', '[', '(', '{', '>'];
	for (const start of shapeStarts) {
		const idx = t.indexOf(start);
		if (idx > 0) {
			const id = t.slice(0, idx).trim();
			const rest = t.slice(idx);
			const def = parseNodeDef(rest);
			if (def) {
				registerNode(nodeMap, id, def.label, def.shape);
				return id;
			}
		}
	}

	// Bare node id (strip any remaining :::className)
	registerNode(nodeMap, t);
	return t;
}

// Edge patterns: -->, -.-> , ==>, --->, ====>, --text-->, -.text.->
const EDGE_REGEX = /^(.+?)\s+(-->|-.->|==>|--+>|={2,}>|--[^-].*?-->|-..*?\.->)\s*(\|[^|]*\|)?\s*(.+)$/;

// Alternative: edge label can also be between the arrow parts
const EDGE_WITH_INLINE_LABEL = /^(.+?)\s+--\s*([^-|>].*?)\s*-->\s*(.+)$/;
const EDGE_DOTTED_INLINE_LABEL = /^(.+?)\s+-\.\s*([^.>].*?)\s*\.->\s*(.+)$/;
const EDGE_THICK_INLINE_LABEL = /^(.+?)\s+==\s*([^=>].*?)\s*==>\s*(.+)$/;

/**
 * Parse a mermaid flowchart source string into a MermaidGraph.
 */
export function parseMermaid(source: string): MermaidGraph {
	const nodeMap = new Map<string, MermaidNode>();
	const edges: MermaidEdge[] = [];
	const subgraphs: MermaidSubgraph[] = [];

	// Subgraph stack: each entry tracks current subgraph being built
	const subgraphStack: MermaidSubgraph[] = [];

	let direction: MermaidDirection = 'TD';

	const lines = source.split('\n');

	for (const rawLine of lines) {
		const line = rawLine.trim();

		// Skip empty lines
		if (!line) continue;

		// Skip comments
		if (line.startsWith('%%')) continue;

		// Skip classDef and class lines
		if (line.startsWith('classDef ') || line.startsWith('class ')) continue;

		// Skip style lines
		if (line.startsWith('style ')) continue;

		// Skip click lines
		if (line.startsWith('click ')) continue;

		// Detect flowchart header
		if (/^(?:flowchart|graph)\s+(TD|TB|LR|BT|RL)/i.test(line)) {
			const match = line.match(/^(?:flowchart|graph)\s+(TD|TB|LR|BT|RL)/i)!;
			direction = match[1].toUpperCase() as MermaidDirection;
			continue;
		}

		// Skip bare "flowchart" or "graph" without direction
		if (/^(?:flowchart|graph)\s*$/i.test(line)) continue;

		// Subgraph start
		const subgraphMatch = line.match(/^subgraph\s+(\S+?)(?:\[(.+?)\])?\s*$/);
		if (subgraphMatch) {
			const sgId = subgraphMatch[1];
			const sgLabel = subgraphMatch[2] || sgId;
			subgraphStack.push({ id: sgId, label: sgLabel, nodeIds: [] });
			continue;
		}

		// Subgraph end
		if (line === 'end') {
			const sg = subgraphStack.pop();
			if (sg) {
				subgraphs.push(sg);
			}
			continue;
		}

		// Try to parse as edge line
		if (tryParseEdge(line, nodeMap, edges, subgraphStack)) {
			continue;
		}

		// Try to parse as standalone node definition
		tryParseNodeDef(line, nodeMap, subgraphStack);
	}

	return {
		direction,
		nodes: Array.from(nodeMap.values()),
		edges,
		subgraphs,
	};
}

/**
 * Try to parse a line as one or more edges (chained: A --> B --> C).
 * Returns true if at least one edge was found.
 */
function tryParseEdge(
	line: string,
	nodeMap: Map<string, MermaidNode>,
	edges: MermaidEdge[],
	subgraphStack: MermaidSubgraph[],
): boolean {
	// Arrow patterns to split on
	const arrowPattern = /\s+(-->|-.->|==>)\s*(\|[^|]*\|)?\s*/;

	// Check if line contains any arrow
	if (!arrowPattern.test(line)) {
		// Also check inline label arrows: --text--> , -.text.-> , ==text==>
		if (/--[^>].*?-->/.test(line) || /-\..*?\.\->/.test(line) || /==[^>].*?==>/.test(line)) {
			return tryParseInlineLabelEdge(line, nodeMap, edges, subgraphStack);
		}
		return false;
	}

	// Split chained edges: A --> B --> C
	const parts: string[] = [];
	const arrows: { style: MermaidEdgeStyle; label?: string }[] = [];

	let remaining = line;
	while (true) {
		// Try inline label arrows first
		const inlineMatch = remaining.match(/^(.+?)\s+--\s*([^-|>].*?)\s*-->\s*(.+)$/);
		if (inlineMatch) {
			parts.push(inlineMatch[1].trim());
			arrows.push({ style: 'solid', label: inlineMatch[2].trim() });
			remaining = inlineMatch[3].trim();
			continue;
		}

		const match = remaining.match(/^(.+?)\s+(-->|-.->|==>)\s*(?:\|([^|]*)\|)?\s*(.+)$/);
		if (match) {
			parts.push(match[1].trim());
			const arrowStr = match[2];
			const label = match[3]?.trim();
			const style: MermaidEdgeStyle =
				arrowStr === '-.->' ? 'dotted' :
					arrowStr === '==>' ? 'thick' : 'solid';
			arrows.push({ style, label: label || undefined });
			remaining = match[4].trim();
		} else {
			parts.push(remaining.trim());
			break;
		}
	}

	if (parts.length < 2) return false;

	// Register nodes and create edges
	for (let i = 0; i < parts.length; i++) {
		const nodeId = parseInlineNode(parts[i], nodeMap);
		addToCurrentSubgraph(nodeId, subgraphStack);

		if (i > 0) {
			edges.push({
				from: parseInlineNode(parts[i - 1], nodeMap),
				to: nodeId,
				label: arrows[i - 1]?.label,
				style: arrows[i - 1]?.style || 'solid',
			});
		}
	}

	return true;
}

/**
 * Handle edges with inline labels: A --text--> B
 */
function tryParseInlineLabelEdge(
	line: string,
	nodeMap: Map<string, MermaidNode>,
	edges: MermaidEdge[],
	subgraphStack: MermaidSubgraph[],
): boolean {
	// Solid with inline label: A --text--> B
	let match = line.match(EDGE_WITH_INLINE_LABEL);
	if (match) {
		const from = parseInlineNode(match[1].trim(), nodeMap);
		const to = parseInlineNode(match[3].trim(), nodeMap);
		addToCurrentSubgraph(from, subgraphStack);
		addToCurrentSubgraph(to, subgraphStack);
		edges.push({ from, to, label: match[2].trim(), style: 'solid' });
		return true;
	}

	// Dotted with inline label: A -.text.-> B
	match = line.match(EDGE_DOTTED_INLINE_LABEL);
	if (match) {
		const from = parseInlineNode(match[1].trim(), nodeMap);
		const to = parseInlineNode(match[3].trim(), nodeMap);
		addToCurrentSubgraph(from, subgraphStack);
		addToCurrentSubgraph(to, subgraphStack);
		edges.push({ from, to, label: match[2].trim(), style: 'dotted' });
		return true;
	}

	// Thick with inline label: A ==text==> B
	match = line.match(EDGE_THICK_INLINE_LABEL);
	if (match) {
		const from = parseInlineNode(match[1].trim(), nodeMap);
		const to = parseInlineNode(match[3].trim(), nodeMap);
		addToCurrentSubgraph(from, subgraphStack);
		addToCurrentSubgraph(to, subgraphStack);
		edges.push({ from, to, label: match[2].trim(), style: 'thick' });
		return true;
	}

	return false;
}

/**
 * Try to parse a line as a standalone node definition.
 */
function tryParseNodeDef(
	line: string,
	nodeMap: Map<string, MermaidNode>,
	subgraphStack: MermaidSubgraph[],
): boolean {
	// Strip :::className suffix before parsing
	const stripped = line.replace(/:::\w+$/, '').trim();
	// Match: nodeId[label], nodeId([label]), nodeId{label}, etc.
	const shapeStarts = ['([', '((', '{{', '[[', '[/', '[\\', '[', '(', '{', '>'];
	for (const start of shapeStarts) {
		const idx = stripped.indexOf(start);
		if (idx > 0) {
			const id = stripped.slice(0, idx).trim();
			// Validate id is a simple identifier (no spaces or operators)
			if (/^[\w-]+$/.test(id)) {
				const rest = stripped.slice(idx);
				const def = parseNodeDef(rest);
				if (def) {
					registerNode(nodeMap, id, def.label, def.shape);
					addToCurrentSubgraph(id, subgraphStack);
					return true;
				}
			}
		}
	}

	return false;
}

/**
 * Add a node to the current (innermost) subgraph if inside one.
 */
function addToCurrentSubgraph(nodeId: string, stack: MermaidSubgraph[]): void {
	if (stack.length > 0) {
		const current = stack[stack.length - 1];
		if (!current.nodeIds.includes(nodeId)) {
			current.nodeIds.push(nodeId);
		}
	}
}
