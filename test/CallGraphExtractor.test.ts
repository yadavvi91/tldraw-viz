import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { initParser, parseSource, extractNodes } from '../src/CodeAnalyzer';
import { extractEdges } from '../src/CallGraphExtractor';
import { getLanguageConfigByKey } from '../src/languages';

const fixturesDir = path.join(__dirname, 'fixtures');

function readFixture(filename: string): string {
	return fs.readFileSync(path.join(fixturesDir, filename), 'utf-8');
}

beforeAll(async () => {
	await initParser();
});

describe('CallGraphExtractor', () => {
	describe('TypeScript', () => {
		it('extracts intra-file call edges', async () => {
			const config = getLanguageConfigByKey('typescript')!;
			const source = readFixture('simple.ts');
			const tree = await parseSource(source, config);
			const nodes = extractNodes(tree, config);
			const edges = extractEdges(tree, config, nodes);

			expect(edges.length).toBe(4);
			expect(edges).toContainEqual({
				from: 'function-handleLogin',
				to: 'function-validateCredentials',
			});
			expect(edges).toContainEqual({
				from: 'function-handleLogin',
				to: 'function-createSession',
			});
			expect(edges).toContainEqual({
				from: 'function-validateCredentials',
				to: 'function-hashPassword',
			});
			expect(edges).toContainEqual({
				from: 'function-validateCredentials',
				to: 'function-checkDatabase',
			});
		});

		it('does not create self-edges', async () => {
			const config = getLanguageConfigByKey('typescript')!;
			const source = `
function recursive(n: number): number {
	if (n <= 1) return 1;
	return recursive(n - 1);
}`;
			const tree = await parseSource(source, config);
			const nodes = extractNodes(tree, config);
			const edges = extractEdges(tree, config, nodes);

			expect(edges.length).toBe(0);
		});

		it('deduplicates edges', async () => {
			const config = getLanguageConfigByKey('typescript')!;
			const source = `
function caller() {
	helper();
	helper();
	helper();
}
function helper() {}`;
			const tree = await parseSource(source, config);
			const nodes = extractNodes(tree, config);
			const edges = extractEdges(tree, config, nodes);

			expect(edges.length).toBe(1);
		});
	});

	describe('JavaScript', () => {
		it('extracts call edges', async () => {
			const config = getLanguageConfigByKey('javascript')!;
			const source = readFixture('simple.js');
			const tree = await parseSource(source, config);
			const nodes = extractNodes(tree, config);
			const edges = extractEdges(tree, config, nodes);

			expect(edges.length).toBe(3);
			expect(edges).toContainEqual({
				from: 'function-processOrder',
				to: 'function-validateOrder',
			});
			expect(edges).toContainEqual({
				from: 'function-processOrder',
				to: 'function-calculateTotal',
			});
			expect(edges).toContainEqual({
				from: 'function-processOrder',
				to: 'function-applyDiscount',
			});
		});
	});

	describe('Python', () => {
		it('extracts call edges', async () => {
			const config = getLanguageConfigByKey('python')!;
			const source = readFixture('simple.py');
			const tree = await parseSource(source, config);
			const nodes = extractNodes(tree, config);
			const edges = extractEdges(tree, config, nodes);

			expect(edges.length).toBe(5);
			expect(edges).toContainEqual({
				from: 'function-handle_request',
				to: 'function-validate_input',
			});
			expect(edges).toContainEqual({
				from: 'function-handle_request',
				to: 'function-process_data',
			});
			expect(edges).toContainEqual({
				from: 'function-handle_request',
				to: 'function-format_response',
			});
			expect(edges).toContainEqual({
				from: 'function-process_data',
				to: 'function-sanitize',
			});
			expect(edges).toContainEqual({
				from: 'function-process_data',
				to: 'function-transform',
			});
		});
	});

	describe('Go', () => {
		it('extracts call edges', async () => {
			const config = getLanguageConfigByKey('go')!;
			const source = readFixture('simple.go');
			const tree = await parseSource(source, config);
			const nodes = extractNodes(tree, config);
			const edges = extractEdges(tree, config, nodes);

			expect(edges.length).toBe(3);
			expect(edges).toContainEqual({
				from: 'function-main',
				to: 'function-processInput',
			});
			expect(edges).toContainEqual({
				from: 'function-processInput',
				to: 'function-validate',
			});
			expect(edges).toContainEqual({
				from: 'function-processInput',
				to: 'function-transform',
			});
		});
	});

	describe('Rust', () => {
		it('extracts call edges', async () => {
			const config = getLanguageConfigByKey('rust')!;
			const source = readFixture('simple.rs');
			const tree = await parseSource(source, config);
			const nodes = extractNodes(tree, config);
			const edges = extractEdges(tree, config, nodes);

			expect(edges.length).toBe(5);
			expect(edges).toContainEqual({
				from: 'function-main',
				to: 'function-read_input',
			});
			expect(edges).toContainEqual({
				from: 'function-main',
				to: 'function-process',
			});
			expect(edges).toContainEqual({
				from: 'function-main',
				to: 'function-output',
			});
			expect(edges).toContainEqual({
				from: 'function-process',
				to: 'function-validate',
			});
			expect(edges).toContainEqual({
				from: 'function-process',
				to: 'function-transform',
			});
		});
	});

	describe('Java', () => {
		it('extracts call edges between methods', async () => {
			const config = getLanguageConfigByKey('java')!;
			const source = readFixture('Simple.java');
			const tree = await parseSource(source, config);
			const nodes = extractNodes(tree, config);
			const edges = extractEdges(tree, config, nodes);

			expect(edges.length).toBe(4);
			expect(edges).toContainEqual({
				from: 'method-handleRequest',
				to: 'method-validate',
			});
			expect(edges).toContainEqual({
				from: 'method-handleRequest',
				to: 'method-process',
			});
			expect(edges).toContainEqual({
				from: 'method-handleRequest',
				to: 'method-respond',
			});
			expect(edges).toContainEqual({
				from: 'method-process',
				to: 'method-transform',
			});
		});
	});
});
