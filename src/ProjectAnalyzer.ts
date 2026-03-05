import path from 'path';
import { minimatch } from 'minimatch';
import type { FileReader } from './FlowTracer';
import type { ModuleConfig } from './GranularityFilter';

export interface ProjectModule {
	name: string;
	description?: string;
	files: string[];
	exports: string[];
	fileCount: number;
}

export interface ModuleDependency {
	from: string;
	to: string;
	importCount: number;
	importedSymbols: string[];
}

export interface ProjectGraph {
	modules: ProjectModule[];
	dependencies: ModuleDependency[];
	projectName: string;
}

const IGNORED_DIRS = new Set([
	'node_modules', '.git', 'dist', 'build', '.tldraw', '.mermaid',
	'coverage', '.vscode', '.idea', '__pycache__',
]);

/**
 * Discover modules by grouping files into top-level directories.
 * If configModules is provided, use glob patterns; otherwise auto-detect.
 */
export function discoverModules(
	filePaths: string[],
	workspaceRoot: string,
	configModules?: ModuleConfig[],
): ProjectModule[] {
	const relativePaths = filePaths.map(f => path.relative(workspaceRoot, f));

	if (configModules && configModules.length > 0) {
		return discoverFromConfig(relativePaths, filePaths, configModules);
	}
	return autoDetectModules(relativePaths, filePaths);
}

function discoverFromConfig(
	relativePaths: string[],
	absolutePaths: string[],
	configModules: ModuleConfig[],
): ProjectModule[] {
	const modules: ProjectModule[] = [];

	for (const mod of configModules) {
		const files: string[] = [];
		for (let i = 0; i < relativePaths.length; i++) {
			for (const pattern of mod.include) {
				if (minimatch(relativePaths[i], pattern)) {
					files.push(absolutePaths[i]);
					break;
				}
			}
		}
		if (files.length > 0) {
			modules.push({
				name: mod.name,
				description: mod.description,
				files,
				exports: [],
				fileCount: files.length,
			});
		}
	}

	return modules;
}

function autoDetectModules(
	relativePaths: string[],
	absolutePaths: string[],
): ProjectModule[] {
	const groups = new Map<string, string[]>();

	for (let i = 0; i < relativePaths.length; i++) {
		const parts = relativePaths[i].split(path.sep);

		// Determine module name from directory structure
		let moduleName: string;
		if (parts[0] === 'src' && parts.length > 2) {
			// src/auth/login.ts → module "auth"
			moduleName = parts[1];
		} else if (parts.length > 1) {
			// api/routes.ts → module "api"
			moduleName = parts[0];
		} else {
			// Root-level file → module "root"
			moduleName = 'root';
		}

		if (IGNORED_DIRS.has(moduleName)) continue;

		const existing = groups.get(moduleName) || [];
		existing.push(absolutePaths[i]);
		groups.set(moduleName, existing);
	}

	return Array.from(groups.entries()).map(([name, files]) => ({
		name,
		files,
		exports: [],
		fileCount: files.length,
	}));
}

/** Extract exported symbol names from file content using regex */
export function extractExports(content: string): string[] {
	const exports: string[] = [];
	const patterns = [
		/export\s+(?:async\s+)?function\s+(\w+)/g,
		/export\s+class\s+(\w+)/g,
		/export\s+const\s+(\w+)/g,
		/export\s+default\s+(?:class|function)\s+(\w+)/g,
		/export\s+interface\s+(\w+)/g,
		/export\s+type\s+(\w+)/g,
		/export\s+enum\s+(\w+)/g,
	];

	for (const pattern of patterns) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(content)) !== null) {
			exports.push(match[1]);
		}
	}

	return [...new Set(exports)].slice(0, 20);
}

