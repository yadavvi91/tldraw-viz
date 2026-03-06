/** Messages from the webview to the extension */
export type WebviewToExtension =
	| { type: 'shapeClicked'; data: { file: string; line: number; name: string } };
