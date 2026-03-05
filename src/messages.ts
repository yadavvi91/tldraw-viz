/** Messages from the extension to the webview */
export type ExtensionToWebview =
	| { type: 'opened-file'; data: { fileContents: string; uri: string } };

/** Messages from the webview to the extension */
export type WebviewToExtension =
	| { type: 'ready-to-receive-file' }
	| { type: 'shapeClicked'; data: { file: string; line: number; name: string } };
