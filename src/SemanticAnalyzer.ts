import type Parser from 'web-tree-sitter';
import type { LanguageConfig } from './languages';
import type { CallGraph, CodeNode, CodeEdge, NodeGroup } from './types';

/** Display-like function name patterns */
const DISPLAY_PATTERNS = /^(format|render|show|display|print|log|toString|to[A-Z])/;

/** Callback prop name patterns */
const CALLBACK_PROP_PATTERN = /^on[A-Z]/;

// ─── Base Analyzer (any language) ───────────────────────────────────────

/**
 * Base semantic analysis that works for any language.
 * Classifies nodes by graph topology and AST body analysis.
 */
export function analyzeBase(
	graph: CallGraph,
	tree: Parser.Tree,
	config: LanguageConfig,
): CallGraph {
	const incomingCount = new Map<string, number>();
	const outgoingCount = new Map<string, number>();
	for (const node of graph.nodes) {
		incomingCount.set(node.id, 0);
		outgoingCount.set(node.id, 0);
	}
	for (const edge of graph.edges) {
		incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
		outgoingCount.set(edge.from, (outgoingCount.get(edge.from) ?? 0) + 1);
	}

	// Build map of function bodies for conditional detection
	const functionBodies = extractFunctionBodies(tree, config);
	const nodeNames = new Set(graph.nodes.map(n => n.name));

	for (const node of graph.nodes) {
		if (node.type === 'class' || node.type === 'interface') continue;
		if (node.role) continue; // already classified

		const hasIncoming = (incomingCount.get(node.id) ?? 0) > 0;
		const hasOutgoing = (outgoingCount.get(node.id) ?? 0) > 0;

		if (bodyHasConditionalCalls(functionBodies.get(node.name), config, nodeNames)) {
			node.role = 'decision';
			node.shape = 'diamond';
		} else if (!hasIncoming && hasOutgoing) {
			node.role = 'entrypoint';
			node.shape = 'ellipse';
		} else if (!hasOutgoing) {
			node.role = DISPLAY_PATTERNS.test(node.name) ? 'display' : 'process';
			node.shape = 'rectangle';
		} else {
			node.role = 'process';
			node.shape = 'rectangle';
		}
	}

	// Group by class
	const classGroups = groupByClass(graph.nodes);
	if (classGroups.length > 0) {
		graph.groups = [...(graph.groups || []), ...classGroups];
	}

	return graph;
}

/**
 * Extract function body AST nodes keyed by function name.
 */
function extractFunctionBodies(
	tree: Parser.Tree,
	config: LanguageConfig,
): Map<string, Parser.SyntaxNode> {
	const bodies = new Map<string, Parser.SyntaxNode>();
	const allFunctionTypes = new Set([
		...config.functionTypes,
		...config.methodTypes,
	]);

	function walk(node: Parser.SyntaxNode): void {
		if (allFunctionTypes.has(node.type)) {
			let name = node.childForFieldName(config.nameField)?.text;
			if (!name && node.parent?.type === 'variable_declarator') {
				name = node.parent.childForFieldName('name')?.text;
			}
			const body = node.childForFieldName(config.bodyField);
			if (name && body) {
				bodies.set(name, body);
			}
			return;
		}
		for (const child of node.children) {
			walk(child);
		}
	}

	walk(tree.rootNode);
	return bodies;
}

/**
 * Check if a function body contains conditional statements (if/switch/ternary)
 * that gate calls to other known graph nodes.
 */
function bodyHasConditionalCalls(
	body: Parser.SyntaxNode | undefined,
	config: LanguageConfig,
	nodeNames: Set<string>,
): boolean {
	if (!body) return false;

	const conditionalTypes = new Set([
		'if_statement', 'switch_statement', 'ternary_expression',
		'conditional_expression', 'if_expression',
	]);

	let found = false;

	function walk(node: Parser.SyntaxNode): void {
		if (found) return;
		if (conditionalTypes.has(node.type)) {
			// Check if any call inside this conditional references a known node
			if (containsCallToKnownNode(node, config, nodeNames)) {
				found = true;
				return;
			}
		}
		for (const child of node.children) {
			walk(child);
		}
	}

	walk(body);
	return found;
}

function containsCallToKnownNode(
	node: Parser.SyntaxNode,
	config: LanguageConfig,
	nodeNames: Set<string>,
): boolean {
	if (config.callTypes.includes(node.type)) {
		const funcNode = node.childForFieldName(config.callFunctionField);
		if (funcNode) {
			const name = funcNode.type === 'identifier'
				? funcNode.text
				: funcNode.childForFieldName('property')?.text
					|| funcNode.childForFieldName('field')?.text
					|| funcNode.childForFieldName('attribute')?.text
					|| funcNode.text;
			if (name && nodeNames.has(name)) return true;
		}
	}
	for (const child of node.children) {
		if (containsCallToKnownNode(child, config, nodeNames)) return true;
	}
	return false;
}

