import type { CallGraph, CodeNode, CodeEdge } from './types';
import type { LanguageConfig } from './languages';
import type { ProjectGraph } from './ProjectAnalyzer';

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

/** Common mermaid style instructions included in both prompt types */
function getMermaidStyleInstructions(): string[] {
	return [
		'',
		'## Mermaid formatting requirements',
		'',
		'Start the diagram with:',
		'```',
		'%%{init: {"flowchart": {"htmlLabels": true, "curve": "basis"}} }%%',
		'flowchart TD',
		'```',
		'',
		'Include these classDef styles at the end:',
		'```',
		'classDef userAction fill:#E3F2FD,stroke:#1565C0,color:#0D47A1',
		'classDef process fill:#F3E5F5,stroke:#7B1FA2,color:#4A148C',
		'classDef callback fill:#FFF3E0,stroke:#E65100,color:#BF360C',
		'classDef decision fill:#EDE7F6,stroke:#4527A0,color:#311B92',
		'classDef display fill:#E8F5E9,stroke:#2E7D32,color:#1B5E20',
		'classDef parent fill:#ECEFF1,stroke:#546E7A,color:#37474F',
		'classDef hidden fill:#FAFAFA,stroke:#BDBDBD,color:#757575',
		'```',
		'',
		'Assign classes to every node using `class nodeId className`.',
		'',
		'## Shape conventions',
		'- Stadium shapes `([text])` for user-facing actions → class `userAction`',
		'- Diamond shapes `{text}` for decisions/conditionals → class `decision`',
		'- Rectangle shapes `[text]` for processing steps → class `process`',
		'- Hexagon shapes `{{text}}` for callbacks/event handlers → class `callback`',
		'- Use subgraphs for logical groupings',
		'- Use labeled edges `-->|label|` for data flow descriptions',
		'- Use dotted edges `-.->` for async/callback flows',
		'- Use thick edges `==>` for primary/critical paths',
	];
}

/**
 * Generate a Claude prompt for a HIGH-LEVEL BEHAVIORAL overview.
 * Focuses on what the code does from a user/data perspective (5-10 nodes).
 */
export function generateOverviewPrompt(
	graph: CallGraph,
	sourceContent: string,
	config: LanguageConfig,
): string {
	const summary = generateSummary(graph, sourceContent, config);

	const lines: string[] = [];

	lines.push('Generate a HIGH-LEVEL BEHAVIORAL mermaid flowchart for this file.');
	lines.push('');
	lines.push('## Goal');
	lines.push('Describe what this code DOES from a user/data perspective, NOT how it is implemented.');
	lines.push('Use 5-10 nodes maximum — one per major behavior, not per function.');
	lines.push('Labels should be human-readable actions (e.g. "User picks a date", "Calculate sun position"), not function names.');
	lines.push('Group by user-visible concerns (e.g. "User Interactions", "Data Processing", "Display").');
	lines.push('');
	lines.push('## Source analysis');
	lines.push('');
	lines.push(summary);

	lines.push(...getMermaidStyleInstructions());

	lines.push('');
	lines.push('## Important');
	lines.push('- Return ONLY the mermaid code block, no explanation');
	lines.push('- Keep it high-level: merge implementation details into behavioral steps');
	lines.push('- Every node must have a class assignment');

	return lines.join('\n');
}

/**
 * Generate a Claude prompt for a DETAILED function-level flow.
 * Shows every function call chain and data transformation.
 */
export function generateDetailPrompt(
	graph: CallGraph,
	sourceContent: string,
	config: LanguageConfig,
): string {
	const summary = generateSummary(graph, sourceContent, config);

	const lines: string[] = [];

	lines.push('Generate a DETAILED function-level mermaid flowchart for this file.');
	lines.push('');
	lines.push('## Goal');
	lines.push('Show every function call chain and data transformation in detail.');
	lines.push('Include all intermediate steps, conditionals, and edge cases.');
	lines.push('Each function or significant expression gets its own node.');
	lines.push('Labels should include function names with brief descriptions (e.g. "parseDate — extract Date from picker").');
	lines.push('Group functions by their parent class/module or logical area.');
	lines.push('');
	lines.push('## Source analysis');
	lines.push('');
	lines.push(summary);

	lines.push(...getMermaidStyleInstructions());

	lines.push('');
	lines.push('## Important');
	lines.push('- Return ONLY the mermaid code block, no explanation');
	lines.push('- Be thorough: every function, every branch, every callback');
	lines.push('- Every node must have a class assignment');

	return lines.join('\n');
}

/**
 * Generate a Claude prompt for a PROJECT-LEVEL architecture diagram.
 * When documentation is available, produces a feature-level prompt.
 * Otherwise falls back to module-structure prompt.
 */
export function generateProjectPrompt(projectGraph: ProjectGraph): string {
	if (projectGraph.documentation?.hasDocumentation) {
		return generateFeatureLevelPrompt(projectGraph);
	}
	return generateModuleStructurePrompt(projectGraph);
}

/**
 * Feature-level prompt using project documentation as primary context.
 * Produces diagrams showing capabilities, data flows, and integrations.
 */
