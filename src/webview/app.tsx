import React, { Component, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Tldraw, type Editor, parseTldrawJsonFile, loadSnapshot, getSnapshot } from 'tldraw';
import 'tldraw/tldraw.css';
import type { ExtensionToWebview } from '../messages';
import { vscode } from './vscode';

class ErrorBoundary extends Component<
	{ children: React.ReactNode },
	{ error: Error | null }
> {
	state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	render() {
		if (this.state.error) {
			return (
				<div style={{ padding: 24, color: '#c00', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
					<h3>tldraw failed to render</h3>
					<p>{this.state.error.message}</p>
					<pre>{this.state.error.stack}</pre>
				</div>
			);
		}
		return this.props.children;
	}
}

function App() {
	const [fileData, setFileData] = useState<{ fileContents: string; uri: string } | null>(null);

	useEffect(() => {
		function handleMessage(event: MessageEvent<ExtensionToWebview>) {
			const msg = event.data;
			if (msg.type === 'opened-file') {
				setFileData(msg.data);
			}
		}
		window.addEventListener('message', handleMessage);
		vscode.postMessage({ type: 'ready-to-receive-file' });
		return () => window.removeEventListener('message', handleMessage);
	}, []);

	if (!fileData) {
		return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#888' }}>Loading diagram...</div>;
	}

	return (
		<ErrorBoundary>
			<TldrawEditor fileContents={fileData.fileContents} />
		</ErrorBoundary>
	);
}

function TldrawEditor({ fileContents }: { fileContents: string }) {
	const handleMount = (editor: Editor) => {
		// Parse the .tldr file format and load into editor
		try {
			// Strip vscode:// URLs — tldraw v4 rejects non-standard protocols
			const sanitized = fileContents.replace(/"url"\s*:\s*"vscode:\/\/[^"]*"/g, '"url": ""');
			const parseResult = parseTldrawJsonFile({
				json: sanitized,
				schema: editor.store.schema,
			});
			if (parseResult.ok) {
				const parsed = parseResult.value;
				// Only load document data, not session state (avoids URI serialization issues)
				const snapshot = getSnapshot(parsed);
				console.log('[tldraw-viz] Snapshot document records:', Object.keys(snapshot.document?.store || {}).length);
				loadSnapshot(editor.store, { document: snapshot.document });
				console.log('[tldraw-viz] Loaded snapshot successfully');
			} else {
				console.error('[tldraw-viz] Parse failed:', parseResult.error);
			}
		} catch (err) {
			console.error('[tldraw-viz] Error loading file:', err);
		}

		// Set read-only mode
		editor.updateInstanceState({ isReadonly: true });

		// Zoom to fit content
		editor.zoomToFit({ animation: { duration: 0 } });

		// Listen for selection changes
		let lastSelectedId: string | null = null;
		editor.store.listen(
			() => {
				const selectedIds = editor.getSelectedShapeIds();
				if (selectedIds.length !== 1) {
					lastSelectedId = null;
					return;
				}

				const shapeId = selectedIds[0];
				if (shapeId === lastSelectedId) return;
				lastSelectedId = shapeId;

				const shape = editor.getShape(shapeId);
				console.log('[tldraw-viz] Selected shape:', shapeId, 'type:', shape?.type, 'meta:', JSON.stringify(shape?.meta));
				if (!shape || shape.type !== 'geo') return;

				const meta = shape.meta as {
					sourceLine?: number;
					sourceName?: string;
					sourceFile?: string;
					tldrawViz?: { sourceFile?: string };
				} | undefined;
				if (!meta) return;

				// Get source info from shape meta or document meta
				const docMeta = (editor.getDocumentSettings().meta as {
					tldrawViz?: { sourceFile?: string };
				} | undefined);
				console.log('[tldraw-viz] docMeta:', JSON.stringify(docMeta));
				const file = meta.sourceFile || docMeta?.tldrawViz?.sourceFile || '';
				const line = meta.sourceLine || 0;
				const name = meta.sourceName || '';

				console.log('[tldraw-viz] Navigate:', { file, line, name });
				if (!file) return;

				vscode.postMessage({
					type: 'shapeClicked',
					data: { file, line, name },
				});
			},
			{ scope: 'session' },
		);
	};

	return (
		<div style={{ position: 'fixed', inset: 0 }}>
			<Tldraw onMount={handleMount} />
		</div>
	);
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
