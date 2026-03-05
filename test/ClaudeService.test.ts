import { describe, it, expect } from 'vitest';
import { extractMermaidBlock, estimateCost } from '../src/ClaudeService';

describe('extractMermaidBlock', () => {
	it('extracts from ```mermaid fences', () => {
		const input = 'Here is the diagram:\n```mermaid\nflowchart TD\n  A --> B\n```\nDone.';
		expect(extractMermaidBlock(input)).toBe('flowchart TD\n  A --> B');
	});

	it('extracts from plain ``` fences', () => {
		const input = '```\nflowchart TD\n  A --> B\n```';
		expect(extractMermaidBlock(input)).toBe('flowchart TD\n  A --> B');
	});

	it('returns trimmed text when no fences present', () => {
		const input = '  flowchart TD\n  A --> B  ';
		expect(extractMermaidBlock(input)).toBe('flowchart TD\n  A --> B');
	});

	it('handles fences with leading whitespace after opening', () => {
		const input = '```mermaid\n\nflowchart LR\n  X --> Y\n\n```';
		expect(extractMermaidBlock(input)).toBe('flowchart LR\n  X --> Y');
	});

	it('extracts only the first fenced block', () => {
		const input = '```mermaid\nfirst\n```\n\nSome text\n\n```mermaid\nsecond\n```';
		expect(extractMermaidBlock(input)).toBe('first');
	});

	it('handles complex mermaid with classDefs', () => {
		const mermaid = [
			'%%{init: {"flowchart": {"htmlLabels": true}} }%%',
			'flowchart TD',
			'  A([Start]) --> B[Process]',
			'  classDef process fill:#F3E5F5',
			'  class B process',
		].join('\n');
		const input = `\`\`\`mermaid\n${mermaid}\n\`\`\``;
		expect(extractMermaidBlock(input)).toBe(mermaid);
	});
});

describe('estimateCost', () => {
	it('calculates cost for Sonnet 4.6 pricing', () => {
		// $3/M input, $15/M output
		const cost = estimateCost(1000, 500);
		// (1000 * 3 + 500 * 15) / 1_000_000 = (3000 + 7500) / 1_000_000 = 0.0105
		expect(cost).toBeCloseTo(0.0105, 6);
	});

	it('returns 0 for zero tokens', () => {
		expect(estimateCost(0, 0)).toBe(0);
	});

	it('calculates typical diagram generation cost', () => {
		// ~1200 input tokens (prompt), ~800 output tokens (mermaid)
		const cost = estimateCost(1200, 800);
		// (1200 * 3 + 800 * 15) / 1_000_000 = (3600 + 12000) / 1_000_000 = 0.0156
		expect(cost).toBeCloseTo(0.0156, 6);
	});
});
