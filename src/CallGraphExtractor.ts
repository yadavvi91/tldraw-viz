import type Parser from 'web-tree-sitter';
import type { LanguageConfig } from './languages';
import type { CodeEdge, CodeNode } from './types';

/**
 * Extract intra-file call edges from a parsed AST.
 * For each function/method, walks its body and finds call expressions
 * that reference other functions defined in the same file.
 */
export function extractEdges(
	tree: Parser.Tree,
	config: LanguageConfig,
	nodes: CodeNode[],
): CodeEdge[] {
	const edges: CodeEdge[] = [];
	const nodesByName = new Map<string, CodeNode>();
	for (const node of nodes) {
		nodesByName.set(node.name, node);
	}

	const allFunctionTypes = new Set([
		...config.functionTypes,
		...config.methodTypes,
	]);

	findFunctionsAndExtractCalls(
		tree.rootNode,
		config,
		allFunctionTypes,
		nodesByName,
		edges,
	);

	return edges;
}

function findFunctionsAndExtractCalls(
	node: Parser.SyntaxNode,
	config: LanguageConfig,
	allFunctionTypes: Set<string>,
	nodesByName: Map<string, CodeNode>,
	edges: CodeEdge[],
): void {
	if (allFunctionTypes.has(node.type)) {
		const callerNode = identifyCallerNode(node, config);
		if (callerNode && nodesByName.has(callerNode.name)) {
			const body = node.childForFieldName(config.bodyField);
			if (body) {
				extractCallsFromBody(
					body,
					callerNode,
					config,
					nodesByName,
					edges,
				);
			}
		}
		return;
	}

	for (const child of node.children) {
		findFunctionsAndExtractCalls(child, config, allFunctionTypes, nodesByName, edges);
	}
}

/** Figure out which CodeNode corresponds to this AST function node */
function identifyCallerNode(
	node: Parser.SyntaxNode,
	config: LanguageConfig,
): CodeNode | undefined {
	const nameNode = node.childForFieldName(config.nameField);
	let name = nameNode?.text;

	if (!name && node.parent) {
		if (node.parent.type === 'variable_declarator') {
			const varName = node.parent.childForFieldName('name');
			name = varName?.text;
		} else if (node.parent.type === 'pair' || node.parent.type === 'property') {
			const key = node.parent.childForFieldName('key');
			name = key?.text;
		}
	}

	if (!name) return undefined;

	const isMethod = config.methodTypes.includes(node.type);
	return {
		id: `${isMethod ? 'method' : 'function'}-${name}`,
		name,
		type: isMethod ? 'method' : 'function',
		line: node.startPosition.row + 1,
	};
}

/** Walk a function body and find call expressions referencing known functions */
function extractCallsFromBody(
	body: Parser.SyntaxNode,
	caller: CodeNode,
	config: LanguageConfig,
	nodesByName: Map<string, CodeNode>,
	edges: CodeEdge[],
): void {
	const seenEdges = new Set<string>();

	function walk(node: Parser.SyntaxNode): void {
		if (config.callTypes.includes(node.type)) {
			const calleeName = extractCalleeName(node, config);
			if (calleeName && nodesByName.has(calleeName) && calleeName !== caller.name) {
				const target = nodesByName.get(calleeName)!;
				const edgeKey = `${caller.id}->${target.id}`;
				if (!seenEdges.has(edgeKey)) {
					seenEdges.add(edgeKey);
					edges.push({ from: caller.id, to: target.id });
				}
			}
		}

		for (const child of node.children) {
			walk(child);
		}
	}

	walk(body);
}

/** Extract the callee function name from a call expression node */
function extractCalleeName(
	callNode: Parser.SyntaxNode,
	config: LanguageConfig,
): string | undefined {
	const funcNode = callNode.childForFieldName(config.callFunctionField);
	if (!funcNode) return undefined;

	// Simple identifier: foo()
	if (funcNode.type === 'identifier') {
		return funcNode.text;
	}

	// Member expression: obj.method() — extract just the method name
	if (funcNode.type === 'member_expression' || funcNode.type === 'field_expression') {
		const property = funcNode.childForFieldName('property') || funcNode.childForFieldName('field');
		return property?.text;
	}

	// Python attribute access: obj.method()
	if (funcNode.type === 'attribute') {
		const attr = funcNode.childForFieldName('attribute');
		return attr?.text;
	}

	// Java method_invocation uses 'name' field directly
	if (config.callFunctionField === 'name') {
		return funcNode.text;
	}

	return funcNode.text;
}