/** Extract import sources and symbols from file content using regex */
export function extractImports(content: string): Array<{ source: string; symbols: string[] }> {
	const imports: Array<{ source: string; symbols: string[] }> = [];

	// ES imports: import { a, b } from './path'
	const esImportRegex = /import\s+(?:\{([^}]*)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
	let match: RegExpExecArray | null;
	while ((match = esImportRegex.exec(content)) !== null) {
		const symbols = match[1]
			? match[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)
			: match[2] ? [match[2]] : [];
		imports.push({ source: match[3], symbols });
	}

	// Side-effect imports: import './path' (no identifier/braces between import and quote)
	const sideEffectRegex = /import\s+['"]([^'"]+)['"]/g;
	while ((match = sideEffectRegex.exec(content)) !== null) {
		// Only match if 'import' is directly followed by whitespace then a quote
		if (/^import\s+['"]/.test(match[0])) {
			imports.push({ source: match[1], symbols: [] });
		}
	}

	// require: const x = require('./path')
	const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
	while ((match = requireRegex.exec(content)) !== null) {
		imports.push({ source: match[1], symbols: [] });
	}

	// Python: from module import a, b
	const pyFromRegex = /from\s+([\w.]+)\s+import\s+(.+)/g;
	while ((match = pyFromRegex.exec(content)) !== null) {
		const symbols = match[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
		imports.push({ source: match[1], symbols });
	}

	// Python: import module (but not ES import ... from ...)
	const pyImportRegex = /^import\s+([\w.]+)\s*$/gm;
	while ((match = pyImportRegex.exec(content)) !== null) {
		imports.push({ source: match[1], symbols: [] });
	}

	return imports;
}

/**
 * Determine which module owns a given import source path.
 * Returns the module name if found, undefined otherwise.
 */
function resolveImportToModule(
	importSource: string,
	importingFile: string,
	workspaceRoot: string,
	modules: ProjectModule[],
): string | undefined {
	// Skip external packages (no relative path prefix)
	if (!importSource.startsWith('.') && !importSource.startsWith('/')) {
		// Could be a Python relative import or absolute package — skip
		return undefined;
	}

	// Resolve relative import to absolute path
	const importingDir = path.dirname(importingFile);
	let resolved = path.resolve(importingDir, importSource);

	// Try common extensions
	const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '/index.ts', '/index.tsx', '/index.js'];
	for (const mod of modules) {
		for (const file of mod.files) {
			if (file === resolved || extensions.some(ext => file === resolved + ext)) {
				return mod.name;
			}
		}
	}

	return undefined;
}

/**
 * Analyze import relationships between modules.
 */
export async function analyzeModuleDependencies(
	modules: ProjectModule[],
	fileReader: FileReader,
	workspaceRoot: string,
): Promise<ModuleDependency[]> {
	const depMap = new Map<string, { count: number; symbols: Set<string> }>();

	for (const mod of modules) {
		for (const filePath of mod.files) {
			let content: string;
			try {
				content = await fileReader.readFile(filePath);
			} catch {
				continue;
			}

			const imports = extractImports(content);
			for (const imp of imports) {
				const targetModule = resolveImportToModule(imp.source, filePath, workspaceRoot, modules);
				if (!targetModule || targetModule === mod.name) continue;

				const key = `${mod.name}→${targetModule}`;
				const existing = depMap.get(key) || { count: 0, symbols: new Set<string>() };
				existing.count++;
				for (const sym of imp.symbols) {
					if (existing.symbols.size < 5) existing.symbols.add(sym);
				}
				depMap.set(key, existing);
			}
		}
	}

	return Array.from(depMap.entries()).map(([key, val]) => {
		const [from, to] = key.split('→');
		return {
			from,
			to,
			importCount: val.count,
			importedSymbols: [...val.symbols],
		};
	});
}

/**
 * Build a complete project graph by discovering modules,
 * scanning exports, and analyzing dependencies.
 */
export async function buildProjectGraph(
	fileReader: FileReader,
	workspaceRoot: string,
	configModules?: ModuleConfig[],
	projectName?: string,
): Promise<ProjectGraph> {
	const allFiles = await fileReader.listFiles();
	const modules = discoverModules(allFiles, workspaceRoot, configModules);

	// Scan exports for each module
	for (const mod of modules) {
		const allExports: string[] = [];
		for (const filePath of mod.files) {
			try {
				const content = await fileReader.readFile(filePath);
				allExports.push(...extractExports(content));
			} catch {
				continue;
			}
		}
		mod.exports = [...new Set(allExports)].slice(0, 20);
	}

	const dependencies = await analyzeModuleDependencies(modules, fileReader, workspaceRoot);

	return {
		modules,
		dependencies,
		projectName: projectName || path.basename(workspaceRoot),
	};
}