function groupByClass(nodes: CodeNode[]): NodeGroup[] {
	const classMap = new Map<string, string[]>();
	for (const node of nodes) {
		if (node.parent) {
			const ids = classMap.get(node.parent) || [];
			ids.push(node.id);
			classMap.set(node.parent, ids);
		}
	}

	const groups: NodeGroup[] = [];
	for (const [className, nodeIds] of classMap) {
		if (nodeIds.length >= 2) {
			const groupId = `class-group-${className}`;
			groups.push({ id: groupId, label: className, nodeIds });
			for (const node of nodes) {
				if (nodeIds.includes(node.id)) {
					node.groupId = groupId;
				}
			}
		}
	}
	return groups;
}

// ─── React Enhancer (TSX/JSX) ──────────────────────────────────────────

/**
 * React-specific semantic enhancement.
 * Detects component patterns, props, event handlers, conditional rendering.
 */
export function enhanceReact(
	graph: CallGraph,
	tree: Parser.Tree,
	config: LanguageConfig,
): CallGraph {
	const rootNode = tree.rootNode;

	// 1. Detect the component function (exported, name starts with uppercase)
	const componentNode = graph.nodes.find(
		n => n.type === 'function' && /^[A-Z]/.test(n.name),
	);
	if (!componentNode) return graph; // not a React component

	componentNode.role = 'entrypoint';
	componentNode.shape = 'ellipse';

	// 2. Analyze props interface — find callback props (on*)
	const callbackProps = findCallbackProps(rootNode);
	if (callbackProps.length > 0) {
		// Create synthetic "Parent" node
		const parentNode: CodeNode = {
			id: 'synthetic-parent',
			name: 'Parent Component',
			type: 'function',
			line: 0,
			role: 'parent',
			shape: 'cloud',
		};
		graph.nodes.push(parentNode);

		// Find which functions invoke callback props and add edges
		for (const cbName of callbackProps) {
			// Find nodes that call this callback
			for (const node of graph.nodes) {
				if (node.id === 'synthetic-parent') continue;
				if (invokesCallbackInBody(rootNode, node.name, cbName, config)) {
					// Mark the invoking node as a callback (but don't override the component itself)
					if (node.id !== componentNode.id) {
						node.role = 'callback';
						node.shape = 'hexagon';
					}
					// Add edge to parent
					const edgeExists = graph.edges.some(
						e => e.from === node.id && e.to === 'synthetic-parent',
					);
					if (!edgeExists) {
						graph.edges.push({
							from: node.id,
							to: 'synthetic-parent',
							label: 'to parent',
							style: 'solid',
						});
					}
				}
			}
		}
	}

	// 3. Find JSX event handlers — mark as user-action
	const eventHandlerNames = findJsxEventHandlers(rootNode);
	for (const handlerName of eventHandlerNames) {
		const node = graph.nodes.find(n => n.name === handlerName);
		if (node && !node.role) {
			node.role = 'user-action';
			node.shape = 'oval';
		}
	}

	// 4. Mark display-like leaf functions
	for (const node of graph.nodes) {
		if (!node.role && DISPLAY_PATTERNS.test(node.name)) {
			node.role = 'display';
			node.shape = 'rectangle';
			node.color = 'yellow';
		}
	}

	// 5. Build semantic groups
	const groups = buildReactGroups(graph, componentNode);
	graph.groups = [...(graph.groups || []), ...groups];

	// 6. Add edge labels for helper function calls
	for (const edge of graph.edges) {
		if (edge.label) continue; // already labeled
		const targetNode = graph.nodes.find(n => n.id === edge.to);
		if (targetNode?.role === 'display') {
			edge.label = targetNode.name;
			edge.style = 'dotted';
		}
	}

	return graph;
}

/**
 * Find callback prop names (on*) from TypeScript interface declarations.
 */
function findCallbackProps(rootNode: Parser.SyntaxNode): string[] {
	const callbacks: string[] = [];

	function walk(node: Parser.SyntaxNode): void {
		// Look for interface declarations or type aliases
		if (node.type === 'interface_declaration' || node.type === 'type_alias_declaration') {
			// Walk properties
			for (const child of node.descendantsOfType('property_signature')) {
				const nameNode = child.childForFieldName('name');
				if (nameNode && CALLBACK_PROP_PATTERN.test(nameNode.text)) {
					callbacks.push(nameNode.text);
				}
			}
		}
		for (const child of node.children) {
			walk(child);
		}
	}

	walk(rootNode);
	return callbacks;
}

/**
 * Check if a function's body invokes a specific callback prop.
 */
function invokesCallbackInBody(
	rootNode: Parser.SyntaxNode,
	funcName: string,
	callbackName: string,
	config: LanguageConfig,
): boolean {
	const allFunctionTypes = new Set([
		...config.functionTypes,
		...config.methodTypes,
	]);

	let found = false;

	function walkToFunction(node: Parser.SyntaxNode): void {
		if (found) return;
		if (allFunctionTypes.has(node.type)) {
			let name = node.childForFieldName(config.nameField)?.text;
			if (!name && node.parent?.type === 'variable_declarator') {
				name = node.parent.childForFieldName('name')?.text;
			}
			if (name === funcName) {
				const body = node.childForFieldName(config.bodyField);
				if (body) {
					found = bodyCallsName(body, callbackName, config);
				}
			}
			return;
		}
		for (const child of node.children) {
			walkToFunction(child);
		}
	}

	walkToFunction(rootNode);
	return found;
}

