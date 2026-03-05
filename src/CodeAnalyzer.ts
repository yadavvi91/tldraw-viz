import Parser from 'web-tree-sitter';
import type { LanguageConfig } from './languages';
import { resolveGrammarPath } from './languages';
import type { CodeNode } from './types';

let parserInitialized = false;

/** Ensure web-tree-sitter is initialized (idempotent) */
export async function initParser(): Promise<void> {
	if (!parserInitialized) {
		await Parser.init();
		parserInitialized = true;
	}
}

/** Load a Tree-sitter language from a WASM grammar file */
export async function loadLanguage(config: LanguageConfig): Promise<Parser.Language> {
	await initParser();
	const grammarPath = resolveGrammarPath(config.wasmFile);
	return Parser.Language.load(grammarPath);
}

/** Parse source code using a Tree-sitter language */
export async function parseSource(
	source: string,
	config: LanguageConfig,
): Promise<Parser.Tree> {
	await initParser();
	const parser = new Parser();
	const language = await loadLanguage(config);
	parser.setLanguage(language);
	return parser.parse(source);
}

/**
 * Extract function/method/class declarations from a parsed AST.
 * Returns CodeNode[] with id, name, type, line, and optional parent.
 */
export function extractNodes(
	tree: Parser.Tree,
	config: LanguageConfig,
): CodeNode[] {
	const nodes: CodeNode[] = [];
	const allFunctionTypes = new Set([
		...config.functionTypes,
		...config.methodTypes,
	]);

	walkTree(tree.rootNode, config, allFunctionTypes, nodes, undefined);
	return nodes;
}

function walkTree(
	node: Parser.SyntaxNode,
	config: LanguageConfig,
	allFunctionTypes: Set<string>,
	results: CodeNode[],
	currentClass: string | undefined,
): void {
	// Check for class declarations
	if (config.classTypes.includes(node.type)) {
		const nameNode = node.childForFieldName(config.classNameField);
		const className = nameNode?.text || 'anonymous';

		results.push({
			id: `class-${className}`,
			name: className,
			type: 'class',
			line: node.startPosition.row + 1,
		});

		// Walk children with class context
		for (const child of node.children) {
			walkTree(child, config, allFunctionTypes, results, className);
		}
		return;
	}

	// Check for function/method declarations
	if (allFunctionTypes.has(node.type)) {
		const nameNode = node.childForFieldName(config.nameField);
		let name = nameNode?.text;

		// Handle arrow functions assigned to variables: const foo = () => {}
		if (!name && node.parent) {
			if (node.parent.type === 'variable_declarator') {
				const varName = node.parent.childForFieldName('name');
				name = varName?.text;
			} else if (node.parent.type === 'pair' || node.parent.type === 'property') {
				const key = node.parent.childForFieldName('key');
				name = key?.text;
			}
		}

		if (!name) {
			name = 'anonymous';
		}

		const isMethod = config.methodTypes.includes(node.type) || !!currentClass;
		const nodeType = isMethod ? 'method' : 'function';
		const id = `${nodeType}-${name}`;

		// Handle Go method declarations — receiver type is the "parent"
		let parentName = currentClass;
		if (node.type === 'method_declaration' && !parentName) {
			const params = node.childForFieldName('parameters');
			if (params) {
				// Go method receiver: func (r *ReceiverType) MethodName()
				const typeNode = params.descendantsOfType('type_identifier')[0];
				parentName = typeNode?.text;
			}
		}

		results.push({
			id,
			name,
			type: nodeType,
			line: node.startPosition.row + 1,
			...(parentName ? { parent: parentName } : {}),
		});

		// Don't recurse into nested functions for now
		return;
	}

	// Recurse into children
	for (const child of node.children) {
		walkTree(child, config, allFunctionTypes, results, currentClass);
	}
}
