import Anthropic from '@anthropic-ai/sdk';

export interface GenerationResult {
	mermaidCode: string;
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

		const mermaidCode = extractMermaidBlock(text);

		return {
			mermaidCode,
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

/** Estimate cost in USD for Sonnet 4.6: $3/M input, $15/M output */
export function estimateCost(inputTokens: number, outputTokens: number): number {
	return (inputTokens * 3 + outputTokens * 15) / 1_000_000;
}
