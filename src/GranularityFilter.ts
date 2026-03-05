import { minimatch } from 'minimatch';

export interface TldrawConfig {
	skip: string[];
	minFunctions: number;
	flows: FlowConfig[];
}

export interface FlowConfig {
	name: string;
	entrypoint: string;
}

export const DEFAULT_CONFIG: TldrawConfig = {
	skip: ['**/config.*', '**/*.d.ts', '**/types.*', '**/constants.*'],
	minFunctions: 3,
	flows: [],
};

/**
 * Parse a config JSON object, filling in defaults for missing fields.
 */
export function parseConfig(raw: Record<string, unknown>): TldrawConfig {
	return {
		skip: Array.isArray(raw.skip) ? raw.skip : DEFAULT_CONFIG.skip,
		minFunctions: typeof raw.minFunctions === 'number' ? raw.minFunctions : DEFAULT_CONFIG.minFunctions,
		flows: Array.isArray(raw.flows) ? raw.flows as FlowConfig[] : DEFAULT_CONFIG.flows,
	};
}

/**
 * Check whether a file should be skipped based on config.
 */
export function shouldSkipFile(
	relativePath: string,
	config: TldrawConfig,
): boolean {
	for (const pattern of config.skip) {
		if (minimatch(relativePath, pattern)) {
			return true;
		}
	}
	return false;
}

/**
 * Check whether a call graph has enough substance to warrant a diagram.
 */
export function hasEnoughSubstance(
	nodeCount: number,
	edgeCount: number,
	config: TldrawConfig,
): boolean {
	if (nodeCount < config.minFunctions) return false;
	if (edgeCount === 0) return false;
	return true;
}
