import type { WebviewToExtension } from '../messages';

interface VsCodeApi {
	postMessage(message: WebviewToExtension): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();
