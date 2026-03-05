import { describe, it, expect } from 'vitest';
import { generateTldr, serializeTldr } from '../src/TldrWriter';
import type { CallGraph } from '../src/types';

describe('TldrWriter', () => {
	const sampleGraph: CallGraph = {
		fileName: 'src/auth/login.ts',
		language: 'typescript',
		nodes: [
			{ id: 'func-handleLogin', name: 'handleLogin', type: 'function', line: 5 },
			{ id: 'func-validateCredentials', name: 'validateCredentials', type: 'function', line: 15 },
			{ id: 'func-hashPassword', name: 'hashPassword', type: 'function', line: 30 },
		],
		edges: [
			{ from: 'func-handleLogin', to: 'func-validateCredentials' },
			{ from: 'func-validateCredentials', to: 'func-hashPassword' },
		],
	};

	it('generates valid .tldr JSON structure', () => {
		const tldr = generateTldr(sampleGraph);

		expect(tldr.tldrawFileFormatVersion).toBe(1);
		expect(tldr.schema).toBeDefined();
		expect(tldr.schema.schemaVersion).toBe(2);
		expect(Array.isArray(tldr.records)).toBe(true);
	});

	it('includes document and page records', () => {
		const tldr = generateTldr(sampleGraph);
		const doc = tldr.records.find((r) => r.id === 'document:document') as Record<string, any>;
		const page = tldr.records.find((r) => r.id === 'page:page');

		expect(doc).toBeDefined();
		expect(doc.gridSize).toBe(10);
		expect(page).toBeDefined();
	});

	it('creates geo shapes for each node', () => {
		const tldr = generateTldr(sampleGraph);
		const shapes = tldr.records.filter(
			(r) => r.typeName === 'shape' && r.type === 'geo',
		);

		expect(shapes).toHaveLength(3);
		expect(shapes[0].props).toMatchObject({
			geo: 'rectangle',
			text: 'handleLogin()',
			color: 'blue',
			font: 'mono',
		});
	});

	it('creates arrow shapes for each edge', () => {
		const tldr = generateTldr(sampleGraph);
		const arrows = tldr.records.filter(
			(r) => r.typeName === 'shape' && r.type === 'arrow',
		);

		expect(arrows).toHaveLength(2);
	});

	it('creates bindings connecting arrows to shapes', () => {
		const tldr = generateTldr(sampleGraph);
		const bindings = tldr.records.filter(
			(r) => r.typeName === 'binding',
		);

		// 2 edges × 2 bindings each (start + end) = 4
		expect(bindings).toHaveLength(4);
	});

	it('stores source metadata on shapes', () => {
		const tldr = generateTldr(sampleGraph);
		const shapes = tldr.records.filter(
			(r) => r.typeName === 'shape' && r.type === 'geo',
		);

		expect(shapes[0].meta).toMatchObject({
			sourceLine: 5,
			sourceType: 'function',
			sourceName: 'handleLogin',
		});
	});

	it('stores viz metadata in document record', () => {
		const tldr = generateTldr(sampleGraph, {
			sourceFile: 'src/auth/login.ts',
			sourceHash: 'abc123',
			type: 'file',
		});

		const doc = tldr.records.find((r) => r.id === 'document:document') as Record<string, any>;
		expect(doc.meta.tldrawViz).toMatchObject({
			sourceFile: 'src/auth/login.ts',
			sourceHash: 'abc123',
			type: 'file',
		});
	});

	it('serializes to valid JSON', () => {
		const tldr = generateTldr(sampleGraph);
		const json = serializeTldr(tldr);

		expect(() => JSON.parse(json)).not.toThrow();
		const parsed = JSON.parse(json);
		expect(parsed.tldrawFileFormatVersion).toBe(1);
	});

	it('handles empty graph', () => {
		const emptyGraph: CallGraph = {
			fileName: 'empty.ts',
			language: 'typescript',
			nodes: [],
			edges: [],
		};
		const tldr = generateTldr(emptyGraph);

		expect(tldr.records.filter((r) => r.typeName === 'shape')).toHaveLength(0);
	});

	it('handles edges referencing non-existent nodes', () => {
		const graph: CallGraph = {
			fileName: 'test.ts',
			language: 'typescript',
			nodes: [
				{ id: 'func-a', name: 'a', type: 'function', line: 1 },
			],
			edges: [
				{ from: 'func-a', to: 'func-nonexistent' },
			],
		};
		const tldr = generateTldr(graph);
		const arrows = tldr.records.filter(
			(r) => r.typeName === 'shape' && r.type === 'arrow',
		);

		// Edge to non-existent node should be skipped
		expect(arrows).toHaveLength(0);
	});

	it('formats method names with parent class', () => {
		const graph: CallGraph = {
			fileName: 'test.ts',
			language: 'typescript',
			nodes: [
				{ id: 'method-doSomething', name: 'doSomething', type: 'method', line: 10, parent: 'MyClass' },
			],
			edges: [],
		};
		const tldr = generateTldr(graph);
		const shape = tldr.records.find(
			(r) => r.typeName === 'shape' && r.type === 'geo',
		) as Record<string, any>;

		expect(shape.props.text).toBe('MyClass.doSomething()');
		expect(shape.props.color).toBe('green');
	});
});