function bodyCallsName(
	body: Parser.SyntaxNode,
	name: string,
	config: LanguageConfig,
): boolean {
	if (config.callTypes.includes(body.type)) {
		const funcNode = body.childForFieldName(config.callFunctionField);
		if (funcNode?.text === name) return true;
	}
	for (const child of body.children) {
		if (bodyCallsName(child, name, config)) return true;
	}
	return false;
}

/**
 * Find function names referenced in JSX event handler attributes (onClick, onChange, etc.).
 */
function findJsxEventHandlers(rootNode: Parser.SyntaxNode): string[] {
	const handlers = new Set<string>();
	const eventAttrPattern = /^on[A-Z]/;

	function walk(node: Parser.SyntaxNode): void {
		// JSX attribute: <button onClick={handleClick}>
		if (node.type === 'jsx_attribute') {
			const nameNode = node.children[0]; // attribute name
			if (nameNode && eventAttrPattern.test(nameNode.text)) {
				// The value is typically a jsx_expression containing an identifier or arrow function
				for (const child of node.descendantsOfType('identifier')) {
					// Skip the attribute name itself and common non-handler identifiers
					if (child.text !== nameNode.text && child.text !== 'e' && child.text !== 'event') {
						handlers.add(child.text);
					}
				}
			}
		}
		for (const child of node.children) {
			walk(child);
		}
	}

	walk(rootNode);
	return Array.from(handlers);
}

/**
 * Build semantic groups for a React component.
 */
function buildReactGroups(graph: CallGraph, component: CodeNode): NodeGroup[] {
	const groups: NodeGroup[] = [];

	// Group: User Interactions (user-action nodes)
	const userActionIds = graph.nodes
		.filter(n => n.role === 'user-action')
		.map(n => n.id);
	if (userActionIds.length > 0) {
		const groupId = 'group-user-interactions';
		groups.push({ id: groupId, label: 'User Interactions', nodeIds: userActionIds });
		for (const node of graph.nodes) {
			if (userActionIds.includes(node.id)) node.groupId = groupId;
		}
	}

	// Group: Callbacks (callback nodes)
	const callbackIds = graph.nodes
		.filter(n => n.role === 'callback')
		.map(n => n.id);
	if (callbackIds.length > 0) {
		const groupId = 'group-callbacks';
		groups.push({ id: groupId, label: 'Callback Flow', nodeIds: callbackIds });
		for (const node of graph.nodes) {
			if (callbackIds.includes(node.id)) node.groupId = groupId;
		}
	}

	// Group: Display (display nodes)
	const displayIds = graph.nodes
		.filter(n => n.role === 'display')
		.map(n => n.id);
	if (displayIds.length > 0) {
		const groupId = 'group-display';
		groups.push({ id: groupId, label: 'Display', nodeIds: displayIds });
		for (const node of graph.nodes) {
			if (displayIds.includes(node.id)) node.groupId = groupId;
		}
	}

	// Group: Process (remaining process/decision nodes that aren't the component itself or parent)
	const processIds = graph.nodes
		.filter(n =>
			(n.role === 'process' || n.role === 'decision') &&
			n.id !== component.id &&
			n.id !== 'synthetic-parent',
		)
		.map(n => n.id);
	if (processIds.length > 0) {
		const groupId = 'group-logic';
		groups.push({ id: groupId, label: 'Logic', nodeIds: processIds });
		for (const node of graph.nodes) {
			if (processIds.includes(node.id)) node.groupId = groupId;
		}
	}

	return groups;
}

// ─── Dispatcher ─────────────────────────────────────────────────────────

type SemanticEnhancer = (
	graph: CallGraph,
	tree: Parser.Tree,
	config: LanguageConfig,
) => CallGraph;

const enhancerRegistry: Record<string, SemanticEnhancer[]> = {
	typescriptreact: [analyzeBase, enhanceReact],
	javascript: [analyzeBase],
	typescript: [analyzeBase],
	python: [analyzeBase],
	go: [analyzeBase],
	rust: [analyzeBase],
	java: [analyzeBase],
};

/**
 * Run semantic analysis on a call graph.
 * Enriches nodes with roles, shapes, colors, and groups.
 */
export function analyze(
	graph: CallGraph,
	tree: Parser.Tree,
	config: LanguageConfig,
): CallGraph {
	const enhancers = enhancerRegistry[graph.language] || [analyzeBase];
	let enriched = graph;
	for (const enhancer of enhancers) {
		enriched = enhancer(enriched, tree, config);
	}
	return enriched;
}
