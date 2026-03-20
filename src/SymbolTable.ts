import type Parser from 'web-tree-sitter';
import type { LanguageConfig } from './languages';

/** A symbol entry with byte-precise source location from tree-sitter */
export interface SymbolEntry {
	name: string;
	startByte: number;
	endByte: number;
	line: number;
	type: 'function' | 'method' | 'class';
	/** Parent class name (for methods) */
	parent?: string;
}

/** Map of symbol names → byte ranges, built from tree-sitter AST */
export type SymbolTable = Map<string, SymbolEntry>;

/**
 * Build a symbol table from a tree-sitter parse tree.
 * Maps function/method/class names to their exact byte offsets.
 *
 * Follows the same traversal logic as CodeAnalyzer.extractNodes()
 * but captures byte offsets instead of just line numbers.
 */
export function buildSymbolTable(
	tree: Parser.Tree,
	config: LanguageConfig,
): SymbolTable {
	const table: SymbolTable = new Map();
	const allFunctionTypes = new Set([
		...config.functionTypes,
		...config.methodTypes,
	]);

	walkForSymbols(tree.rootNode, config, allFunctionTypes, table, undefined);
	return table;
}

function walkForSymbols(
	node: Parser.SyntaxNode,
	config: LanguageConfig,
	allFunctionTypes: Set<string>,
	table: SymbolTable,
	currentClass: string | undefined,
): void {
	// Check for class declarations
	if (config.classTypes.includes(node.type)) {
		const nameNode = node.childForFieldName(config.classNameField);
		const className = nameNode?.text || 'anonymous';

		table.set(className, {
			name: className,
			startByte: node.startIndex,
			endByte: node.endIndex,
			line: node.startPosition.row + 1,
			type: 'class',
		});

		// Walk children with class context
		for (const child of node.children) {
			walkForSymbols(child, config, allFunctionTypes, table, className);
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

		// Handle Go method declarations — receiver type is the "parent"
		let parentName = currentClass;
		if (node.type === 'method_declaration' && !parentName) {
			const params = node.childForFieldName('parameters');
			if (params) {
				const typeNode = params.descendantsOfType('type_identifier')[0];
				parentName = typeNode?.text;
			}
		}

		const entry: SymbolEntry = {
			name,
			startByte: node.startIndex,
			endByte: node.endIndex,
			line: node.startPosition.row + 1,
			type: isMethod ? 'method' : 'function',
			...(parentName ? { parent: parentName } : {}),
		};

		// Store by plain name
		table.set(name, entry);

		// Also store by qualified name (ClassName.methodName) for disambiguation
		if (parentName) {
			table.set(`${parentName}.${name}`, entry);
		}

		// Don't recurse into nested functions
		return;
	}

	// Recurse into children
	for (const child of node.children) {
		walkForSymbols(child, config, allFunctionTypes, table, currentClass);
	}
}

/**
 * Look up a symbol in the table, trying multiple name forms.
 * Returns the SymbolEntry if found, undefined otherwise.
 */
export function lookupSymbol(
	table: SymbolTable,
	name: string,
	parent?: string,
): SymbolEntry | undefined {
	// Try qualified name first (most specific)
	if (parent) {
		const qualified = table.get(`${parent}.${name}`);
		if (qualified) return qualified;
	}

	// Try plain name
	return table.get(name);
}
