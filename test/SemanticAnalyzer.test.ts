import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseSource, extractNodes } from '../src/CodeAnalyzer';
import { extractEdges } from '../src/CallGraphExtractor';
import { analyze, analyzeBase, enhanceReact } from '../src/SemanticAnalyzer';
import { getLanguageConfig } from '../src/languages';
import type { CallGraph } from '../src/types';

beforeAll(async () => {
	await initParser();
});

function buildGraph(source: string, language: string): Promise<{ graph: CallGraph; tree: any }> {
	const config = getLanguageConfig(language)!;
	return parseSource(source, config).then(tree => {
		const nodes = extractNodes(tree, config);
		const edges = extractEdges(tree, config, nodes);
		return { graph: { nodes, edges, fileName: 'test.ts', language }, tree };
	});
}

describe('analyzeBase', () => {
	it('marks entrypoint nodes (no incoming edges)', async () => {
		const source = `
function main() { helper(); }
function helper() { }
`;
		const { graph, tree } = await buildGraph(source, 'typescript');
		const config = getLanguageConfig('typescript')!;
		analyzeBase(graph, tree, config);

		const main = graph.nodes.find(n => n.name === 'main');
		expect(main?.role).toBe('entrypoint');
		expect(main?.shape).toBe('ellipse');
	});

	it('marks leaf nodes as process', async () => {
		const source = `
function main() { helper(); }
function helper() { }
`;
		const { graph, tree } = await buildGraph(source, 'typescript');
		const config = getLanguageConfig('typescript')!;
		analyzeBase(graph, tree, config);

		const helper = graph.nodes.find(n => n.name === 'helper');
		expect(helper?.role).toBe('process');
		expect(helper?.shape).toBe('rectangle');
	});

	it('marks display-like leaf nodes', async () => {
		const source = `
function main() { formatDate(); }
function formatDate() { return ''; }
`;
		const { graph, tree } = await buildGraph(source, 'typescript');
		const config = getLanguageConfig('typescript')!;
		analyzeBase(graph, tree, config);

		const fmt = graph.nodes.find(n => n.name === 'formatDate');
		expect(fmt?.role).toBe('display');
	});

	it('marks decision nodes (conditional containing calls to known nodes)', async () => {
		const source = `
function router(flag: boolean) {
  if (flag) {
    handleA();
  } else {
    handleB();
  }
}
function handleA() { }
function handleB() { }
`;
		const { graph, tree } = await buildGraph(source, 'typescript');
		const config = getLanguageConfig('typescript')!;
		analyzeBase(graph, tree, config);

		const router = graph.nodes.find(n => n.name === 'router');
		expect(router?.role).toBe('decision');
		expect(router?.shape).toBe('diamond');
	});

	it('groups class methods', async () => {
		const source = `
class MyService {
  fetch() { this.parse(); }
  parse() { }
}
`;
		const { graph, tree } = await buildGraph(source, 'typescript');
		const config = getLanguageConfig('typescript')!;
		analyzeBase(graph, tree, config);

		expect(graph.groups).toBeDefined();
		expect(graph.groups!.length).toBeGreaterThanOrEqual(1);

		const group = graph.groups!.find(g => g.label === 'MyService');
		expect(group).toBeDefined();
		expect(group!.nodeIds.length).toBe(2);
	});

	it('does not overwrite pre-existing roles', async () => {
		const source = `
function main() { helper(); }
function helper() { }
`;
		const { graph, tree } = await buildGraph(source, 'typescript');
		const config = getLanguageConfig('typescript')!;

		// Pre-set a role
		graph.nodes.find(n => n.name === 'main')!.role = 'callback';
		analyzeBase(graph, tree, config);

		const main = graph.nodes.find(n => n.name === 'main');
		expect(main?.role).toBe('callback'); // preserved
	});
});

