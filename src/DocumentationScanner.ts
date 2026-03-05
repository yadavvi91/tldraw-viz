import path from 'path';
import type { FileReader } from './FlowTracer';

/** A single documentation file found in the project */
export interface DocumentationFile {
	/** Relative path from workspace root */
	relativePath: string;
	/** Full file content (may be truncated) */
	content: string;
	/** Which category this doc falls into */
	category: 'readme' | 'claude' | 'plan' | 'checkpoint' | 'tasks' | 'package';
	/** Priority for inclusion (lower = more important) */
	priority: number;
}

/** Aggregated documentation context for the project */
export interface ProjectDocumentation {
	files: DocumentationFile[];
	/** Combined content truncated to budget, ready for prompt inclusion */
	combinedContent: string;
	/** Total characters before truncation */
	totalCharsRaw: number;
	/** Whether any docs were found at all */
	hasDocumentation: boolean;
}

/** Maximum total characters to include in prompt context (~15K chars ≈ 4K tokens) */
const MAX_DOC_CHARS = 15_000;

/**
 * Documentation files to look for by exact path, ordered by priority.
 */
const DOC_EXACT_PATHS: Array<{
	relativePath: string;
	category: DocumentationFile['category'];
	priority: number;
}> = [
	{ relativePath: 'CLAUDE.md', category: 'claude', priority: 1 },
	{ relativePath: 'README.md', category: 'readme', priority: 2 },
	{ relativePath: '.claude/MEMORY.md', category: 'claude', priority: 3 },
	{ relativePath: 'plan.md', category: 'plan', priority: 4 },
	{ relativePath: 'TASKS.md', category: 'tasks', priority: 5 },
	{ relativePath: 'package.json', category: 'package', priority: 10 },
];

/**
 * Glob-like patterns matched against pre-listed markdown files.
 */
const DOC_GLOB_PATTERNS: Array<{
	dirPrefix: string;
	fileMatch: RegExp;
	category: DocumentationFile['category'];
	priority: number;
}> = [
	{
		dirPrefix: '.context/plans/',
		fileMatch: /^checkpoint.*\.md$/,
		category: 'checkpoint',
		priority: 6,
	},
	{
		dirPrefix: '.context/plans/',
		fileMatch: /\.md$/,
		category: 'plan',
		priority: 7,
	},
];

/**
 * Scan the workspace for project documentation files.
 * Returns aggregated documentation content, budget-limited.
 *
 * @param fileReader - workspace file reader
 * @param workspaceRoot - absolute path to workspace root
 * @param markdownFiles - optional pre-listed .md file paths for glob matching
 */
export async function scanDocumentation(
	fileReader: FileReader,
	workspaceRoot: string,
	markdownFiles?: string[],
): Promise<ProjectDocumentation> {
	const foundFiles: DocumentationFile[] = [];
	const seenPaths = new Set<string>();

	// Phase 1: Try exact-path files
	for (const spec of DOC_EXACT_PATHS) {
		const absPath = path.join(workspaceRoot, spec.relativePath);
		try {
			let content = await fileReader.readFile(absPath);
			if (spec.category === 'package') {
				content = extractPackageJsonSummary(content);
			}
			foundFiles.push({
				relativePath: spec.relativePath,
				content,
				category: spec.category,
				priority: spec.priority,
			});
			seenPaths.add(spec.relativePath);
		} catch {
			// File doesn't exist — skip
		}
	}

	// Phase 2: Scan for glob-pattern files using pre-listed markdown files
	if (markdownFiles) {
		for (const spec of DOC_GLOB_PATTERNS) {
			const prefix = path.join(workspaceRoot, spec.dirPrefix);
			const matches = markdownFiles
				.filter(f => f.startsWith(prefix) && spec.fileMatch.test(path.basename(f)))
				.sort();

			for (const absPath of matches) {
				const relPath = path.relative(workspaceRoot, absPath);
				if (seenPaths.has(relPath)) continue;
				try {
					const content = await fileReader.readFile(absPath);
					foundFiles.push({
						relativePath: relPath,
						content,
						category: spec.category,
						priority: spec.priority,
					});
					seenPaths.add(relPath);
				} catch {
					// Skip unreadable files
				}
			}
		}
	}

	// Sort by priority (most important first)
	foundFiles.sort((a, b) => a.priority - b.priority);

	// Build combined content within budget
	const totalCharsRaw = foundFiles.reduce((sum, f) => sum + f.content.length, 0);
	let remaining = MAX_DOC_CHARS;
	const includedParts: string[] = [];

	for (const file of foundFiles) {
		if (remaining <= 0) break;
		const header = `--- ${file.relativePath} ---\n`;
		const maxContent = remaining - header.length;
		if (maxContent <= 0) break;
		const truncatedContent = file.content.slice(0, maxContent);
		includedParts.push(header + truncatedContent);
		remaining -= header.length + truncatedContent.length;
	}

	return {
		files: foundFiles,
		combinedContent: includedParts.join('\n\n'),
		totalCharsRaw,
		hasDocumentation: foundFiles.some(f => f.category !== 'package'),
	};
}

/**
 * Extract a summary from package.json — just name, description,
 * dependencies, and scripts (not the full JSON).
 */
export function extractPackageJsonSummary(raw: string): string {
	try {
		const pkg = JSON.parse(raw);
		const lines: string[] = [];
		if (pkg.name) lines.push(`Name: ${pkg.name}`);
		if (pkg.description) lines.push(`Description: ${pkg.description}`);
		if (pkg.dependencies) {
			lines.push(`Dependencies: ${Object.keys(pkg.dependencies).join(', ')}`);
		}
		if (pkg.scripts) {
			lines.push(`Scripts: ${Object.keys(pkg.scripts).join(', ')}`);
		}
		return lines.join('\n');
	} catch {
		return raw.slice(0, 500);
	}
}
