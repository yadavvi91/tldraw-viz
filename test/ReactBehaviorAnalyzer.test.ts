import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { initParser, parseSource, extractNodes } from '../src/CodeAnalyzer';
import { extractEdges } from '../src/CallGraphExtractor';
import { analyzeBehavior } from '../src/ReactBehaviorAnalyzer';
import { getLanguageConfig } from '../src/languages';
import type { CallGraph } from '../src/types';

const fixtureSource = fs.readFileSync(
	path.join(__dirname, 'fixtures', 'SunControls.tsx'),
	'utf-8',
);

let graph: CallGraph;

beforeAll(async () => {
	await initParser();
	const config = getLanguageConfig('typescriptreact')!;
	const tree = await parseSource(fixtureSource, config);
	const nodes = extractNodes(tree, config);
	const edges = extractEdges(tree, config, nodes);
	graph = { nodes, edges, fileName: 'SunControls.tsx', language: 'typescriptreact' };
	analyzeBehavior(graph, tree, config);
});

describe('ReactBehaviorAnalyzer', () => {
	describe('Pass 1: User Action nodes', () => {
		it('creates user action nodes for JSX event handlers', () => {
			const userActions = graph.nodes.filter(n => n.role === 'user-action');
			expect(userActions.length).toBeGreaterThanOrEqual(3);

			const actionIds = userActions.map(n => n.id);
			expect(actionIds).toContain('pickDate');
			expect(actionIds).toContain('dragSlider');
		});

		it('gives user action nodes oval shape', () => {
			const pickDate = graph.nodes.find(n => n.id === 'pickDate');
			expect(pickDate?.shape).toBe('oval');
		});

		it('labels user action nodes with human-readable text', () => {
			const pickDate = graph.nodes.find(n => n.id === 'pickDate');
			expect(pickDate?.label).toContain('date');
		});
	});

	describe('Pass 2: Inline Operation nodes', () => {
		it('creates inline operation nodes for significant expressions', () => {
			const parseDate = graph.nodes.find(n => n.id === 'parseDate');
			expect(parseDate).toBeDefined();
			expect(parseDate?.role).toBe('process');
			expect(parseDate?.shape).toBe('rectangle');
		});

		it('creates preserveTime node for setHours call', () => {
			const preserveTime = graph.nodes.find(n => n.id === 'preserveTime');
			expect(preserveTime).toBeDefined();
			expect(preserveTime?.label).toContain('hours');
		});

		it('creates parseFloat node for slider handler', () => {
			const pf = graph.nodes.find(n => n.id === 'parseFloat');
			expect(pf).toBeDefined();
			expect(pf?.role).toBe('process');
		});
	});

	describe('Pass 3: Callback Invocation nodes', () => {
		it('creates callback nodes for each callback prop', () => {
			const callbackNodes = graph.nodes.filter(n => n.role === 'callback');
			expect(callbackNodes.length).toBeGreaterThanOrEqual(3);

			const ids = callbackNodes.map(n => n.id);
			expect(ids).toContain('callDateChange');
			expect(ids).toContain('callTimeChange');
		});

		it('gives callback nodes hexagon shape', () => {
			const cb = graph.nodes.find(n => n.id === 'callDateChange');
			expect(cb?.shape).toBe('hexagon');
		});

		it('wires edges from callbacks to parent', () => {
			const parentEdges = graph.edges.filter(e => e.to === 'synthetic-parent');
			expect(parentEdges.length).toBeGreaterThanOrEqual(3);
			expect(parentEdges.every(e => e.label === 'to parent')).toBe(true);
		});
	});

	describe('Pass 4: Conditional Logic nodes', () => {
		it('creates decision node for animationMode ternary', () => {
			const checkMode = graph.nodes.find(n => n.id === 'checkMode');
			expect(checkMode).toBeDefined();
			expect(checkMode?.role).toBe('decision');
			expect(checkMode?.shape).toBe('diamond');
		});

		it('creates branch nodes for daily and yearly calculations', () => {
			const dailyCalc = graph.nodes.find(n => n.id === 'dailyCalc');
			const yearlyCalc = graph.nodes.find(n => n.id === 'yearlyCalc');
			expect(dailyCalc).toBeDefined();
			expect(yearlyCalc).toBeDefined();
		});

		it('wires decision edges with labels', () => {
			const dailyEdge = graph.edges.find(
				e => e.from === 'checkMode' && e.to === 'dailyCalc',
			);
			const yearlyEdge = graph.edges.find(
				e => e.from === 'checkMode' && e.to === 'yearlyCalc',
			);
			expect(dailyEdge?.label).toBe('daily');
			expect(yearlyEdge?.label).toContain('yearly');
		});

		it('creates monthly conditional decision node', () => {
			const checkMonthly = graph.nodes.find(n => n.id === 'checkMonthly');
			expect(checkMonthly).toBeDefined();
			expect(checkMonthly?.role).toBe('decision');
		});
	});

	describe('Pass 5: Display Computation nodes', () => {
		it('creates display nodes for formatDeg calls', () => {
			const radToAlt = graph.nodes.find(n => n.id === 'radToAlt');
			const radToAz = graph.nodes.find(n => n.id === 'radToAz');
			expect(radToAlt).toBeDefined();
			expect(radToAlt?.role).toBe('display');
			expect(radToAz).toBeDefined();
		});

		it('creates display nodes for formatTime calls', () => {
			const fmtSunrise = graph.nodes.find(n => n.id === 'fmtSunrise');
			const fmtSunset = graph.nodes.find(n => n.id === 'fmtSunset');
			expect(fmtSunrise).toBeDefined();
			expect(fmtSunset).toBeDefined();
		});
	});

	describe('Edge wiring', () => {
		it('wires user actions to inline operations', () => {
			const edge = graph.edges.find(
				e => e.from === 'pickDate' && e.to === 'parseDate',
			);
			expect(edge).toBeDefined();
		});

		it('wires inline operations sequentially', () => {
			const edge = graph.edges.find(
				e => e.from === 'parseDate' && e.to === 'preserveTime',
			);
			expect(edge).toBeDefined();
		});

		it('wires last inline op to callback', () => {
			const edge = graph.edges.find(
				e => e.from === 'preserveTime' && e.to === 'callDateChange',
			);
			expect(edge).toBeDefined();
		});

		it('wires dotted edges from callbacks to decision nodes', () => {
			const dottedEdge = graph.edges.find(
				e => e.from === 'callDateChange' && e.to === 'checkMode',
			);
			expect(dottedEdge?.style).toBe('dotted');
		});
	});

	describe('Grouping', () => {
		it('creates semantic groups', () => {
			const groupLabels = (graph.groups || []).map(g => g.label);
			expect(groupLabels).toContain('User Interactions');
			expect(groupLabels).toContain('Date Change Flow');
			expect(groupLabels).toContain('Progress Bar Calculation');
			expect(groupLabels).toContain('Sun Info Display');
		});

		it('assigns nodes to correct groups', () => {
			const userGroup = graph.groups?.find(g => g.label === 'User Interactions');
			expect(userGroup?.nodeIds).toContain('pickDate');
			expect(userGroup?.nodeIds).toContain('dragSlider');
		});
	});

	describe('Component node removal', () => {
		it('removes the component entrypoint node', () => {
			const sunControls = graph.nodes.find(n => n.name === 'SunControls');
			expect(sunControls).toBeUndefined();
		});

		it('creates parent component node', () => {
			const parent = graph.nodes.find(n => n.id === 'synthetic-parent');
			expect(parent).toBeDefined();
			expect(parent?.role).toBe('parent');
			expect(parent?.shape).toBe('cloud');
		});
	});

	describe('Total node count', () => {
		it('produces significantly more nodes than the original call graph', () => {
			// Original had 4 declared functions + 1 parent = 5
			// Behavioral analysis should produce ~20+ nodes
			expect(graph.nodes.length).toBeGreaterThanOrEqual(15);
		});
	});
});
