import path from 'path';

/** Tree-sitter node type queries per language */
export interface LanguageConfig {
	/** VS Code language IDs that map to this config */
	languageIds: string[];
	/** Filename of the .wasm grammar in tree-sitter-wasms/out/ */
	wasmFile: string;
	/** AST node types representing function/method declarations */
	functionTypes: string[];
	/** AST node type for method declarations specifically */
	methodTypes: string[];
	/** AST node type for class declarations */
	classTypes: string[];
	/** AST node types for call expressions */
	callTypes: string[];
	/** Field name for function/method name in the AST */
	nameField: string;
	/** Field name for function body */
	bodyField: string;
	/** Field name for the function being called in a call expression */
	callFunctionField: string;
	/** Field name for class name */
	classNameField: string;
}

const LANGUAGES: Record<string, LanguageConfig> = {
	typescript: {
		languageIds: ['typescript'],
		wasmFile: 'tree-sitter-typescript.wasm',
		functionTypes: ['function_declaration', 'arrow_function', 'function'],
		methodTypes: ['method_definition'],
		classTypes: ['class_declaration'],
		callTypes: ['call_expression'],
		nameField: 'name',
		bodyField: 'body',
		callFunctionField: 'function',
		classNameField: 'name',
	},
	typescriptreact: {
		languageIds: ['typescriptreact'],
		wasmFile: 'tree-sitter-tsx.wasm',
		functionTypes: ['function_declaration', 'arrow_function', 'function'],
		methodTypes: ['method_definition'],
		classTypes: ['class_declaration'],
		callTypes: ['call_expression'],
		nameField: 'name',
		bodyField: 'body',
		callFunctionField: 'function',
		classNameField: 'name',
	},
	javascript: {
		languageIds: ['javascript', 'javascriptreact'],
		wasmFile: 'tree-sitter-javascript.wasm',
		functionTypes: ['function_declaration', 'arrow_function', 'function'],
		methodTypes: ['method_definition'],
		classTypes: ['class_declaration'],
		callTypes: ['call_expression'],
		nameField: 'name',
		bodyField: 'body',
		callFunctionField: 'function',
		classNameField: 'name',
	},
	python: {
		languageIds: ['python'],
		wasmFile: 'tree-sitter-python.wasm',
		functionTypes: ['function_definition'],
		methodTypes: [],
		classTypes: ['class_definition'],
		callTypes: ['call'],
		nameField: 'name',
		bodyField: 'body',
		callFunctionField: 'function',
		classNameField: 'name',
	},
	go: {
		languageIds: ['go'],
		wasmFile: 'tree-sitter-go.wasm',
		functionTypes: ['function_declaration'],
		methodTypes: ['method_declaration'],
		classTypes: [],
		callTypes: ['call_expression'],
		nameField: 'name',
		bodyField: 'body',
		callFunctionField: 'function',
		classNameField: 'name',
	},
	rust: {
		languageIds: ['rust'],
		wasmFile: 'tree-sitter-rust.wasm',
		functionTypes: ['function_item'],
		methodTypes: [],
		classTypes: ['impl_item'],
		callTypes: ['call_expression'],
		nameField: 'name',
		bodyField: 'body',
		callFunctionField: 'function',
		classNameField: 'type',
	},
	java: {
		languageIds: ['java'],
		wasmFile: 'tree-sitter-java.wasm',
		functionTypes: [],
		methodTypes: ['method_declaration', 'constructor_declaration'],
		classTypes: ['class_declaration'],
		callTypes: ['method_invocation'],
		nameField: 'name',
		bodyField: 'body',
		callFunctionField: 'name',
		classNameField: 'name',
	},
};

/** Get language config by VS Code language ID */
export function getLanguageConfig(languageId: string): LanguageConfig | undefined {
	for (const config of Object.values(LANGUAGES)) {
		if (config.languageIds.includes(languageId)) {
			return config;
		}
	}
	return undefined;
}

/** Get language config by key name */
export function getLanguageConfigByKey(key: string): LanguageConfig | undefined {
	return LANGUAGES[key];
}

/** Resolve the path to a .wasm grammar file */
export function resolveGrammarPath(wasmFile: string): string {
	return path.join(
		path.dirname(require.resolve('tree-sitter-wasms/package.json')),
		'out',
		wasmFile,
	);
}

/** Map file extension to language key */
export function extensionToLanguage(ext: string): string | undefined {
	const map: Record<string, string> = {
		'.ts': 'typescript',
		'.tsx': 'typescriptreact',
		'.js': 'javascript',
		'.jsx': 'javascript',
		'.py': 'python',
		'.go': 'go',
		'.rs': 'rust',
		'.java': 'java',
	};
	return map[ext];
}

export { LANGUAGES };