describe('enhanceReact', () => {
	const reactSource = `
interface ControlProps {
  value: number;
  label: string;
  onValueChange: (val: number) => void;
  onReset: () => void;
  isActive: boolean;
}

function formatDisplay(n: number): string {
  return n.toFixed(2);
}

function clampValue(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function Controls({
  value,
  label,
  onValueChange,
  onReset,
  isActive,
}: ControlProps) {
  const clamped = clampValue(value, 0, 100);
  return (
    <div>
      <input
        type="range"
        value={clamped}
        onChange={(e) => onValueChange(parseFloat(e.target.value))}
      />
      <span>{formatDisplay(value)}</span>
      <button onClick={onReset}>Reset</button>
    </div>
  );
}
`;

	it('removes the component node and creates behavioral nodes', async () => {
		const config = getLanguageConfig('typescriptreact')!;
		const tree = await parseSource(reactSource, config);
		const nodes = extractNodes(tree, config);
		const edges = extractEdges(tree, config, nodes);
		const graph: CallGraph = { nodes, edges, fileName: 'test.tsx', language: 'typescriptreact' };

		analyze(graph, tree, config);

		// Component node is removed by behavioral analyzer
		const component = graph.nodes.find(n => n.name === 'Controls');
		expect(component).toBeUndefined();

		// Behavioral nodes are created instead
		expect(graph.nodes.length).toBeGreaterThan(3);
	});

	it('creates synthetic Parent node from callback props', async () => {
		const config = getLanguageConfig('typescriptreact')!;
		const tree = await parseSource(reactSource, config);
		const nodes = extractNodes(tree, config);
		const edges = extractEdges(tree, config, nodes);
		const graph: CallGraph = { nodes, edges, fileName: 'test.tsx', language: 'typescriptreact' };

		analyze(graph, tree, config);

		const parent = graph.nodes.find(n => n.id === 'synthetic-parent');
		expect(parent).toBeDefined();
		expect(parent?.role).toBe('parent');
		expect(parent?.shape).toBe('cloud');
	});

	it('marks display-like functions', async () => {
		const config = getLanguageConfig('typescriptreact')!;
		const tree = await parseSource(reactSource, config);
		const nodes = extractNodes(tree, config);
		const edges = extractEdges(tree, config, nodes);
		const graph: CallGraph = { nodes, edges, fileName: 'test.tsx', language: 'typescriptreact' };

		analyze(graph, tree, config);

		const fmt = graph.nodes.find(n => n.name === 'formatDisplay');
		expect(fmt?.role).toBe('display');
	});

	it('creates semantic groups', async () => {
		const config = getLanguageConfig('typescriptreact')!;
		const tree = await parseSource(reactSource, config);
		const nodes = extractNodes(tree, config);
		const edges = extractEdges(tree, config, nodes);
		const graph: CallGraph = { nodes, edges, fileName: 'test.tsx', language: 'typescriptreact' };

		analyze(graph, tree, config);

		expect(graph.groups).toBeDefined();
		expect(graph.groups!.length).toBeGreaterThan(0);

		const groupLabels = graph.groups!.map(g => g.label);
		// Behavioral analyzer creates User Interactions and Callback Flow groups
		expect(groupLabels).toContain('User Interactions');
	});

	it('adds "to parent" edge labels for callback edges', async () => {
		const config = getLanguageConfig('typescriptreact')!;
		const tree = await parseSource(reactSource, config);
		const nodes = extractNodes(tree, config);
		const edges = extractEdges(tree, config, nodes);
		const graph: CallGraph = { nodes, edges, fileName: 'test.tsx', language: 'typescriptreact' };

		analyze(graph, tree, config);

		// Behavioral analyzer creates parent node and callback → parent edges
		const parent = graph.nodes.find(n => n.id === 'synthetic-parent');
		expect(parent).toBeDefined();

		const parentEdges = graph.edges.filter(e => e.to === 'synthetic-parent');
		expect(parentEdges.length).toBeGreaterThan(0);
		for (const edge of parentEdges) {
			expect(edge.label).toBe('to parent');
		}
	});
});

describe('analyze dispatcher', () => {
	it('applies base analyzer for plain TypeScript', async () => {
		const source = `
function main() { helper(); }
function helper() { }
`;
		const { graph, tree } = await buildGraph(source, 'typescript');
		const config = getLanguageConfig('typescript')!;
		analyze(graph, tree, config);

		// Should have roles assigned
		expect(graph.nodes.every(n => n.role !== undefined)).toBe(true);
	});

	it('applies React enhancer for TSX', async () => {
		const source = `
export function App() {
  return <div>Hello</div>;
}
`;
		const config = getLanguageConfig('typescriptreact')!;
		const tree = await parseSource(source, config);
		const nodes = extractNodes(tree, config);
		const edges = extractEdges(tree, config, nodes);
		const graph: CallGraph = { nodes, edges, fileName: 'test.tsx', language: 'typescriptreact' };

		analyze(graph, tree, config);

		const app = graph.nodes.find(n => n.name === 'App');
		expect(app?.role).toBe('entrypoint');
	});
});
