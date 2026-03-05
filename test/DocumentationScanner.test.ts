import { describe, it, expect } from 'vitest';
import { scanDocumentation, extractPackageJsonSummary } from '../src/DocumentationScanner';
import type { FileReader } from '../src/FlowTracer';

/** Create a mock FileReader backed by an in-memory file map */
function createMemoryReader(files: Record<string, string>): FileReader {
	return {
		async readFile(absolutePath: string): Promise<string> {
			const content = files[absolutePath];
			if (content === undefined) throw new Error(`File not found: ${absolutePath}`);
			return content;
		},
		async listFiles(): Promise<string[]> {
			return Object.keys(files);
		},
	};
}

describe('DocumentationScanner', () => {
	const root = '/workspace';

	describe('scanDocumentation', () => {
		it('finds exact-path documentation files', async () => {
			const reader = createMemoryReader({
				'/workspace/CLAUDE.md': '# My Project\nThis is an auth service.',
				'/workspace/README.md': '# README\nInstallation instructions.',
			});

			const result = await scanDocumentation(reader, root);

			expect(result.hasDocumentation).toBe(true);
			expect(result.files).toHaveLength(2);
			expect(result.files[0].relativePath).toBe('CLAUDE.md');
			expect(result.files[0].priority).toBe(1);
			expect(result.files[1].relativePath).toBe('README.md');
			expect(result.files[1].priority).toBe(2);
		});

		it('handles missing files gracefully', async () => {
			const reader = createMemoryReader({});

			const result = await scanDocumentation(reader, root);

			expect(result.hasDocumentation).toBe(false);
			expect(result.files).toHaveLength(0);
			expect(result.combinedContent).toBe('');
		});

		it('respects the 15K char budget', async () => {
			const bigContent = 'A'.repeat(10_000);
			const reader = createMemoryReader({
				'/workspace/CLAUDE.md': bigContent,
				'/workspace/README.md': bigContent,
			});

			const result = await scanDocumentation(reader, root);

			expect(result.totalCharsRaw).toBe(20_000);
			// Combined content should be truncated to ~15K
			expect(result.combinedContent.length).toBeLessThanOrEqual(15_100);
			// Both files found but second one truncated
			expect(result.files).toHaveLength(2);
		});

		it('prioritizes CLAUDE.md over README.md', async () => {
			const reader = createMemoryReader({
				'/workspace/README.md': 'README content',
				'/workspace/CLAUDE.md': 'CLAUDE content',
			});

			const result = await scanDocumentation(reader, root);

			// CLAUDE.md should come first in combined content
			expect(result.combinedContent.indexOf('CLAUDE.md')).toBeLessThan(
				result.combinedContent.indexOf('README.md'),
			);
		});

		it('includes .claude/MEMORY.md when present', async () => {
			const reader = createMemoryReader({
				'/workspace/.claude/MEMORY.md': '# Memory\nProject uses React.',
			});

			const result = await scanDocumentation(reader, root);

			expect(result.hasDocumentation).toBe(true);
			expect(result.files).toHaveLength(1);
			expect(result.files[0].relativePath).toBe('.claude/MEMORY.md');
			expect(result.files[0].category).toBe('claude');
		});

		it('extracts package.json summary instead of raw JSON', async () => {
			const pkg = JSON.stringify({
				name: 'my-app',
				description: 'A great app',
				dependencies: { react: '^18', express: '^4' },
				scripts: { build: 'tsc', test: 'vitest' },
				devDependencies: { typescript: '^5' },
			});
			const reader = createMemoryReader({
				'/workspace/package.json': pkg,
			});

			const result = await scanDocumentation(reader, root);

			// package.json alone doesn't count as documentation
			expect(result.hasDocumentation).toBe(false);
			// But the file is still collected
			expect(result.files).toHaveLength(1);
			expect(result.files[0].content).toContain('Name: my-app');
			expect(result.files[0].content).toContain('Dependencies: react, express');
			expect(result.files[0].content).not.toContain('devDependencies');
		});

		it('finds glob-pattern files from markdownFiles list', async () => {
			const reader = createMemoryReader({
				'/workspace/.context/plans/checkpoint-1.md': '# Checkpoint 1\nPhase 1 complete.',
				'/workspace/.context/plans/implementation-plan.md': '# Plan\nPhase 2 design.',
			});

			const mdFiles = [
				'/workspace/.context/plans/checkpoint-1.md',
				'/workspace/.context/plans/implementation-plan.md',
			];

			const result = await scanDocumentation(reader, root, mdFiles);

			expect(result.hasDocumentation).toBe(true);
			expect(result.files).toHaveLength(2);
			// checkpoint has priority 6, plan has priority 7
			expect(result.files[0].category).toBe('checkpoint');
			expect(result.files[1].category).toBe('plan');
		});

		it('deduplicates files found by exact path and glob', async () => {
			const reader = createMemoryReader({
				'/workspace/README.md': '# README',
			});

			const mdFiles = ['/workspace/README.md'];

			const result = await scanDocumentation(reader, root, mdFiles);

			// README.md should appear only once (found by exact path, not duplicated by glob)
			const readmeFiles = result.files.filter(f => f.relativePath === 'README.md');
			expect(readmeFiles).toHaveLength(1);
		});

		it('includes all doc types in combined content with headers', async () => {
			const reader = createMemoryReader({
				'/workspace/CLAUDE.md': 'Claude doc',
				'/workspace/plan.md': 'Plan doc',
			});

			const result = await scanDocumentation(reader, root);

			expect(result.combinedContent).toContain('--- CLAUDE.md ---');
			expect(result.combinedContent).toContain('Claude doc');
			expect(result.combinedContent).toContain('--- plan.md ---');
			expect(result.combinedContent).toContain('Plan doc');
		});
	});

	describe('extractPackageJsonSummary', () => {
		it('extracts name, description, deps, and scripts', () => {
			const raw = JSON.stringify({
				name: 'my-app',
				description: 'A web app',
				dependencies: { react: '^18', next: '^14' },
				scripts: { dev: 'next dev', build: 'next build' },
			});

			const summary = extractPackageJsonSummary(raw);

			expect(summary).toContain('Name: my-app');
			expect(summary).toContain('Description: A web app');
			expect(summary).toContain('Dependencies: react, next');
			expect(summary).toContain('Scripts: dev, build');
		});

		it('handles invalid JSON gracefully', () => {
			const summary = extractPackageJsonSummary('not json{{{');
			expect(summary).toBe('not json{{{');
		});

		it('handles missing fields', () => {
			const raw = JSON.stringify({ name: 'minimal' });
			const summary = extractPackageJsonSummary(raw);
			expect(summary).toBe('Name: minimal');
		});
	});
});
