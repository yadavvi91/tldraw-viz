import { describe, it, expect } from 'vitest';
import { generateTldr, serializeTldr } from '../src/TldrWriter';
import type { CallGraph, LayoutResult } from '../src/types';

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

	describe('.tldr format compatibility', () => {
		it('includes gridSize on document record', () => {
			const tldr = generateTldr(sampleGraph);
			const doc = tldr.records.find((r) => r.id === 'document:document') as Record<string, any>;
			expect(doc.gridSize).toBe(10);
		});

		it('includes scale on geo shape props', () => {
			const tldr = generateTldr(sampleGraph);
			const shapes = tldr.records.filter(
				(r) => r.typeName === 'shape' && r.type === 'geo',
			);
			for (const shape of shapes) {
				expect((shape as Record<string, any>).props.scale).toBe(1);
			}
		});

		it('includes scale on arrow shape props', () => {
			const tldr = generateTldr(sampleGraph);
			const arrows = tldr.records.filter(
				(r) => r.typeName === 'shape' && r.type === 'arrow',
			);
			for (const arrow of arrows) {
				expect((arrow as Record<string, any>).props.scale).toBe(1);
			}
		});

		it('includes all required schema sequences', () => {
			const tldr = generateTldr(sampleGraph);
			const sequences = tldr.schema.sequences;

			expect(sequences).toHaveProperty('com.tldraw.store');
			expect(sequences).toHaveProperty('com.tldraw.asset');
			expect(sequences).toHaveProperty('com.tldraw.camera');
			expect(sequences).toHaveProperty('com.tldraw.document');
			expect(sequences).toHaveProperty('com.tldraw.instance');
			expect(sequences).toHaveProperty('com.tldraw.instance_page_state');
			expect(sequences).toHaveProperty('com.tldraw.page');
			expect(sequences).toHaveProperty('com.tldraw.pointer');
			expect(sequences).toHaveProperty('com.tldraw.instance_presence');
			expect(sequences).toHaveProperty('com.tldraw.shape');
			expect(sequences).toHaveProperty('com.tldraw.shape.arrow');
			expect(sequences).toHaveProperty('com.tldraw.shape.frame');
			expect(sequences).toHaveProperty('com.tldraw.shape.geo');
			expect(sequences).toHaveProperty('com.tldraw.shape.text');
			expect(sequences).toHaveProperty('com.tldraw.binding');
			expect(sequences).toHaveProperty('com.tldraw.binding.arrow');
		});

		it('produces a .tldr that matches the expected tldraw structure', () => {
			const tldr = generateTldr(sampleGraph);
			const json = serializeTldr(tldr);
			const parsed = JSON.parse(json);

			expect(parsed.tldrawFileFormatVersion).toBe(1);
			expect(parsed.schema.schemaVersion).toBe(2);
			expect(Object.keys(parsed.schema.sequences).length).toBeGreaterThanOrEqual(15);

			const doc = parsed.records.find((r: any) => r.typeName === 'document');
			expect(doc.gridSize).toBe(10);

			const geos = parsed.records.filter((r: any) => r.typeName === 'shape' && r.type === 'geo');
			for (const geo of geos) {
				expect(geo.props.scale).toBe(1);
			}

			const arrows = parsed.records.filter((r: any) => r.typeName === 'shape' && r.type === 'arrow');
			for (const arrow of arrows) {
				expect(arrow.props.scale).toBe(1);
			}
		});
	});

	describe('role-based shapes and colors', () => {
		it('maps node roles to tldraw geo shapes', () => {
			const graph: CallGraph = {
				fileName: 'test.tsx',
				language: 'typescriptreact',
				nodes: [
					{ id: 'f1', name: 'check', type: 'function', line: 1, role: 'decision', shape: 'diamond' },
					{ id: 'f2', name: 'handle', type: 'function', line: 5, role: 'user-action', shape: 'oval' },
					{ id: 'f3', name: 'Parent', type: 'function', line: 0, role: 'parent', shape: 'cloud' },
					{ id: 'f4', name: 'App', type: 'function', line: 10, role: 'entrypoint', shape: 'ellipse' },
				],
				edges: [],
			};
			const tldr = generateTldr(graph);
			const shapes = tldr.records.filter(
				(r) => r.typeName === 'shape' && r.type === 'geo',
			) as Record<string, any>[];

			const diamond = shapes.find(s => s.id === 'shape:f1')!;
			const oval = shapes.find(s => s.id === 'shape:f2')!;
			const cloud = shapes.find(s => s.id === 'shape:f3')!;
			const ellipse = shapes.find(s => s.id === 'shape:f4')!;

			expect(diamond.props.geo).toBe('diamond');
			expect(diamond.props.color).toBe('violet');

			expect(oval.props.geo).toBe('oval');
			expect(oval.props.color).toBe('blue');

			expect(cloud.props.geo).toBe('cloud');
			expect(cloud.props.color).toBe('light-red');

			expect(ellipse.props.geo).toBe('ellipse');
			expect(ellipse.props.color).toBe('light-blue');
		});

		it('respects explicit node.color override', () => {
			const graph: CallGraph = {
				fileName: 'test.tsx',
				language: 'typescriptreact',
				nodes: [
					{ id: 'f1', name: 'format', type: 'function', line: 1, role: 'display', shape: 'rectangle', color: 'orange' },
				],
				edges: [],
			};
			const tldr = generateTldr(graph);
			const shape = tldr.records.find(
				(r) => r.typeName === 'shape' && r.type === 'geo',
			) as Record<string, any>;

			expect(shape.props.color).toBe('orange');
		});

		it('stores role in shape metadata', () => {
			const graph: CallGraph = {
				fileName: 'test.tsx',
				language: 'typescriptreact',
				nodes: [
					{ id: 'f1', name: 'check', type: 'function', line: 1, role: 'decision', shape: 'diamond' },
				],
				edges: [],
			};
			const tldr = generateTldr(graph);
			const shape = tldr.records.find(
				(r) => r.typeName === 'shape' && r.type === 'geo',
			) as Record<string, any>;

			expect(shape.meta.role).toBe('decision');
		});
	});

	describe('edge labels and styles', () => {
		it('renders edge labels as arrow text', () => {
			const graph: CallGraph = {
				fileName: 'test.tsx',
				language: 'typescriptreact',
				nodes: [
					{ id: 'f1', name: 'handler', type: 'function', line: 1 },
					{ id: 'f2', name: 'parent', type: 'function', line: 5 },
				],
				edges: [
					{ from: 'f1', to: 'f2', label: 'to parent', style: 'solid' },
				],
			};
			const tldr = generateTldr(graph);
			const arrow = tldr.records.find(
				(r) => r.typeName === 'shape' && r.type === 'arrow',
			) as Record<string, any>;

			expect(arrow.props.text).toBe('to parent');
			expect(arrow.props.dash).toBe('solid');
		});

		it('maps edge styles to tldraw dash values', () => {
			const graph: CallGraph = {
				fileName: 'test.tsx',
				language: 'typescriptreact',
				nodes: [
					{ id: 'f1', name: 'a', type: 'function', line: 1 },
					{ id: 'f2', name: 'b', type: 'function', line: 5 },
					{ id: 'f3', name: 'c', type: 'function', line: 10 },
				],
				edges: [
					{ from: 'f1', to: 'f2', style: 'dotted' },
					{ from: 'f1', to: 'f3', style: 'dashed' },
				],
			};
			const tldr = generateTldr(graph);
			const arrows = tldr.records.filter(
				(r) => r.typeName === 'shape' && r.type === 'arrow',
			) as Record<string, any>[];

			const dotted = arrows.find(a => a.id.includes('f1-f2'))!;
			const dashed = arrows.find(a => a.id.includes('f1-f3'))!;

			expect(dotted.props.dash).toBe('dotted');
			expect(dashed.props.dash).toBe('dashed');
		});

		it('uses solid dash and sans font by default for arrows', () => {
			const tldr = generateTldr(sampleGraph);
			const arrow = tldr.records.find(
				(r) => r.typeName === 'shape' && r.type === 'arrow',
			) as Record<string, any>;

			expect(arrow.props.dash).toBe('solid');
			expect(arrow.props.font).toBe('sans');
		});
	});

	describe('frame shapes for groups', () => {
		it('creates frame shapes for groups in LayoutResult', () => {
			const graph: CallGraph = {
				fileName: 'test.tsx',
				language: 'typescriptreact',
				nodes: [
					{ id: 'f1', name: 'handleClick', type: 'function', line: 1, groupId: 'group-ui' },
					{ id: 'f2', name: 'processData', type: 'function', line: 5, groupId: 'group-logic' },
				],
				edges: [{ from: 'f1', to: 'f2' }],
				groups: [
					{ id: 'group-ui', label: 'User Interactions', nodeIds: ['f1'] },
					{ id: 'group-logic', label: 'Logic', nodeIds: ['f2'] },
				],
			};

			const layoutResult: LayoutResult = {
				nodes: [
					{ ...graph.nodes[0], x: 50, y: 50, width: 280, height: 60 },
					{ ...graph.nodes[1], x: 50, y: 250, width: 280, height: 60 },
				],
				groups: [
					{ id: 'group-ui', label: 'User Interactions', nodeIds: ['f1'], x: 10, y: 10, width: 360, height: 140 },
					{ id: 'group-logic', label: 'Logic', nodeIds: ['f2'], x: 10, y: 200, width: 360, height: 140 },
				],
			};

			const tldr = generateTldr(graph, undefined, layoutResult);

			const frames = tldr.records.filter(
				(r) => r.typeName === 'shape' && r.type === 'frame',
			) as Record<string, any>[];

			expect(frames).toHaveLength(2);
			expect(frames[0].props.name).toBe('User Interactions');
			expect(frames[1].props.name).toBe('Logic');
		});

		it('parents child shapes inside frame shapes', () => {
			const graph: CallGraph = {
				fileName: 'test.tsx',
				language: 'typescriptreact',
				nodes: [
					{ id: 'f1', name: 'handler', type: 'function', line: 1, groupId: 'group-ui' },
				],
				edges: [],
				groups: [
					{ id: 'group-ui', label: 'User Interactions', nodeIds: ['f1'] },
				],
			};

			const layoutResult: LayoutResult = {
				nodes: [
					{ ...graph.nodes[0], x: 50, y: 50, width: 280, height: 60 },
				],
				groups: [
					{ id: 'group-ui', label: 'User Interactions', nodeIds: ['f1'], x: 10, y: 10, width: 360, height: 140 },
				],
			};

			const tldr = generateTldr(graph, undefined, layoutResult);

			const geoShape = tldr.records.find(
				(r) => r.typeName === 'shape' && r.type === 'geo',
			) as Record<string, any>;

			// Child shape should be parented to the frame
			expect(geoShape.parentId).toBe('shape:frame-group-ui');

			// Coordinates should be relative to frame
			expect(geoShape.x).toBe(40); // 50 - 10
			expect(geoShape.y).toBe(40); // 50 - 10
		});

		it('includes frame schema sequence', () => {
			const tldr = generateTldr(sampleGraph);
			expect(tldr.schema.sequences).toHaveProperty('com.tldraw.shape.frame');
		});
	});

	describe('node labels', () => {
		it('uses node.label as display text when set', () => {
			const graph: CallGraph = {
				fileName: 'test.tsx',
				language: 'typescriptreact',
				nodes: [
					{ id: 'pickDate', name: 'pickDate', type: 'function', line: 0, label: 'User picks a date' },
					{ id: 'parseDate', name: 'parseDate', type: 'function', line: 0 },
				],
				edges: [],
			};
			const tldr = generateTldr(graph);
			const geos = tldr.records.filter(
				(r) => r.typeName === 'shape' && r.type === 'geo',
			) as Record<string, any>[];

			const labeled = geos.find(g => g.id === 'shape:pickDate')!;
			const unlabeled = geos.find(g => g.id === 'shape:parseDate')!;

			expect(labeled.props.text).toBe('User picks a date');
			expect(unlabeled.props.text).toBe('parseDate()');
		});
	});
});
