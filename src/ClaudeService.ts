import Anthropic from '@anthropic-ai/sdk';

export interface GenerationResult {
	mermaidCode: string;
	rawText: string;
	inputTokens: number;
	outputTokens: number;
}

export class ClaudeService {
	private client: Anthropic;

	constructor(apiKey: string) {
		this.client = new Anthropic({ apiKey });
	}

	async generateMermaid(prompt: string, maxTokens: number = 4096): Promise<GenerationResult> {
		const message = await this.client.messages.create({
			model: 'claude-sonnet-4-6',
			max_tokens: maxTokens,
			messages: [{ role: 'user', content: prompt }],
		});

		const text = message.content
			.filter((block): block is Anthropic.TextBlock => block.type === 'text')
			.map(block => block.text)
			.join('');

		const mermaidCode = ensureMermaidStyles(extractMermaidBlock(text));

		return {
			mermaidCode,
			rawText: text,
			inputTokens: message.usage.input_tokens,
			outputTokens: message.usage.output_tokens,
		};
	}
}

/** Extract mermaid code from a response that may be wrapped in fences */
export function extractMermaidBlock(text: string): string {
	const fenced = text.match(/```(?:mermaid)?\s*\n([\s\S]*?)```/);
	if (fenced) return fenced[1].trim();
	return text.trim();
}

/** All standard classDef styles used across diagram types */
const STANDARD_CLASS_DEFS: Record<string, string> = {
	userAction: 'classDef userAction fill:#E3F2FD,stroke:#1565C0,color:#0D47A1',
	process: 'classDef process fill:#F3E5F5,stroke:#7B1FA2,color:#4A148C',
	callback: 'classDef callback fill:#FFF3E0,stroke:#E65100,color:#BF360C',
	decision: 'classDef decision fill:#EDE7F6,stroke:#4527A0,color:#311B92',
	display: 'classDef display fill:#E8F5E9,stroke:#2E7D32,color:#1B5E20',
	parent: 'classDef parent fill:#ECEFF1,stroke:#546E7A,color:#37474F',
	hidden: 'classDef hidden fill:#FAFAFA,stroke:#BDBDBD,color:#757575',
	feature: 'classDef feature fill:#E8EAF6,stroke:#283593,color:#1A237E',
	external: 'classDef external fill:#FFF8E1,stroke:#F57F17,color:#E65100',
	dataStore: 'classDef dataStore fill:#E0F2F1,stroke:#00695C,color:#004D40',
	integration: 'classDef integration fill:#FCE4EC,stroke:#C62828,color:#B71C1C',
	module: 'classDef module fill:#E8EAF6,stroke:#283593,color:#1A237E',
	entrypoint: 'classDef entrypoint fill:#C8E6C9,stroke:#2E7D32,color:#1B5E20,stroke-width:3px',
	crossFile: 'classDef crossFile fill:#FFECB3,stroke:#FF8F00,color:#E65100',
};

/** Ensure all standard classDef styles referenced by class assignments are present */
export function ensureMermaidStyles(mermaidCode: string): string {
	// Find which class names are actually used via "class nodeId className" or ":::className"
	const usedClasses = new Set<string>();
	for (const match of mermaidCode.matchAll(/^\s*class\s+.+\s+(\w+)\s*$/gm)) {
		usedClasses.add(match[1]);
	}
	for (const match of mermaidCode.matchAll(/:::(\w+)/g)) {
		usedClasses.add(match[1]);
	}

	const missing: string[] = [];
	for (const name of usedClasses) {
		if (STANDARD_CLASS_DEFS[name] && !mermaidCode.includes(`classDef ${name} `)) {
			missing.push(STANDARD_CLASS_DEFS[name]);
		}
	}

	if (missing.length === 0) return mermaidCode;
	return mermaidCode.trimEnd() + '\n\n' + missing.join('\n');
}

/** Estimate cost in USD for Sonnet 4.6: $3/M input, $15/M output */
export function estimateCost(inputTokens: number, outputTokens: number): number {
	return (inputTokens * 3 + outputTokens * 15) / 1_000_000;
}
