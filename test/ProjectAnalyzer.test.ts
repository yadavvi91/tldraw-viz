import { describe, it, expect } from 'vitest';
import path from 'path';
import {
	discoverModules,
	extractExports,
	extractImports,
	analyzeModuleDependencies,
	buildProjectGraph,
} from '../src/ProjectAnalyzer';
import { generateProjectPrompt } from '../src/StructuralSummary';
import type { FileReader } from '../src/FlowTracer';

function createMemoryReader(files: Record<string, string>): FileReader {
	return {
		async readFile(absolutePath: string) {
			const content = files[absolutePath];
			if (content === undefined) throw new Error(`File not found: ${absolutePath}`);
			return content;
		},
		async listFiles() {
			return Object.keys(files);
		},
	};
}

const ROOT = '/project';

describe('ProjectAnalyzer', () => {
	describe('discoverModules — auto-detect', () => {
		it('groups files by first directory under src/', () => {
			const files = [
				'/project/src/auth/login.ts',
				'/project/src/auth/register.ts',
				'/project/src/services/api.ts',
				'/project/src/utils/helpers.ts',
			];
			const modules = discoverModules(files, ROOT);
			expect(modules).toHaveLength(3);
			expect(modules.find(m => m.name === 'auth')?.fileCount).toBe(2);
			expect(modules.find(m => m.name === 'services')?.fileCount).toBe(1);
			expect(modules.find(m => m.name === 'utils')?.fileCount).toBe(1);
		});

		it('groups files by top-level dir when no src/', () => {
			const files = [
				'/project/api/routes.ts',
				'/project/models/user.ts',
			];
			const modules = discoverModules(files, ROOT);
			expect(modules).toHaveLength(2);
			expect(modules.find(m => m.name === 'api')).toBeDefined();
			expect(modules.find(m => m.name === 'models')).toBeDefined();
		});

		it('puts root-level files in a "root" module', () => {
			const files = ['/project/index.ts'];
			const modules = discoverModules(files, ROOT);
			expect(modules).toHaveLength(1);
			expect(modules[0].name).toBe('root');
		});

		it('returns empty for no files', () => {
			expect(discoverModules([], ROOT)).toHaveLength(0);
		});

		it('excludes ignored directories', () => {
			const files = [
				'/project/src/auth/login.ts',
				'/project/node_modules/pkg/index.ts',
			];
			const modules = discoverModules(files, ROOT);
			expect(modules).toHaveLength(1);
			expect(modules[0].name).toBe('auth');
		});
	});

	describe('discoverModules — config-defined', () => {
		it('groups files by glob patterns', () => {
			const files = [
				'/project/src/api/routes.ts',
				'/project/src/api/middleware.ts',
				'/project/src/db/models.ts',
				'/project/src/ui/App.tsx',
			];
			const config = [
				{ name: 'Backend', include: ['src/api/**', 'src/db/**'] },
				{ name: 'Frontend', include: ['src/ui/**'] },
			];
			const modules = discoverModules(files, ROOT, config);
			expect(modules).toHaveLength(2);
			expect(modules.find(m => m.name === 'Backend')?.fileCount).toBe(3);
			expect(modules.find(m => m.name === 'Frontend')?.fileCount).toBe(1);
		});

		it('skips modules with no matching files', () => {
			const files = ['/project/src/api/routes.ts'];
			const config = [
				{ name: 'Backend', include: ['src/api/**'] },
				{ name: 'Frontend', include: ['src/ui/**'] },
			];
			const modules = discoverModules(files, ROOT, config);
			expect(modules).toHaveLength(1);
			expect(modules[0].name).toBe('Backend');
		});
	});

	describe('extractExports', () => {
		it('extracts function exports', () => {
			const content = `export function login() {}\nexport async function register() {}`;
			expect(extractExports(content)).toEqual(['login', 'register']);
		});

		it('extracts class and const exports', () => {
			const content = `export class AuthService {}\nexport const API_KEY = 'x';`;
			const exports = extractExports(content);
			expect(exports).toContain('AuthService');
			expect(exports).toContain('API_KEY');
		});

		it('extracts interface and type exports', () => {
			const content = `export interface User {}\nexport type Role = 'admin';`;
			const exports = extractExports(content);
			expect(exports).toContain('User');
			expect(exports).toContain('Role');
		});

		it('deduplicates exports', () => {
			const content = `export function foo() {}\nexport function foo() {}`;
			expect(extractExports(content)).toEqual(['foo']);
		});

		it('caps at 20 exports', () => {
			const lines = Array.from({ length: 25 }, (_, i) => `export function fn${i}() {}`);
			expect(extractExports(lines.join('\n')).length).toBe(20);
		});
	});

	describe('extractImports', () => {
		it('extracts ES named imports', () => {
			const content = `import { login, register } from './auth';`;
			const imports = extractImports(content);
			expect(imports).toHaveLength(1);
			expect(imports[0].source).toBe('./auth');
			expect(imports[0].symbols).toEqual(['login', 'register']);
		});

		it('extracts ES default imports', () => {
			const content = `import AuthService from '../services/auth';`;
			const imports = extractImports(content);
			expect(imports).toHaveLength(1);
			expect(imports[0].symbols).toEqual(['AuthService']);
		});

		it('extracts require calls', () => {
			const content = `const fs = require('fs');`;
			const imports = extractImports(content);
			expect(imports).toHaveLength(1);
			expect(imports[0].source).toBe('fs');
		});

		it('extracts Python from...import', () => {
			const content = `from auth.login import handle_login, verify_token`;
			const imports = extractImports(content);
			expect(imports).toHaveLength(1);
			expect(imports[0].source).toBe('auth.login');
			expect(imports[0].symbols).toEqual(['handle_login', 'verify_token']);
		});

		it('handles aliased imports', () => {
			const content = `import { foo as bar } from './utils';`;
			const imports = extractImports(content);
			expect(imports[0].symbols).toEqual(['foo']);
		});
	});

	describe('analyzeModuleDependencies', () => {
		it('detects cross-module imports', async () => {
			const files: Record<string, string> = {
				'/project/src/auth/login.ts': `import { fetchUser } from '../services/api';`,
				'/project/src/services/api.ts': `export function fetchUser() {}`,
			};
			const reader = createMemoryReader(files);
			const modules = [
				{ name: 'auth', files: ['/project/src/auth/login.ts'], exports: [], fileCount: 1 },
				{ name: 'services', files: ['/project/src/services/api.ts'], exports: ['fetchUser'], fileCount: 1 },
			];
			const deps = await analyzeModuleDependencies(modules, reader, ROOT);
			expect(deps).toHaveLength(1);
			expect(deps[0].from).toBe('auth');
			expect(deps[0].to).toBe('services');
			expect(deps[0].importCount).toBe(1);
			expect(deps[0].importedSymbols).toContain('fetchUser');
		});

		it('skips intra-module imports', async () => {
			const files: Record<string, string> = {
				'/project/src/auth/login.ts': `import { hash } from './utils';`,
				'/project/src/auth/utils.ts': `export function hash() {}`,
			};
			const reader = createMemoryReader(files);
			const modules = [
				{ name: 'auth', files: ['/project/src/auth/login.ts', '/project/src/auth/utils.ts'], exports: [], fileCount: 2 },
			];
			const deps = await analyzeModuleDependencies(modules, reader, ROOT);
			expect(deps).toHaveLength(0);
		});
	});

	describe('buildProjectGraph', () => {
		it('builds a complete graph', async () => {
			const files: Record<string, string> = {
				'/project/src/auth/login.ts': `import { api } from '../services/client';\nexport function login() {}`,
				'/project/src/services/client.ts': `export function api() {}`,
			};
			const reader = createMemoryReader(files);
			const graph = await buildProjectGraph(reader, ROOT, undefined, 'my-app');
			expect(graph.projectName).toBe('my-app');
			expect(graph.modules.length).toBeGreaterThanOrEqual(2);

			const authMod = graph.modules.find(m => m.name === 'auth');
			expect(authMod?.exports).toContain('login');
		});
	});

	describe('generateProjectPrompt', () => {
		it('includes module names and dependencies in prompt (no docs fallback)', () => {
			const graph = {
				projectName: 'my-app',
				modules: [
					{ name: 'auth', files: [], exports: ['login', 'logout'], fileCount: 3 },
					{ name: 'api', files: [], exports: ['fetchUser'], fileCount: 2 },
				],
				dependencies: [
					{ from: 'auth', to: 'api', importCount: 2, importedSymbols: ['fetchUser'] },
				],
			};
			const prompt = generateProjectPrompt(graph);
			expect(prompt).toContain('my-app');
			expect(prompt).toContain('auth');
			expect(prompt).toContain('api');
			expect(prompt).toContain('auth --> api');
			expect(prompt).toContain('flowchart TD');
			// Without docs, should use module-structure prompt
			expect(prompt).toContain('module structure');
		});

		it('includes file counts', () => {
			const graph = {
				projectName: 'test',
				modules: [
					{ name: 'core', files: [], exports: [], fileCount: 15 },
				],
				dependencies: [],
			};
			const prompt = generateProjectPrompt(graph);
			expect(prompt).toContain('15 files');
		});

		it('generates feature-level prompt when documentation is present', () => {
			const graph = {
				projectName: 'solar-app',
				modules: [
					{ name: 'components', files: [], exports: ['Scene3D'], fileCount: 10 },
				],
				dependencies: [],
				documentation: {
					files: [{
						relativePath: 'CLAUDE.md',
						content: '# Solar Shadow Analyzer\nVisualizes sunlight patterns for buildings.',
						category: 'claude' as const,
						priority: 1,
					}],
					combinedContent: '--- CLAUDE.md ---\n# Solar Shadow Analyzer\nVisualizes sunlight patterns for buildings.',
					totalCharsRaw: 60,
					hasDocumentation: true,
				},
			};
			const prompt = generateProjectPrompt(graph);
			expect(prompt).toContain('FEATURE-LEVEL');
			expect(prompt).toContain('Solar Shadow Analyzer');
			expect(prompt).toContain('PRIMARY context');
			expect(prompt).toContain('SUPPLEMENTARY context');
			// Should NOT contain module-structure language
			expect(prompt).not.toContain('module structure');
		});

		it('falls back to module-structure when hasDocumentation is false', () => {
			const graph = {
				projectName: 'minimal-app',
				modules: [
					{ name: 'src', files: [], exports: [], fileCount: 5 },
				],
				dependencies: [],
				documentation: {
					files: [{
						relativePath: 'package.json',
						content: 'Name: minimal-app',
						category: 'package' as const,
						priority: 10,
					}],
					combinedContent: '--- package.json ---\nName: minimal-app',
					totalCharsRaw: 17,
					hasDocumentation: false,  // only package.json, no real docs
				},
			};
			const prompt = generateProjectPrompt(graph);
			expect(prompt).toContain('module structure');
			expect(prompt).not.toContain('FEATURE-LEVEL');
		});
	});
});
