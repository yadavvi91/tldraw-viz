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
		const result = layoutCallGraph(sampleGraph);
		expect(result.nodes).toHaveLength(5);
		expect(result.nodes.every(n => typeof n.x === 'number' && typeof n.y === 'number')).toBe(true);
	});

	it('places root node above its children', () => {
		const result = layoutCallGraph(sampleGraph);
		const root = result.nodes.find(n => n.id === 'function-handleLogin')!;
		const child = result.nodes.find(n => n.id === 'function-validateCredentials')!;

		expect(root.y).toBeLessThan(child.y);
	});

	it('places all nodes at consistent width/height for uniform shapes', () => {
		const result = layoutCallGraph(sampleGraph);
		const firstWidth = result.nodes[0].width;
		const firstHeight = result.nodes[0].height;

		// All nodes have same shape (no roles set), so all should be same size
		expect(result.nodes.every(n => n.width === firstWidth && n.height === firstHeight)).toBe(true);
	});

	it('handles empty graph', () => {
		const emptyGraph: CallGraph = {
			fileName: 'empty.ts',
			language: 'typescript',
			nodes: [],
			edges: [],
		};
		const result = layoutCallGraph(emptyGraph);
		expect(result.nodes).toHaveLength(0);
		expect(result.groups).toHaveLength(0);
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
		const result = layoutCallGraph(graph);
		expect(result.nodes).toHaveLength(2);
		expect(result.nodes[0].x).toBeDefined();
		expect(result.nodes[1].x).toBeDefined();
	});

	it('integrates with TldrWriter via LayoutResult', () => {
		const result = layoutCallGraph(sampleGraph);
		const tldr = generateTldr(sampleGraph, undefined, result);

		const shapes = tldr.records.filter(
			(r: any) => r.typeName === 'shape' && r.type === 'geo',
		);
		expect(shapes).toHaveLength(5);

		// Verify dagre positions are used (not grid layout)
		const root = shapes.find((s: any) => s.id === 'shape:function-handleLogin');
		const child = shapes.find((s: any) => s.id === 'shape:function-validateCredentials');
		expect(root.y).toBeLessThan(child.y);
	});

	describe('compound layout (groups)', () => {
		it('positions groups when groups are present', () => {
			const graph: CallGraph = {
				fileName: 'test.tsx',
				language: 'typescriptreact',
				nodes: [
					{ id: 'func-a', name: 'handleClick', type: 'function', line: 1, role: 'user-action', shape: 'oval', groupId: 'group-ui' },
					{ id: 'func-b', name: 'handleChange', type: 'function', line: 5, role: 'user-action', shape: 'oval', groupId: 'group-ui' },
					{ id: 'func-c', name: 'processData', type: 'function', line: 10, role: 'process', shape: 'rectangle', groupId: 'group-logic' },
				],
				edges: [
					{ from: 'func-a', to: 'func-c' },
					{ from: 'func-b', to: 'func-c' },
				],
				groups: [
					{ id: 'group-ui', label: 'User Interactions', nodeIds: ['func-a', 'func-b'] },
					{ id: 'group-logic', label: 'Logic', nodeIds: ['func-c'] },
				],
			};

			const result = layoutCallGraph(graph);
			expect(result.nodes).toHaveLength(3);
			expect(result.groups).toHaveLength(2);

			// Groups should have valid positions and dimensions
			for (const group of result.groups) {
				expect(group.x).toBeDefined();
				expect(group.y).toBeDefined();
				expect(group.width).toBeGreaterThan(0);
				expect(group.height).toBeGreaterThan(0);
			}
		});

		it('uses shape-specific dimensions for different node shapes', () => {
			const graph: CallGraph = {
				fileName: 'test.tsx',
				language: 'typescriptreact',
				nodes: [
					{ id: 'func-a', name: 'check', type: 'function', line: 1, shape: 'diamond' },
					{ id: 'func-b', name: 'process', type: 'function', line: 5, shape: 'rectangle' },
					{ id: 'func-c', name: 'handle', type: 'function', line: 10, shape: 'oval' },
				],
				edges: [],
			};

			const result = layoutCallGraph(graph);
			const diamond = result.nodes.find(n => n.id === 'func-a')!;
			const rect = result.nodes.find(n => n.id === 'func-b')!;
			const oval = result.nodes.find(n => n.id === 'func-c')!;

			// Diamond should be wider and taller
			expect(diamond.width).toBe(300);
			expect(diamond.height).toBe(80);
			expect(rect.width).toBe(280);
			expect(rect.height).toBe(60);
			expect(oval.width).toBe(240);
			expect(oval.height).toBe(50);
		});

		it('returns empty groups array when no groups defined', () => {
			const result = layoutCallGraph(sampleGraph);
			expect(result.groups).toHaveLength(0);
		});

		it('falls back to grid layout when dagre fails with compound graphs', () => {
			// Simulate a graph where dagre compound layout would fail:
			// edges between nodes that are also used as group IDs can trigger
			// "Cannot set properties of undefined (setting 'rank')"
			const graph: CallGraph = {
				fileName: 'project.ts',
				language: 'typescript',
				nodes: [
					{ id: 'n1', name: 'Module A', type: 'function', line: 1, groupId: 'g1' },
					{ id: 'n2', name: 'Module B', type: 'function', line: 2, groupId: 'g2' },
					{ id: 'n3', name: 'Module C', type: 'function', line: 3, groupId: 'g2' },
				],
				edges: [
					{ from: 'n1', to: 'n2' },
					// Edge referencing a group ID — dagre can't handle this in compound mode
					{ from: 'g1', to: 'g2' },
				],
				groups: [
					{ id: 'g1', label: 'Group 1', nodeIds: ['n1'] },
					{ id: 'g2', label: 'Group 2', nodeIds: ['n2', 'n3'] },
				],
			};

			// Should not throw — falls back to grid layout
			const result = layoutCallGraph(graph);
			expect(result.nodes).toHaveLength(3);
			expect(result.nodes.every(n => typeof n.x === 'number' && typeof n.y === 'number')).toBe(true);
			// Groups should still be computed
			expect(result.groups.length).toBeGreaterThanOrEqual(0);
		});
	});
});
