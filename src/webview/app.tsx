import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
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
	// Key to force remount on refresh (when panel becomes visible again)
	const [mountKey, setMountKey] = useState(0);

	useEffect(() => {
		function handleMessage(event: MessageEvent<ExtensionToWebview>) {
			const msg = event.data;
			if (msg.type === 'opened-file') {
				setFileData(msg.data);
			} else if (msg.type === 'refresh') {
				// Force remount tldraw to recover from blank canvas
				setMountKey(k => k + 1);
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
			<TldrawEditor key={mountKey} fileContents={fileData.fileContents} />
		</ErrorBoundary>
	);
}

function TldrawEditor({ fileContents }: { fileContents: string }) {
	const handleMount = useCallback((editor: Editor) => {
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
				loadSnapshot(editor.store, { document: snapshot.document });
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

		// Listen for selection changes (debounced to avoid interfering with zoom/pan)
		let lastSelectedId: string | null = null;
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		editor.store.listen(
			() => {
				if (debounceTimer) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(() => {
					const selectedIds = editor.getSelectedShapeIds();
					if (selectedIds.length !== 1) {
						lastSelectedId = null;
						return;
					}

					const shapeId = selectedIds[0];
					if (shapeId === lastSelectedId) return;
					lastSelectedId = shapeId;

					const shape = editor.getShape(shapeId);
					if (!shape || shape.type !== 'geo') return;

					const meta = shape.meta as {
						sourceLine?: number;
						sourceName?: string;
						sourceFile?: string;
					} | undefined;
					if (!meta) return;

					const docMeta = (editor.getDocumentSettings().meta as {
						tldrawViz?: { sourceFile?: string };
					} | undefined);
					const file = meta.sourceFile || docMeta?.tldrawViz?.sourceFile || '';
					const line = meta.sourceLine || 0;
					const name = meta.sourceName || '';

					if (!file) return;

					vscode.postMessage({
						type: 'shapeClicked',
						data: { file, line, name },
					});
				}, 150);
			},
			{ scope: 'session' },
		);
	}, [fileContents]);

	return (
		<div style={{ width: '100vw', height: '100vh' }}>
			<Tldraw onMount={handleMount} autoFocus={false} />
		</div>
	);
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
