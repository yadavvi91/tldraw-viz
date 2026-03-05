import path from 'path';
import type { FileReader } from './FlowTracer';
import type { FlowConfig } from './GranularityFilter';

export type EntrypointPattern =
	| 'express-route'
	| 'flask-route'
	| 'fastapi-route'
	| 'main-function'
	| 'exported-handler';

export interface DetectedEntrypoint {
	/** Relative path from workspace root */
	file: string;
	/** Function name to trace from */
	functionName: string;
	/** Which detection pattern matched */
	pattern: EntrypointPattern;
	/** Human-readable description, e.g. "POST /api/login" */
	description: string;
}

/**
 * Scan workspace files for common entrypoint patterns.
 * Returns detected entrypoints that can be converted to FlowConfig.
 */
export async function detectEntrypoints(
	fileReader: FileReader,
	workspaceRoot: string,
): Promise<DetectedEntrypoint[]> {
	const allFiles = await fileReader.listFiles();
	const entrypoints: DetectedEntrypoint[] = [];

	for (const absPath of allFiles) {
		const relativePath = path.relative(workspaceRoot, absPath);

		// Skip test files and node_modules
		if (
			relativePath.includes('node_modules') ||
			relativePath.includes('.test.') ||
			relativePath.includes('.spec.') ||
			relativePath.includes('__test__')
		) continue;

		const ext = path.extname(absPath);
		let content: string;
		try {
			content = await fileReader.readFile(absPath);
		} catch {
			continue;
		}

		if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
			entrypoints.push(...detectExpressRoutes(content, relativePath));
			entrypoints.push(...detectMainFunctions(content, relativePath, 'js'));
			entrypoints.push(...detectExportedHandlers(content, relativePath));
		} else if (ext === '.py') {
			// Detect Flask or FastAPI (not both — FastAPI uses `router`, Flask uses `app`)
			const hasFastAPIRouter = /from\s+fastapi/.test(content) || /APIRouter/.test(content);
			if (hasFastAPIRouter) {
				entrypoints.push(...detectFastAPIRoutes(content, relativePath));
			} else {
				entrypoints.push(...detectFlaskRoutes(content, relativePath));
			}
			entrypoints.push(...detectMainFunctions(content, relativePath, 'python'));
		} else if (ext === '.go') {
			entrypoints.push(...detectMainFunctions(content, relativePath, 'go'));
		} else if (ext === '.rs') {
			entrypoints.push(...detectMainFunctions(content, relativePath, 'rust'));
		} else if (ext === '.java') {
			entrypoints.push(...detectMainFunctions(content, relativePath, 'java'));
		}
	}

	return entrypoints;
}

/**
 * Convert detected entrypoints to FlowConfig format
 * compatible with the existing tldraw.config.json structure.
 */
export function entrypointsToFlowConfigs(
	entrypoints: DetectedEntrypoint[],
): FlowConfig[] {
	return entrypoints.map(ep => ({
		name: generateFlowName(ep),
		entrypoint: `${ep.file}:${ep.functionName}`,
	}));
}

function generateFlowName(ep: DetectedEntrypoint): string {
	switch (ep.pattern) {
		case 'express-route':
		case 'flask-route':
		case 'fastapi-route':
			return ep.description
				.replace(/[^a-zA-Z0-9-]/g, '-')
				.replace(/-+/g, '-')
				.replace(/^-|-$/g, '')
				.toLowerCase();
		case 'main-function':
			return `main-${path.basename(ep.file, path.extname(ep.file))}`;
		case 'exported-handler':
			return `handler-${ep.functionName}`;
	}
}

/**
 * Detect Express.js route handlers:
 *   app.get('/path', handler)
 *   router.post('/path', handler)
 */
function detectExpressRoutes(content: string, relativePath: string): DetectedEntrypoint[] {
	const results: DetectedEntrypoint[] = [];
	const regex = /(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)/g;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(content)) !== null) {
		const method = match[1].toUpperCase();
		const routePath = match[2];
		const handler = match[3];

		results.push({
			file: relativePath,
			functionName: handler,
			pattern: 'express-route',
			description: `${method} ${routePath}`,
		});
	}

	return results;
}

/**
 * Detect Flask route handlers:
 *   @app.route('/path')
 *   @app.get('/path')
 *   def handler():
 */
