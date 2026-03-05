import type Parser from 'web-tree-sitter';
import path from 'path';

export interface ImportInfo {
	/** Imported names (or '*' for namespace imports) */
	names: string[];
	/** The module specifier (e.g., './auth/login', '../utils') */
	source: string;
	/** Whether this is a default import */
	isDefault: boolean;
}

/**
 * Extract import statements from a parsed AST.
 * Supports: import { x } from './y', import x from './y',
 * const x = require('./y'), from y import x (Python)
 */
export function extractImports(
	tree: Parser.Tree,
	language: string,
): ImportInfo[] {
	const imports: ImportInfo[] = [];

	if (language === 'python') {
		extractPythonImports(tree.rootNode, imports);
	} else {
		extractJsTsImports(tree.rootNode, imports);
	}

	return imports.filter(i => isRelativeImport(i.source));
}

function isRelativeImport(source: string): boolean {
	return source.startsWith('./') || source.startsWith('../');
}

function extractJsTsImports(node: Parser.SyntaxNode, imports: ImportInfo[]): void {
	if (node.type === 'import_statement') {
		const source = node.childForFieldName('source');
		if (!source) return;

		const moduleSpecifier = stripQuotes(source.text);
		const names: string[] = [];
		let isDefault = false;

		for (const child of node.children) {
			if (child.type === 'import_clause') {
				for (const clauseChild of child.children) {
					if (clauseChild.type === 'identifier') {
						names.push(clauseChild.text);
						isDefault = true;
					} else if (clauseChild.type === 'named_imports') {
						for (const spec of clauseChild.children) {
							if (spec.type === 'import_specifier') {
								const nameNode = spec.childForFieldName('name');
								const aliasNode = spec.childForFieldName('alias');
								names.push(aliasNode?.text || nameNode?.text || spec.text);
							}
						}
					} else if (clauseChild.type === 'namespace_import') {
						names.push('*');
					}
				}
			}
		}

		if (names.length > 0 || moduleSpecifier) {
			imports.push({ names, source: moduleSpecifier, isDefault });
		}
		return;
	}

	for (const child of node.children) {
		extractJsTsImports(child, imports);
	}
}

function extractPythonImports(node: Parser.SyntaxNode, imports: ImportInfo[]): void {
	if (node.type === 'import_from_statement') {
		const moduleNode = node.childForFieldName('module_name');
		if (!moduleNode) return;

		const moduleName = moduleNode.text;
		if (!moduleName.startsWith('.')) return;

		const names: string[] = [];
		for (const child of node.children) {
			if (child.type === 'dotted_name' && child !== moduleNode) {
				names.push(child.text);
			}
		}

		imports.push({
			names,
			source: pythonModuleToPath(moduleName),
			isDefault: false,
		});
		return;
	}

	for (const child of node.children) {
		extractPythonImports(child, imports);
	}
}

function pythonModuleToPath(moduleName: string): string {
	// Convert '.foo.bar' to './foo/bar'
	const parts = moduleName.split('.');
	const dots = parts.filter(p => p === '').length;
	const names = parts.filter(p => p !== '');

	const prefix = dots <= 1 ? './' : '../'.repeat(dots - 1);
	return prefix + names.join('/');
}

function stripQuotes(s: string): string {
	if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
		return s.slice(1, -1);
	}
	return s;
}

/**
 * Resolve an import source to an absolute file path.
 * Tries common extensions if the source doesn't have one.
 */
export function resolveImportPath(
	importSource: string,
	fromFile: string,
	existingFiles: Set<string>,
): string | undefined {
	const dir = path.dirname(fromFile);
	const resolved = path.resolve(dir, importSource);

	// Try exact match first
	if (existingFiles.has(resolved)) return resolved;

	// Try common extensions
	const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java'];
	for (const ext of extensions) {
		const withExt = resolved + ext;
		if (existingFiles.has(withExt)) return withExt;
	}

	// Try index files
	for (const ext of extensions) {
		const indexFile = path.join(resolved, `index${ext}`);
		if (existingFiles.has(indexFile)) return indexFile;
	}

	return undefined;
}
