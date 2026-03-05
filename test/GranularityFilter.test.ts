import { describe, it, expect } from 'vitest';
import { shouldSkipFile, hasEnoughSubstance, type TldrawConfig } from '../src/GranularityFilter';

const defaultConfig: TldrawConfig = {
	skip: ['**/config.*', '**/*.d.ts', '**/types.*', '**/constants.*'],
	minFunctions: 3,
	flows: [],
};

describe('GranularityFilter', () => {
	describe('shouldSkipFile', () => {
		it('skips .d.ts files', () => {
			expect(shouldSkipFile('src/types.d.ts', defaultConfig)).toBe(true);
			expect(shouldSkipFile('lib/utils.d.ts', defaultConfig)).toBe(true);
		});

		it('skips config files', () => {
			expect(shouldSkipFile('src/config.ts', defaultConfig)).toBe(true);
			expect(shouldSkipFile('config.js', defaultConfig)).toBe(true);
		});

		it('skips types files', () => {
			expect(shouldSkipFile('src/types.ts', defaultConfig)).toBe(true);
		});

		it('skips constants files', () => {
			expect(shouldSkipFile('src/constants.ts', defaultConfig)).toBe(true);
		});

		it('does not skip regular source files', () => {
			expect(shouldSkipFile('src/auth/login.ts', defaultConfig)).toBe(false);
			expect(shouldSkipFile('src/services/api.ts', defaultConfig)).toBe(false);
			expect(shouldSkipFile('src/utils/helpers.ts', defaultConfig)).toBe(false);
		});

		it('respects custom skip patterns', () => {
			const config: TldrawConfig = {
				...defaultConfig,
				skip: ['**/test/**', '**/*.spec.ts'],
			};
			expect(shouldSkipFile('test/foo.ts', config)).toBe(true);
			expect(shouldSkipFile('src/foo.spec.ts', config)).toBe(true);
			expect(shouldSkipFile('src/foo.ts', config)).toBe(false);
		});
	});

	describe('hasEnoughSubstance', () => {
		it('rejects files with too few functions', () => {
			expect(hasEnoughSubstance(2, 1, defaultConfig)).toBe(false);
			expect(hasEnoughSubstance(1, 0, defaultConfig)).toBe(false);
		});

		it('rejects files with no edges', () => {
			expect(hasEnoughSubstance(5, 0, defaultConfig)).toBe(false);
		});

		it('accepts files meeting thresholds', () => {
			expect(hasEnoughSubstance(3, 1, defaultConfig)).toBe(true);
			expect(hasEnoughSubstance(10, 8, defaultConfig)).toBe(true);
		});

		it('respects custom minFunctions', () => {
			const config: TldrawConfig = { ...defaultConfig, minFunctions: 5 };
			expect(hasEnoughSubstance(4, 3, config)).toBe(false);
			expect(hasEnoughSubstance(5, 3, config)).toBe(true);
		});
	});
});