function detectFlaskRoutes(content: string, relativePath: string): DetectedEntrypoint[] {
	const results: DetectedEntrypoint[] = [];

	// @app.route('/path', methods=['POST'])
	const routeRegex = /@app\.route\s*\(\s*['"]([^'"]+)['"](?:.*?methods\s*=\s*\[['"](\w+)['"]\])?\s*\)\s*\n(?:async\s+)?def\s+(\w+)/g;
	let match: RegExpExecArray | null;
	while ((match = routeRegex.exec(content)) !== null) {
		const routePath = match[1];
		const method = match[2] ? match[2].toUpperCase() : 'GET';
		const funcName = match[3];
		results.push({
			file: relativePath,
			functionName: funcName,
			pattern: 'flask-route',
			description: `${method} ${routePath}`,
		});
	}

	// @app.get('/path'), @app.post('/path')
	const methodRegex = /@app\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\n(?:async\s+)?def\s+(\w+)/g;
	while ((match = methodRegex.exec(content)) !== null) {
		const method = match[1].toUpperCase();
		const routePath = match[2];
		const funcName = match[3];
		results.push({
			file: relativePath,
			functionName: funcName,
			pattern: 'flask-route',
			description: `${method} ${routePath}`,
		});
	}

	return results;
}

/**
 * Detect FastAPI route handlers:
 *   @router.get('/path')
 *   @app.post('/path')
 *   async def handler():
 */
function detectFastAPIRoutes(content: string, relativePath: string): DetectedEntrypoint[] {
	const results: DetectedEntrypoint[] = [];
	const regex = /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\n(?:async\s+)?def\s+(\w+)/g;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(content)) !== null) {
		const method = match[1].toUpperCase();
		const routePath = match[2];
		const funcName = match[3];
		results.push({
			file: relativePath,
			functionName: funcName,
			pattern: 'fastapi-route',
			description: `${method} ${routePath}`,
		});
	}

	return results;
}

/**
 * Detect main() function patterns across languages.
 */
function detectMainFunctions(
	content: string,
	relativePath: string,
	lang: 'js' | 'python' | 'go' | 'rust' | 'java',
): DetectedEntrypoint[] {
	const results: DetectedEntrypoint[] = [];

	switch (lang) {
		case 'js': {
			// function main(), export function main(), export async function main()
			const jsRegex = /(?:export\s+)?(?:async\s+)?function\s+main\s*\(/;
			if (jsRegex.test(content)) {
				results.push({
					file: relativePath,
					functionName: 'main',
					pattern: 'main-function',
					description: 'main() entry',
				});
			}
			break;
		}
		case 'python': {
			// if __name__ == '__main__':
			if (/if\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(content)) {
				// Try to find the function called inside the block
				const callMatch = content.match(/if\s+__name__\s*==\s*['"]__main__['"]\s*:\s*\n\s+(\w+)\s*\(/);
				const funcName = callMatch ? callMatch[1] : 'main';
				results.push({
					file: relativePath,
					functionName: funcName,
					pattern: 'main-function',
					description: `${funcName}() entry`,
				});
			}
			break;
		}
		case 'go': {
			if (/^package\s+main\b/m.test(content) && /\bfunc\s+main\s*\(/.test(content)) {
				results.push({
					file: relativePath,
					functionName: 'main',
					pattern: 'main-function',
					description: 'main() entry',
				});
			}
			break;
		}
		case 'rust': {
			if (/\bfn\s+main\s*\(/.test(content)) {
				results.push({
					file: relativePath,
					functionName: 'main',
					pattern: 'main-function',
					description: 'main() entry',
				});
			}
			break;
		}
		case 'java': {
			if (/public\s+static\s+void\s+main\s*\(\s*String/.test(content)) {
				results.push({
					file: relativePath,
					functionName: 'main',
					pattern: 'main-function',
					description: 'main() entry',
				});
			}
			break;
		}
	}

	return results;
}

/** Entry-point filenames where we look for exported handlers */
const HANDLER_FILE_NAMES = new Set([
	'index', 'main', 'app', 'server',
]);

/**
 * Detect exported handler functions from entry-point files
 * (index.ts, main.ts, app.ts, server.ts, etc.)
 */
function detectExportedHandlers(content: string, relativePath: string): DetectedEntrypoint[] {
	const baseName = path.basename(relativePath, path.extname(relativePath));
	if (!HANDLER_FILE_NAMES.has(baseName)) return [];

	const results: DetectedEntrypoint[] = [];
	const regex = /export\s+(?:async\s+)?function\s+(handle\w+|process\w+|on[A-Z]\w+|init\w+|setup\w+|start\w+|bootstrap\w+)\s*\(/g;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(content)) !== null) {
		const funcName = match[1];
		results.push({
			file: relativePath,
			functionName: funcName,
			pattern: 'exported-handler',
			description: `${funcName} handler`,
		});
	}

	return results;
}
