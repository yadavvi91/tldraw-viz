/** Messages from the webview to the extension */
export type WebviewToExtension =
	| { type: 'shapeClicked'; data: {
		file: string;
		line: number;
		name: string;
		/** Byte offset range from tree-sitter (for precise navigation) */
		startByte?: number;
		endByte?: number;
	} };
