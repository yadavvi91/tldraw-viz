import { describe, it, expect } from 'vitest';
import { generateFlowPrompt } from '../src/StructuralSummary';
import type { FlowGraph } from '../src/FlowTracer';

describe('generateFlowPrompt', () => {
	const sampleFlow: FlowGraph = {
		name: 'authentication',
		entrypoint: 'src/auth/login.ts:handleLogin',
		nodes: [
			{ id: 'src/auth/login.ts:function-handleLogin', name: 'handleLogin', type: 'function', line: 5, sourceFile: 'src/auth/login.ts' },
			{ id: 'src/auth/login.ts:function-validatePassword', name: 'validatePassword', type: 'function', line: 12, sourceFile: 'src/auth/login.ts' },
			{ id: 'src/services/db.ts:function-findUser', name: 'findUser', type: 'function', line: 8, sourceFile: 'src/services/db.ts' },
			{ id: 'src/services/session.ts:function-createSession', name: 'createSession', type: 'function', line: 3, sourceFile: 'src/services/session.ts' },
		],
		edges: [
			{ from: 'src/auth/login.ts:function-handleLogin', to: 'src/auth/login.ts:function-validatePassword' },
			{ from: 'src/auth/login.ts:function-handleLogin', to: 'src/services/db.ts:function-findUser' },
			{ from: 'src/auth/login.ts:function-handleLogin', to: 'src/services/session.ts:function-createSession' },
		],
	};

	it('includes flow name and entrypoint', () => {
		const prompt = generateFlowPrompt(sampleFlow);
		expect(prompt).toContain('authentication');
		expect(prompt).toContain('src/auth/login.ts:handleLogin');
	});

	it('groups functions by source file', () => {
		const prompt = generateFlowPrompt(sampleFlow);
		expect(prompt).toContain('### src/auth/login.ts');
		expect(prompt).toContain('### src/services/db.ts');
		expect(prompt).toContain('### src/services/session.ts');
	});

	it('marks cross-file calls', () => {
		const prompt = generateFlowPrompt(sampleFlow);
		expect(prompt).toContain('[CROSS-FILE]');
	});

	it('includes mermaid formatting instructions', () => {
		const prompt = generateFlowPrompt(sampleFlow);
		expect(prompt).toContain('flowchart TD');
		expect(prompt).toContain('classDef');
	});

	it('includes entrypoint and crossFile class styles', () => {
		const prompt = generateFlowPrompt(sampleFlow);
		expect(prompt).toContain('classDef entrypoint');
		expect(prompt).toContain('classDef crossFile');
	});

	it('handles single-file flow (no CROSS-FILE markers)', () => {
		const singleFileFlow: FlowGraph = {
			name: 'init',
			entrypoint: 'src/main.ts:main',
			nodes: [
				{ id: 'src/main.ts:function-main', name: 'main', type: 'function', line: 1, sourceFile: 'src/main.ts' },
				{ id: 'src/main.ts:function-setup', name: 'setup', type: 'function', line: 5, sourceFile: 'src/main.ts' },
			],
			edges: [
				{ from: 'src/main.ts:function-main', to: 'src/main.ts:function-setup' },
			],
		};
		const prompt = generateFlowPrompt(singleFileFlow);
		expect(prompt).not.toContain('[CROSS-FILE]');
		expect(prompt).toContain('src/main.ts');
	});

	it('handles empty flow', () => {
		const emptyFlow: FlowGraph = {
			name: 'empty',
			entrypoint: 'src/missing.ts:gone',
			nodes: [],
			edges: [],
		};
		const prompt = generateFlowPrompt(emptyFlow);
		expect(prompt).toContain('empty');
		expect(prompt).toContain('flowchart TD');
	});
});
