import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseSource } from '../src/CodeAnalyzer';
import { extractImports, resolveImportPath } from '../src/ImportResolver';
import { getLanguageConfigByKey } from '../src/languages';

beforeAll(async () => {
	await initParser();
});

describe('ImportResolver', () => {
	describe('extractImports (TypeScript)', () => {
		const config = getLanguageConfigByKey('typescript')!;

		it('extracts named imports', async () => {
			const source = `import { foo, bar } from './utils';`;
			const tree = await parseSource(source, config);
			const imports = extractImports(tree, 'typescript');

			expect(imports).toHaveLength(1);
			expect(imports[0].source).toBe('./utils');
			expect(imports[0].names).toEqual(['foo', 'bar']);
			expect(imports[0].isDefault).toBe(false);
		});

		it('extracts default imports', async () => {
			const source = `import Config from './config';`;
			const tree = await parseSource(source, config);
			const imports = extractImports(tree, 'typescript');

			expect(imports).toHaveLength(1);
			expect(imports[0].source).toBe('./config');
			expect(imports[0].names).toEqual(['Config']);
			expect(imports[0].isDefault).toBe(true);
		});

		it('filters out non-relative imports', async () => {
			const source = `
import express from 'express';
import { foo } from './local';
import { bar } from '@scope/package';
`;
			const tree = await parseSource(source, config);
			const imports = extractImports(tree, 'typescript');

			expect(imports).toHaveLength(1);
			expect(imports[0].source).toBe('./local');
		});

		it('handles parent directory imports', async () => {
			const source = `import { helper } from '../utils/helpers';`;
			const tree = await parseSource(source, config);
			const imports = extractImports(tree, 'typescript');

			expect(imports).toHaveLength(1);
			expect(imports[0].source).toBe('../utils/helpers');
		});
	});

	describe('resolveImportPath', () => {
		const files = new Set([
			'/project/src/auth/login.ts',
			'/project/src/utils/helpers.ts',
			'/project/src/services/api.ts',
			'/project/src/index.ts',
		]);

		it('resolves relative import with extension matching', () => {
			const result = resolveImportPath(
				'./helpers',
				'/project/src/utils/foo.ts',
				files,
			);
			expect(result).toBe('/project/src/utils/helpers.ts');
		});

		it('resolves parent directory imports', () => {
			const result = resolveImportPath(
				'../services/api',
				'/project/src/auth/login.ts',
				files,
			);
			expect(result).toBe('/project/src/services/api.ts');
		});

		it('resolves index files', () => {
			const result = resolveImportPath(
				'../',
				'/project/src/auth/login.ts',
				files,
			);
			expect(result).toBe('/project/src/index.ts');
		});

		it('returns undefined for non-existent imports', () => {
			const result = resolveImportPath(
				'./nonexistent',
				'/project/src/auth/login.ts',
				files,
			);
			expect(result).toBeUndefined();
		});
	});
});
