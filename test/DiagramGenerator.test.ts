import { describe, it, expect } from 'vitest';
import { layoutCallGraph } from '../src/DiagramGenerator';
import { generateTldr } from '../src/TldrWriter';
import type { CallGraph } from '../src/types';

describe('DiagramGenerator (dagre layout)', () => {
	const sampleGraph: CallGraph = {
		fileName: 'src/auth/login.ts',
		language: 'typescript',
		nodes: [
			{ id: 'function-handleLogin', name: 'handleLogin', type: 'function', line: 1 },
			{ id: 'function-validateCredentials', name: 'validateCredentials', type: 'function', line: 9 },
			{ id: 'function-hashPassword', name: 'hashPassword', type: 'function', line: 14 },
			{ id: 'function-checkDatabase', name: 'checkDatabase', type: 'function', line: 18 },
			{ id: 'function-createSession', name: 'createSession', type: 'function', line: 22 },
		],
		edges: [
			{ from: 'function-handleLogin', to: 'function-validateCredentials' },
			{ from: 'function-handleLogin', to: 'function-createSession' },
			{ from: 'function-validateCredentials', to: 'function-hashPassword' },
			{ from: 'function-validateCredentials', to: 'function-checkDatabase' },
		],
	};

	it('produces positioned nodes for all input nodes', () => {
		const positioned = layoutCallGraph(sampleGraph);
		expect(positioned).toHaveLength(5);
		expect(positioned.every(n => typeof n.x === 'number' && typeof n.y === 'number')).toBe(true);
	});

	it('places root node above its children', () => {
		const positioned = layoutCallGraph(sampleGraph);
		const root = positioned.find(n => n.id === 'function-handleLogin')!;
		const child = positioned.find(n => n.id === 'function-validateCredentials')!;

		expect(root.y).toBeLessThan(child.y);
	});

	it('places all nodes at consistent width/height', () => {
		const positioned = layoutCallGraph(sampleGraph);
		const firstWidth = positioned[0].width;
		const firstHeight = positioned[0].height;

		expect(positioned.every(n => n.width === firstWidth && n.height === firstHeight)).toBe(true);
	});

	it('handles empty graph', () => {
		const emptyGraph: CallGraph = {
			fileName: 'empty.ts',
			language: 'typescript',
			nodes: [],
			edges: [],
		};
		const positioned = layoutCallGraph(emptyGraph);
		expect(positioned).toHaveLength(0);
	});

	it('handles disconnected nodes', () => {
		const graph: CallGraph = {
			fileName: 'test.ts',
			language: 'typescript',
			nodes: [
				{ id: 'function-a', name: 'a', type: 'function', line: 1 },
				{ id: 'function-b', name: 'b', type: 'function', line: 5 },
			],
			edges: [],
		};
		const positioned = layoutCallGraph(graph);
		expect(positioned).toHaveLength(2);
		// Both should have valid positions
		expect(positioned[0].x).toBeDefined();
		expect(positioned[1].x).toBeDefined();
	});

	it('integrates with TldrWriter via positioned nodes', () => {
		const positioned = layoutCallGraph(sampleGraph);
		const tldr = generateTldr(sampleGraph, undefined, positioned);

		const shapes = tldr.records.filter(
			(r: any) => r.typeName === 'shape' && r.type === 'geo',
		);
		expect(shapes).toHaveLength(5);

		// Verify dagre positions are used (not grid layout)
		const root = shapes.find((s: any) => s.id === 'shape:function-handleLogin');
		const child = shapes.find((s: any) => s.id === 'shape:function-validateCredentials');
		expect(root.y).toBeLessThan(child.y);
	});
});
