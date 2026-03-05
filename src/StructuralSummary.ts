import type { CallGraph, CodeNode, CodeEdge } from './types';
import type { LanguageConfig } from './languages';

/**
 * Extract React-specific details from source content using regex.
 * This supplements the AST-based call graph with JSX/React patterns.
 */
function extractReactDetails(sourceContent: string): {
	propsInterface: string | null;
	eventHandlers: string[];
	callbackProps: string[];
} {
	// Search for Props interface or type definition
	let propsInterface: string | null = null;
	const propsMatch = sourceContent.match(
		/(?:interface|type)\s+(\w*Props\w*)\s*[={]/,
	);
	if (propsMatch) {
		// Grab the full interface/type block (up to matching closing brace)
		const startIdx = sourceContent.indexOf(propsMatch[0]);
		let braceCount = 0;
		let endIdx = startIdx;
		let foundOpen = false;
		for (let i = startIdx; i < sourceContent.length; i++) {
			if (sourceContent[i] === '{') {
				braceCount++;
				foundOpen = true;
			} else if (sourceContent[i] === '}') {
				braceCount--;
			}
			if (foundOpen && braceCount === 0) {
				endIdx = i + 1;
				break;
			}
		}
		propsInterface = sourceContent.slice(startIdx, endIdx).trim();
	}

	// Search for JSX event handlers like onClick=, onChange=, onSubmit=
	const eventHandlerRegex = /on[A-Z]\w+=/g;
	const handlerMatches = sourceContent.match(eventHandlerRegex) || [];
	const eventHandlers = [...new Set(handlerMatches.map((h) => h.replace('=', '')))];

	// Search for callback props (props that start with on + uppercase letter)
	const callbackProps: string[] = [];
	if (propsInterface) {
		const callbackPropRegex = /\b(on[A-Z]\w*)\s*[?:]?\s*:/g;
		let match: RegExpExecArray | null;
		while ((match = callbackPropRegex.exec(propsInterface)) !== null) {
			callbackProps.push(match[1]);
		}
	}

	return { propsInterface, eventHandlers, callbackProps };
}

/**
 * Build the calls list for a given node based on the call graph edges.
 */
function getCallsForNode(node: CodeNode, edges: CodeEdge[], nodes: CodeNode[]): string[] {
	const nodeMap = new Map(nodes.map((n) => [n.id, n]));
	return edges
		.filter((e) => e.from === node.id)
		.map((e) => {
			const target = nodeMap.get(e.to);
			return target ? target.name : e.to;
		});
}

/**
 * Generate a compact structural summary of the call graph.
 *
 * This produces a text summary describing the functions, call relationships,
 * and groupings in the source file. It is intended to be used as context
 * for generating mermaid flowcharts.
 */
export function generateSummary(
	graph: CallGraph,
	sourceContent: string,
	config: LanguageConfig,
): string {
	const lines: string[] = [];

	lines.push(`File: ${graph.fileName}`);
	lines.push(`Language: ${graph.language}`);
	lines.push('');

	// Functions/Methods section
	if (graph.nodes.length > 0) {
		lines.push('Functions/Methods:');
		for (const node of graph.nodes) {
			const calls = getCallsForNode(node, graph.edges, graph.nodes);
			const callsStr = calls.length > 0 ? calls.join(', ') : 'none';
			const prefix = node.parent ? `${node.parent}.` : '';
			lines.push(`  - ${prefix}${node.name} (line ${node.line}) - calls: [${callsStr}]`);
		}
		lines.push('');
	}

	// Call relationships section
	if (graph.edges.length > 0) {
		const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
		lines.push('Call relationships:');
		for (const edge of graph.edges) {
			const fromNode = nodeMap.get(edge.from);
			const toNode = nodeMap.get(edge.to);
			const fromName = fromNode ? fromNode.name : edge.from;
			const toName = toNode ? toNode.name : edge.to;
			const label = edge.label ? ` (${edge.label})` : '';
			lines.push(`  ${fromName} \u2192 ${toName}${label}`);
		}
		lines.push('');
	}

	// Groups section
	if (graph.groups && graph.groups.length > 0) {
		const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
		lines.push('Groups:');
		for (const group of graph.groups) {
			const memberNames = group.nodeIds
				.map((id) => {
					const node = nodeMap.get(id);
					return node ? node.name : id;
				})
				.join(', ');
			lines.push(`  - ${group.label}: [${memberNames}]`);
		}
		lines.push('');
	}

	// React-specific details for TSX files
	if (graph.language === 'typescriptreact') {
		const reactDetails = extractReactDetails(sourceContent);

		if (reactDetails.propsInterface) {
			lines.push('Props interface:');
			// Indent each line of the props interface
			for (const propLine of reactDetails.propsInterface.split('\n')) {
				lines.push(`  ${propLine}`);
			}
			lines.push('');
		}

		if (reactDetails.eventHandlers.length > 0) {
			lines.push(`JSX event handlers: ${reactDetails.eventHandlers.join(', ')}`);
		}

		if (reactDetails.callbackProps.length > 0) {
			lines.push(`Callback props: ${reactDetails.callbackProps.join(', ')}`);
		}

		if (reactDetails.eventHandlers.length > 0 || reactDetails.callbackProps.length > 0) {
			lines.push('');
		}
	}

	return lines.join('\n').trimEnd();
}

/**
 * Generate a full Claude prompt that wraps the structural summary with
 * instructions for producing a mermaid flowchart.
 */
export function generateClaudePrompt(
	graph: CallGraph,
	sourceContent: string,
	config: LanguageConfig,
): string {
	const summary = generateSummary(graph, sourceContent, config);

	const lines: string[] = [];

	lines.push('Generate a mermaid flowchart for this file:');
	lines.push('');
	lines.push(summary);
	lines.push('');
	lines.push('Please use:');
	lines.push('- Stadium shapes ([text]) for user-facing actions');
	lines.push('- Diamond shapes {text} for decisions/conditionals');
	lines.push('- Rectangle shapes [text] for processing steps');
	lines.push('- Subgraphs for logical groupings');
	lines.push('- Labeled edges for data flow descriptions');

	return lines.join('\n');
}
