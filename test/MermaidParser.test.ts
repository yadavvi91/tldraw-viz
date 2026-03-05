import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseMermaid } from '../src/MermaidParser';

describe('MermaidParser', () => {
	describe('direction parsing', () => {
		it('parses TD direction', () => {
			const graph = parseMermaid('flowchart TD\n  A[Hello]');
			expect(graph.direction).toBe('TD');
		});

		it('parses LR direction', () => {
			const graph = parseMermaid('flowchart LR\n  A[Hello]');
			expect(graph.direction).toBe('LR');
		});

		it('parses BT direction', () => {
			const graph = parseMermaid('flowchart BT\n  A[Hello]');
			expect(graph.direction).toBe('BT');
		});

		it('parses RL direction', () => {
			const graph = parseMermaid('flowchart RL\n  A[Hello]');
			expect(graph.direction).toBe('RL');
		});

		it('defaults to TD when no direction specified', () => {
			const graph = parseMermaid('');
			expect(graph.direction).toBe('TD');
		});

		it('handles graph keyword', () => {
			const graph = parseMermaid('graph LR\n  A[Hello]');
			expect(graph.direction).toBe('LR');
		});
	});

	describe('node shapes', () => {
		it('parses rectangle [text]', () => {
			const graph = parseMermaid('flowchart TD\n  A[Rectangle label]');
			expect(graph.nodes).toHaveLength(1);
			expect(graph.nodes[0].id).toBe('A');
			expect(graph.nodes[0].label).toBe('Rectangle label');
			expect(graph.nodes[0].shape).toBe('rectangle');
		});

		it('parses stadium ([text])', () => {
			const graph = parseMermaid('flowchart TD\n  A([Stadium label])');
			expect(graph.nodes[0].shape).toBe('stadium');
			expect(graph.nodes[0].label).toBe('Stadium label');
		});

		it('parses diamond {text}', () => {
			const graph = parseMermaid('flowchart TD\n  A{Diamond label}');
			expect(graph.nodes[0].shape).toBe('diamond');
			expect(graph.nodes[0].label).toBe('Diamond label');
		});

		it('parses circle ((text))', () => {
			const graph = parseMermaid('flowchart TD\n  A((Circle label))');
			expect(graph.nodes[0].shape).toBe('double-circle');
			expect(graph.nodes[0].label).toBe('Circle label');
		});

		it('parses subroutine [[text]]', () => {
			const graph = parseMermaid('flowchart TD\n  A[[Subroutine label]]');
			expect(graph.nodes[0].shape).toBe('subroutine');
		});

		it('parses asymmetric >text]', () => {
			const graph = parseMermaid('flowchart TD\n  A>Asymmetric label]');
			expect(graph.nodes[0].shape).toBe('asymmetric');
		});

		it('parses hexagon {{text}}', () => {
			const graph = parseMermaid('flowchart TD\n  A{{Hexagon label}}');
			expect(graph.nodes[0].shape).toBe('hexagon');
		});
	});

	describe('edge styles', () => {
		it('parses solid edge -->', () => {
			const graph = parseMermaid('flowchart TD\n  A --> B');
			expect(graph.edges).toHaveLength(1);
			expect(graph.edges[0].from).toBe('A');
			expect(graph.edges[0].to).toBe('B');
			expect(graph.edges[0].style).toBe('solid');
		});

		it('parses dotted edge -.->', () => {
			const graph = parseMermaid('flowchart TD\n  A -.-> B');
			expect(graph.edges).toHaveLength(1);
			expect(graph.edges[0].style).toBe('dotted');
		});

		it('parses thick edge ==>', () => {
			const graph = parseMermaid('flowchart TD\n  A ==> B');
			expect(graph.edges).toHaveLength(1);
			expect(graph.edges[0].style).toBe('thick');
		});

		it('parses edge label -->|label|', () => {
			const graph = parseMermaid('flowchart TD\n  A -->|my label| B');
			expect(graph.edges[0].label).toBe('my label');
		});

		it('parses chained edges A --> B --> C', () => {
			const graph = parseMermaid('flowchart TD\n  A --> B --> C');
			expect(graph.edges).toHaveLength(2);
			expect(graph.edges[0].from).toBe('A');
			expect(graph.edges[0].to).toBe('B');
			expect(graph.edges[1].from).toBe('B');
			expect(graph.edges[1].to).toBe('C');
		});

		it('parses chained edges with labels', () => {
			const graph = parseMermaid('flowchart TD\n  checkMode -->|daily| dailyCalc --> clampProgress');
			expect(graph.edges).toHaveLength(2);
			expect(graph.edges[0].label).toBe('daily');
			expect(graph.edges[1].label).toBeUndefined();
		});
	});

	describe('inline node definitions in edges', () => {
		it('defines nodes from edges', () => {
			const graph = parseMermaid('flowchart TD\n  A[First] --> B[Second]');
			expect(graph.nodes).toHaveLength(2);
			const a = graph.nodes.find(n => n.id === 'A');
			const b = graph.nodes.find(n => n.id === 'B');
			expect(a?.label).toBe('First');
			expect(b?.label).toBe('Second');
		});

		it('defines shaped nodes from edges', () => {
			const graph = parseMermaid('flowchart TD\n  A([Stadium]) --> B{Diamond}');
			const a = graph.nodes.find(n => n.id === 'A');
			const b = graph.nodes.find(n => n.id === 'B');
			expect(a?.shape).toBe('stadium');
			expect(b?.shape).toBe('diamond');
		});
	});

	describe('subgraphs', () => {
		it('parses subgraph with label', () => {
			const graph = parseMermaid(`flowchart TD
    subgraph SG[My Group]
        A[Node A]
        B[Node B]
    end`);
			expect(graph.subgraphs).toHaveLength(1);
			expect(graph.subgraphs[0].id).toBe('SG');
			expect(graph.subgraphs[0].label).toBe('My Group');
			expect(graph.subgraphs[0].nodeIds).toContain('A');
			expect(graph.subgraphs[0].nodeIds).toContain('B');
		});

		it('parses subgraph without label', () => {
			const graph = parseMermaid(`flowchart TD
    subgraph SG
        A[Node A]
    end`);
			expect(graph.subgraphs[0].label).toBe('SG');
		});

		it('parses multiple subgraphs', () => {
			const graph = parseMermaid(`flowchart TD
    subgraph SG1[Group 1]
        A[Node A]
    end
    subgraph SG2[Group 2]
        B[Node B]
    end`);
			expect(graph.subgraphs).toHaveLength(2);
		});

		it('assigns edge nodes to subgraphs', () => {
			const graph = parseMermaid(`flowchart TD
    subgraph SG[My Group]
        A --> B
    end`);
			expect(graph.subgraphs[0].nodeIds).toContain('A');
			expect(graph.subgraphs[0].nodeIds).toContain('B');
		});
	});

	describe('comments and style lines', () => {
		it('strips %% comments', () => {
			const graph = parseMermaid(`flowchart TD
    %% This is a comment
    A[Node]`);
			expect(graph.nodes).toHaveLength(1);
		});

		it('strips classDef lines', () => {
			const graph = parseMermaid(`flowchart TD
    A[Node]
    classDef myClass fill:#f00,stroke:#333`);
			expect(graph.nodes).toHaveLength(1);
		});

		it('strips class assignment lines', () => {
			const graph = parseMermaid(`flowchart TD
    A[Node]
    class A myClass`);
			expect(graph.nodes).toHaveLength(1);
		});
	});

	describe('empty/minimal input', () => {
		it('handles empty string', () => {
			const graph = parseMermaid('');
			expect(graph.nodes).toHaveLength(0);
			expect(graph.edges).toHaveLength(0);
			expect(graph.subgraphs).toHaveLength(0);
		});

		it('handles flowchart header only', () => {
			const graph = parseMermaid('flowchart TD');
			expect(graph.nodes).toHaveLength(0);
			expect(graph.direction).toBe('TD');
		});
	});

	describe('full SunControls mermaid diagram', () => {
		const fixture = fs.readFileSync(
			path.join(__dirname, 'fixtures', 'SunControls.mmd'),
			'utf-8',
		);

		it('parses all nodes', () => {
			const graph = parseMermaid(fixture);
			// The fixture has ~24 unique nodes
			expect(graph.nodes.length).toBeGreaterThanOrEqual(20);
		});

		it('parses all subgraphs', () => {
			const graph = parseMermaid(fixture);
			expect(graph.subgraphs.length).toBe(7);

			const sgLabels = graph.subgraphs.map(sg => sg.label);
			expect(sgLabels).toContain('User Interactions');
			expect(sgLabels).toContain('Date Change Flow');
			expect(sgLabels).toContain('Time Change Flow');
			expect(sgLabels).toContain('Animation Config Flow');
			expect(sgLabels).toContain('Progress Bar Calculation');
			expect(sgLabels).toContain('Sun Info Display');
			expect(sgLabels).toContain('Monthly Mode Label');
		});

		it('parses node shapes correctly', () => {
			const graph = parseMermaid(fixture);
			const pickDate = graph.nodes.find(n => n.id === 'pickDate');
			expect(pickDate?.shape).toBe('stadium');
			expect(pickDate?.label).toBe('User picks a date');

			const checkMode = graph.nodes.find(n => n.id === 'checkMode');
			expect(checkMode?.shape).toBe('diamond');
			expect(checkMode?.label).toBe('animationMode?');

			const parseDate = graph.nodes.find(n => n.id === 'parseDate');
			expect(parseDate?.shape).toBe('rectangle');
		});

		it('parses edge styles and labels', () => {
			const graph = parseMermaid(fixture);

			// Solid edge: pickDate --> parseDate
			const solidEdge = graph.edges.find(
				e => e.from === 'pickDate' && e.to === 'parseDate',
			);
			expect(solidEdge).toBeDefined();
			expect(solidEdge?.style).toBe('solid');

			// Dotted edge: callDateChange -.-> checkMode
			const dottedEdge = graph.edges.find(
				e => e.from === 'callDateChange' && e.to === 'checkMode',
			);
			expect(dottedEdge).toBeDefined();
			expect(dottedEdge?.style).toBe('dotted');

			// Labeled edge: checkMode -->|daily| dailyCalc
			const labeledEdge = graph.edges.find(
				e => e.from === 'checkMode' && e.to === 'dailyCalc',
			);
			expect(labeledEdge?.label).toBe('daily');
		});

		it('assigns nodes to correct subgraphs', () => {
			const graph = parseMermaid(fixture);

			const userActions = graph.subgraphs.find(sg => sg.label === 'User Interactions');
			expect(userActions?.nodeIds).toContain('pickDate');
			expect(userActions?.nodeIds).toContain('dragSlider');
			expect(userActions?.nodeIds).toContain('clickMode');

			const dateFlow = graph.subgraphs.find(sg => sg.label === 'Date Change Flow');
			expect(dateFlow?.nodeIds).toContain('parseDate');
			expect(dateFlow?.nodeIds).toContain('preserveTime');
			expect(dateFlow?.nodeIds).toContain('callDateChange');
		});

		it('parses all edges', () => {
			const graph = parseMermaid(fixture);
			// Should have many edges from the various flows
			expect(graph.edges.length).toBeGreaterThanOrEqual(15);
		});
	});
});
