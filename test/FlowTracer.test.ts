import { describe, it, expect, beforeAll } from 'vitest';
import { initParser } from '../src/CodeAnalyzer';
import { traceFlow, type FileReader } from '../src/FlowTracer';

/** In-memory file reader for testing */
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

beforeAll(async () => {
	await initParser();
});

describe('FlowTracer', () => {
	it('traces a single-file flow', async () => {
		const reader = createMemoryReader({
			'/project/src/auth/login.ts': `
function handleLogin(username: string) {
	validateCredentials(username);
}

function validateCredentials(username: string) {
	return true;
}
`,
		});

		const flow = await traceFlow(
			'/project/src/auth/login.ts',
			'handleLogin',
			'login-flow',
			reader,
		);

		expect(flow.name).toBe('login-flow');
		expect(flow.nodes.length).toBeGreaterThanOrEqual(1);

		const handleLogin = flow.nodes.find(n => n.name === 'handleLogin');
		expect(handleLogin).toBeDefined();
		expect(handleLogin!.sourceFile).toBe('/project/src/auth/login.ts');
	});

	it('returns empty flow for non-existent entrypoint', async () => {
		const reader = createMemoryReader({
			'/project/src/main.ts': `function other() {}`,
		});

		const flow = await traceFlow(
			'/project/src/main.ts',
			'nonExistent',
			'test-flow',
			reader,
		);

		expect(flow.nodes).toHaveLength(0);
	});

	it('handles missing files gracefully', async () => {
		const reader = createMemoryReader({});

		const flow = await traceFlow(
			'/project/src/missing.ts',
			'main',
			'test-flow',
			reader,
		);

		expect(flow.nodes).toHaveLength(0);
		expect(flow.edges).toHaveLength(0);
	});

	it('respects max depth limit', async () => {
		const reader = createMemoryReader({
			'/project/src/a.ts': `
import { b } from './b';
function a() { b(); }
`,
			'/project/src/b.ts': `
import { c } from './c';
export function b() { c(); }
`,
			'/project/src/c.ts': `
export function c() { }
`,
		});

		const flow = await traceFlow(
			'/project/src/a.ts',
			'a',
			'deep-flow',
			reader,
			0, // maxDepth=0, should only process entrypoint file
		);

		// With depth 0, should only get the entrypoint function
		expect(flow.nodes.length).toBeLessThanOrEqual(2);
	});
});
