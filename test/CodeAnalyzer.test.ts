import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { initParser, parseSource, extractNodes } from '../src/CodeAnalyzer';
import { getLanguageConfigByKey } from '../src/languages';

const fixturesDir = path.join(__dirname, 'fixtures');

function readFixture(filename: string): string {
	return fs.readFileSync(path.join(fixturesDir, filename), 'utf-8');
}

beforeAll(async () => {
	await initParser();
});

describe('CodeAnalyzer', () => {
	describe('TypeScript', () => {
		it('extracts function declarations', async () => {
			const config = getLanguageConfigByKey('typescript')!;
			const source = readFixture('simple.ts');
			const tree = await parseSource(source, config);
			const nodes = extractNodes(tree, config);

			expect(nodes.length).toBe(5);
			expect(nodes.map(n => n.name)).toEqual([
				'handleLogin',
				'validateCredentials',
				'hashPassword',
				'checkDatabase',
				'createSession',
			]);
			expect(nodes.every(n => n.type === 'function')).toBe(true);
		});

		it('records correct line numbers', async () => {
			const config = getLanguageConfigByKey('typescript')!;
			const source = readFixture('simple.ts');
			const tree = await parseSource(source, config);
			const nodes = extractNodes(tree, config);

			expect(nodes[0].line).toBe(1);  // handleLogin
			expect(nodes[1].line).toBe(9);  // validateCredentials
			expect(nodes[2].line).toBe(14); // hashPassword
		});
	});

	describe('JavaScript', () => {
		it('extracts function declarations', async () => {
			const config = getLanguageConfigByKey('javascript')!;
			const source = readFixture('simple.js');
			const tree = await parseSource(source, config);
			const nodes = extractNodes(tree, config);

			expect(nodes.length).toBe(4);
			expect(nodes.map(n => n.name)).toEqual([
				'processOrder',
				'validateOrder',
				'calculateTotal',
				'applyDiscount',
			]);
		});
	});

	describe('Python', () => {
		it('extracts function definitions', async () => {
			const config = getLanguageConfigByKey('python')!;
			const source = readFixture('simple.py');
			const tree = await parseSource(source, config);
			const nodes = extractNodes(tree, config);

			expect(nodes.length).toBe(6);
			expect(nodes.map(n => n.name)).toEqual([
				'handle_request',
				'validate_input',
				'process_data',
				'sanitize',
				'transform',
				'format_response',
			]);
			expect(nodes.every(n => n.type === 'function')).toBe(true);
		});
	});

	describe('Go', () => {
		it('extracts function declarations', async () => {
			const config = getLanguageConfigByKey('go')!;
			const source = readFixture('simple.go');
			const tree = await parseSource(source, config);
			const nodes = extractNodes(tree, config);

			expect(nodes.length).toBe(4);
			expect(nodes.map(n => n.name)).toEqual([
				'main',
				'processInput',
				'validate',
				'transform',
			]);
		});
	});

	describe('Rust', () => {
		it('extracts function items', async () => {
			const config = getLanguageConfigByKey('rust')!;
			const source = readFixture('simple.rs');
			const tree = await parseSource(source, config);
			const nodes = extractNodes(tree, config);

			expect(nodes.length).toBe(6);
			expect(nodes.map(n => n.name)).toEqual([
				'main',
				'read_input',
				'process',
				'validate',
				'transform',
				'output',
			]);
		});
	});

	describe('Java', () => {
		it('extracts method declarations with class parent', async () => {
			const config = getLanguageConfigByKey('java')!;
			const source = readFixture('Simple.java');
			const tree = await parseSource(source, config);
			const nodes = extractNodes(tree, config);

			const methods = nodes.filter(n => n.type === 'method');
			expect(methods.length).toBe(5);
			expect(methods.map(n => n.name)).toEqual([
				'handleRequest',
				'validate',
				'process',
				'transform',
				'respond',
			]);
			expect(methods.every(n => n.parent === 'Simple')).toBe(true);

			const classes = nodes.filter(n => n.type === 'class');
			expect(classes.length).toBe(1);
			expect(classes[0].name).toBe('Simple');
		});
	});
});
