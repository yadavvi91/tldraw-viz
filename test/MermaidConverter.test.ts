import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseMermaid } from '../src/MermaidParser';
import { mermaidToCallGraph } from '../src/MermaidConverter';
import { layoutCallGraph } from '../src/DiagramGenerator';
import { generateTldr, serializeTldr } from '../src/TldrWriter';

describe('MermaidConverter', () => {
	describe('shape mapping', () => {
		it('maps stadium to oval with user-action role', () => {
			const graph = parseMermaid('flowchart TD\n  A([Stadium])');
			const callGraph = mermaidToCallGraph(graph, 'test.mmd');
			const node = callGraph.nodes.find(n => n.id === 'A');
			expect(node?.shape).toBe('oval');
			expect(node?.role).toBe('user-action');
			expect(node?.color).toBe('blue');
		});

		it('maps diamond to diamond with decision role', () => {
			const graph = parseMermaid('flowchart TD\n  A{Diamond}');
			const callGraph = mermaidToCallGraph(graph, 'test.mmd');
			const node = callGraph.nodes.find(n => n.id === 'A');
			expect(node?.shape).toBe('diamond');
			expect(node?.role).toBe('decision');
			expect(node?.color).toBe('violet');
		});

		it('maps rectangle to rectangle with process role', () => {
			const graph = parseMermaid('flowchart TD\n  A[Rectangle]');
			const callGraph = mermaidToCallGraph(graph, 'test.mmd');
			const node = callGraph.nodes.find(n => n.id === 'A');
			expect(node?.shape).toBe('rectangle');
			expect(node?.role).toBe('process');
		});

		it('maps circle to ellipse with entrypoint role', () => {
			const graph = parseMermaid('flowchart TD\n  A((Circle))');
			const callGraph = mermaidToCallGraph(graph, 'test.mmd');
			const node = callGraph.nodes.find(n => n.id === 'A');
			expect(node?.shape).toBe('ellipse');
			expect(node?.role).toBe('entrypoint');
		});

		it('maps hexagon to hexagon with callback role', () => {
			const graph = parseMermaid('flowchart TD\n  A{{Hexagon}}');
			const callGraph = mermaidToCallGraph(graph, 'test.mmd');
			const node = callGraph.nodes.find(n => n.id === 'A');
			expect(node?.shape).toBe('hexagon');
			expect(node?.role).toBe('callback');
		});
	});

	describe('subgraph mapping', () => {
		it('maps subgraphs to NodeGroups', () => {
			const graph = parseMermaid(`flowchart TD
    subgraph SG[My Group]
        A[Node A]
        B[Node B]
    end`);
			const callGraph = mermaidToCallGraph(graph, 'test.mmd');
			expect(callGraph.groups).toHaveLength(1);
			expect(callGraph.groups![0].label).toBe('My Group');
			expect(callGraph.groups![0].nodeIds).toEqual(['A', 'B']);
		});

		it('assigns groupId to nodes', () => {
			const graph = parseMermaid(`flowchart TD
    subgraph SG[My Group]
        A[Node A]
    end`);
			const callGraph = mermaidToCallGraph(graph, 'test.mmd');
			const node = callGraph.nodes.find(n => n.id === 'A');
			expect(node?.groupId).toBe('SG');
		});
	});

	describe('edge mapping', () => {
		it('preserves edge labels', () => {
			const graph = parseMermaid('flowchart TD\n  A -->|my label| B');
			const callGraph = mermaidToCallGraph(graph, 'test.mmd');
			expect(callGraph.edges[0].label).toBe('my label');
		});

		it('maps solid style', () => {
			const graph = parseMermaid('flowchart TD\n  A --> B');
			const callGraph = mermaidToCallGraph(graph, 'test.mmd');
			expect(callGraph.edges[0].style).toBe('solid');
		});

		it('maps dotted style', () => {
			const graph = parseMermaid('flowchart TD\n  A -.-> B');
			const callGraph = mermaidToCallGraph(graph, 'test.mmd');
			expect(callGraph.edges[0].style).toBe('dotted');
		});

		it('maps thick to dashed style', () => {
			const graph = parseMermaid('flowchart TD\n  A ==> B');
			const callGraph = mermaidToCallGraph(graph, 'test.mmd');
			expect(callGraph.edges[0].style).toBe('dashed');
		});
	});

	describe('node labels', () => {
		it('uses mermaid label as node label', () => {
			const graph = parseMermaid('flowchart TD\n  A[Human readable label]');
			const callGraph = mermaidToCallGraph(graph, 'test.mmd');
			expect(callGraph.nodes[0].label).toBe('Human readable label');
		});
	});

	describe('full round-trip: mermaid → CallGraph → TldrWriter', () => {
		const fixture = fs.readFileSync(
			path.join(__dirname, 'fixtures', 'SunControls.mmd'),
			'utf-8',
		);

		it('produces valid .tldr JSON from SunControls mermaid', () => {
			const mermaidGraph = parseMermaid(fixture);
			const callGraph = mermaidToCallGraph(mermaidGraph, 'SunControls.mmd');
			const layout = layoutCallGraph(callGraph);
			const tldr = generateTldr(callGraph, {
				sourceFile: 'SunControls.mmd',
				type: 'file',
			}, layout);
			const json = serializeTldr(tldr);

			// Should be valid JSON
			const parsed = JSON.parse(json);
			expect(parsed.tldrawFileFormatVersion).toBe(1);
			expect(parsed.records.length).toBeGreaterThan(0);
		});

		it('produces shapes for all nodes', () => {
			const mermaidGraph = parseMermaid(fixture);
			const callGraph = mermaidToCallGraph(mermaidGraph, 'SunControls.mmd');
			const layout = layoutCallGraph(callGraph);
			const tldr = generateTldr(callGraph, {
				sourceFile: 'SunControls.mmd',
				type: 'file',
			}, layout);

			const geoShapes = tldr.records.filter(
				(r: any) => r.typeName === 'shape' && r.type === 'geo',
			);
			// Should have at least 20 node shapes
			expect(geoShapes.length).toBeGreaterThanOrEqual(20);
		});

		it('produces frame shapes for subgraphs', () => {
			const mermaidGraph = parseMermaid(fixture);
			const callGraph = mermaidToCallGraph(mermaidGraph, 'SunControls.mmd');
			const layout = layoutCallGraph(callGraph);
			const tldr = generateTldr(callGraph, {
				sourceFile: 'SunControls.mmd',
				type: 'file',
			}, layout);

			const frameShapes = tldr.records.filter(
				(r: any) => r.typeName === 'shape' && r.type === 'frame',
			);
			expect(frameShapes.length).toBe(7);
		});

		it('produces arrow shapes for edges', () => {
			const mermaidGraph = parseMermaid(fixture);
			const callGraph = mermaidToCallGraph(mermaidGraph, 'SunControls.mmd');
			const layout = layoutCallGraph(callGraph);
			const tldr = generateTldr(callGraph, {
				sourceFile: 'SunControls.mmd',
				type: 'file',
			}, layout);

			const arrowShapes = tldr.records.filter(
				(r: any) => r.typeName === 'shape' && r.type === 'arrow',
			);
			expect(arrowShapes.length).toBeGreaterThanOrEqual(15);
		});

		it('uses node labels from mermaid in geo shapes', () => {
			const mermaidGraph = parseMermaid(fixture);
			const callGraph = mermaidToCallGraph(mermaidGraph, 'SunControls.mmd');
			const layout = layoutCallGraph(callGraph);
			const tldr = generateTldr(callGraph, {
				sourceFile: 'SunControls.mmd',
				type: 'file',
			}, layout);

			const pickDateShape = tldr.records.find(
				(r: any) => r.id === 'shape:pickDate',
			) as any;
			expect(pickDateShape).toBeDefined();
			expect(pickDateShape.props.text).toBe('User picks a date');
			expect(pickDateShape.props.geo).toBe('oval');
		});
	});
});