function generateFeatureLevelPrompt(projectGraph: ProjectGraph): string {
	const lines: string[] = [];
	const docs = projectGraph.documentation!;

	lines.push('Generate a FEATURE-LEVEL ARCHITECTURE mermaid flowchart.');
	lines.push('');
	lines.push('## Goal');
	lines.push('Show what this project DOES — its features, capabilities, data flows, and external integrations.');
	lines.push('DO NOT show file structure or directory layout.');
	lines.push('Each subgraph should represent a FEATURE or CAPABILITY (e.g. "Authentication", "Real-time Sync", "Payment Processing"), not a directory.');
	lines.push('Nodes inside subgraphs should be key behaviors or data flows (e.g. "Validate credentials", "Sync to cloud", "Process webhook").');
	lines.push('Show how features connect to each other and to external services.');
	lines.push('');

	lines.push(`## Project: ${projectGraph.projectName}`);
	lines.push('');

	lines.push('## Project documentation (PRIMARY context)');
	lines.push('');
	lines.push('Use the following project documentation to understand what this project does,');
	lines.push('its architecture rationale, and its feature set:');
	lines.push('');
	lines.push(docs.combinedContent);
	lines.push('');

	// Include structural analysis as secondary context
	lines.push('## Code structure (SUPPLEMENTARY context)');
	lines.push('');
	lines.push(`Modules: ${projectGraph.modules.map(m => `${m.name} (${m.fileCount} files)`).join(', ')}`);
	lines.push('');

	if (projectGraph.dependencies.length > 0) {
		lines.push('Key dependency relationships:');
		const sorted = [...projectGraph.dependencies].sort((a, b) => b.importCount - a.importCount);
		for (const dep of sorted.slice(0, 15)) {
			const symbolStr = dep.importedSymbols.length > 0
				? ` (${dep.importedSymbols.join(', ')})`
				: '';
			lines.push(`  ${dep.from} -> ${dep.to}${symbolStr}`);
		}
		lines.push('');
	}

	lines.push(...getMermaidStyleInstructions());

	lines.push('');
	lines.push('## Additional architecture styles');
	lines.push('Add these classDef styles:');
	lines.push('```');
	lines.push('classDef feature fill:#E8EAF6,stroke:#283593,color:#1A237E');
	lines.push('classDef external fill:#FFF8E1,stroke:#F57F17,color:#E65100');
	lines.push('classDef dataStore fill:#E0F2F1,stroke:#00695C,color:#004D40');
	lines.push('classDef integration fill:#FCE4EC,stroke:#C62828,color:#B71C1C');
	lines.push('```');
	lines.push('');

	lines.push('## Important');
	lines.push('- Return ONLY the mermaid code block, no explanation');
	lines.push('- Use subgraphs for each FEATURE or CAPABILITY, NOT for directories or modules');
	lines.push('- Label subgraphs with feature names (e.g. "Authentication & Authorization", "Data Pipeline")');
	lines.push('- Show external services (databases, APIs, third-party services) as standalone nodes with class `external` or `integration`');
	lines.push('- Use thick arrows (==>) for primary data flows');
	lines.push('- Use dotted arrows (-.->)  for async or event-driven connections');
	lines.push('- Use labeled edges to describe what data flows between features');
	lines.push('- Aim for 8-15 subgraphs with 2-5 nodes each');
	lines.push('- Every node must have a class assignment');

	return lines.join('\n');
}

/** Fallback: module-structure diagram when no docs available */
function generateModuleStructurePrompt(projectGraph: ProjectGraph): string {
	const lines: string[] = [];

	lines.push('Generate a PROJECT-LEVEL ARCHITECTURE mermaid flowchart.');
	lines.push('');
	lines.push('## Goal');
	lines.push('Show the high-level module structure of this project.');
	lines.push('Each module should be a subgraph containing its key exported components (top 5).');
	lines.push('Show dependency arrows between modules based on import relationships.');
	lines.push('Labels should be human-readable (e.g. "Authentication", "API Layer", "Data Models").');
	lines.push('');
	lines.push(`## Project: ${projectGraph.projectName}`);
	lines.push('');

	lines.push('## Modules');
	lines.push('');
	for (const mod of projectGraph.modules) {
		lines.push(`### ${mod.name} (${mod.fileCount} files)`);
		if (mod.description) {
			lines.push(`  Description: ${mod.description}`);
		}
		if (mod.exports.length > 0) {
			const shown = mod.exports.slice(0, 10);
			lines.push(`  Key exports: ${shown.join(', ')}${mod.exports.length > 10 ? '...' : ''}`);
		}
		lines.push('');
	}

	lines.push('## Dependencies');
	lines.push('');
	for (const dep of projectGraph.dependencies) {
		const symbolStr = dep.importedSymbols.length > 0
			? ` (uses: ${dep.importedSymbols.join(', ')})`
			: '';
		lines.push(`  ${dep.from} --> ${dep.to} [${dep.importCount} imports]${symbolStr}`);
	}
	lines.push('');

	lines.push(...getMermaidStyleInstructions());

	lines.push('');
	lines.push('## Additional module-level styles');
	lines.push('Add these classDef styles:');
	lines.push('```');
	lines.push('classDef module fill:#E8EAF6,stroke:#283593,color:#1A237E');
	lines.push('classDef external fill:#FFF8E1,stroke:#F57F17,color:#E65100');
	lines.push('```');
	lines.push('');
	lines.push('## Important');
	lines.push('- Return ONLY the mermaid code block, no explanation');
	lines.push('- Use subgraphs for each module, with key components as nodes inside');
	lines.push('- Show dependency arrows between modules with labels describing the relationship');
	lines.push('- Use thick arrows (==>) for heavy dependencies (3+ imports)');
	lines.push('- Use dotted arrows (-.->)  for light dependencies (1 import)');
	lines.push('- Every node must have a class assignment');

	return lines.join('\n');
}

/**
 * Generate a full Claude prompt that wraps the structural summary with
 * instructions for producing a mermaid flowchart.
 * @deprecated Use generateOverviewPrompt() or generateDetailPrompt() instead.
 */
export function generateClaudePrompt(
	graph: CallGraph,
	sourceContent: string,
	config: LanguageConfig,
): string {
	return generateOverviewPrompt(graph, sourceContent, config);
}
