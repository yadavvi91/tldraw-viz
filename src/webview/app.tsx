import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Tldraw, type Editor, parseTldrawJsonFile, loadSnapshot, getSnapshot } from 'tldraw';
import 'tldraw/tldraw.css';
import type { ExtensionToWebview } from '../messages';
import { vscode } from './vscode';

/** Write to the #debug div (visible even if React crashes) */
function debugLog(msg: string) {
	const d = document.getElementById('debug');
	if (d) {
		d.style.display = 'block';
		d.textContent = msg;
		// Auto-hide after 10 seconds
		setTimeout(() => { d.style.display = 'none'; }, 10_000);
	}
	console.log('[tldraw-viz]', msg);
}

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
	const [mountKey, setMountKey] = useState(0);
	const recoveryCountRef = useRef(0);

	const triggerRemount = useCallback(() => {
		if (recoveryCountRef.current < 3) {
			recoveryCountRef.current++;
			debugLog(`Auto-recovery #${recoveryCountRef.current}: remounting tldraw`);
			setMountKey(k => k + 1);
		}
	}, []);

	useEffect(() => {
		function handleMessage(event: MessageEvent<ExtensionToWebview>) {
			const msg = event.data;
			if (msg.type === 'opened-file') {
				setFileData(msg.data);
			} else if (msg.type === 'refresh') {
				debugLog('Refresh: remounting tldraw');
				recoveryCountRef.current = 0; // Reset recovery count on explicit refresh
				setMountKey(k => k + 1);
			}
		}
		window.addEventListener('message', handleMessage);
		vscode.postMessage({ type: 'ready-to-receive-file' });
		return () => window.removeEventListener('message', handleMessage);
	}, []);

	if (!fileData) {
		return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888' }}>Loading diagram...</div>;
	}

	return (
		<ErrorBoundary>
			<TldrawEditor
				key={mountKey}
				fileContents={fileData.fileContents}
				onRecoveryNeeded={triggerRemount}
			/>
		</ErrorBoundary>
	);
}

function TldrawEditor({ fileContents, onRecoveryNeeded }: { fileContents: string; onRecoveryNeeded: () => void }) {
	const [editor, setEditor] = useState<Editor | null>(null);

	const handleMount = useCallback((ed: Editor) => {
		try {
			const sanitized = fileContents.replace(/"url"\s*:\s*"vscode:\/\/[^"]*"/g, '"url": ""');
			const parseResult = parseTldrawJsonFile({
				json: sanitized,
				schema: ed.store.schema,
			});
			if (parseResult.ok) {
				const parsed = parseResult.value;
				const snapshot = getSnapshot(parsed);
				loadSnapshot(ed.store, { document: snapshot.document });
			} else {
				console.error('[tldraw-viz] Parse failed:', parseResult.error);
			}
		} catch (err) {
			console.error('[tldraw-viz] Error loading file:', err);
		}

		ed.updateInstanceState({ isReadonly: true });

		// Ensure we're on the correct page
		const pages = ed.getPages();
		if (pages.length > 0) {
			ed.setCurrentPage(pages[0].id);
		}

		ed.zoomToFit({ animation: { duration: 0 } });
		setEditor(ed);
	}, [fileContents]);

	// Selection listener — properly cleaned up on unmount
	useEffect(() => {
		if (!editor) return;

		let lastSelectedId: string | null = null;
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;

		const unsub = editor.store.listen(
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

		return () => {
			unsub();
			if (debounceTimer) clearTimeout(debounceTimer);
		};
	}, [editor]);

	// Health check: detect blank canvas and auto-recover
	useEffect(() => {
		if (!editor) return;

		let blankCount = 0;

		const interval = setInterval(() => {
			try {
				const shapeCount = editor.getCurrentPageShapeIds().size;
				if (shapeCount === 0) {
					blankCount = 0;
					return; // Empty diagram is valid
				}

				const container = editor.getContainer();
				if (!container?.isConnected) {
					blankCount++;
					debugLog(`Health: container detached (${blankCount}/3)`);
					if (blankCount >= 3) {
						blankCount = 0;
						onRecoveryNeeded();
					}
					return;
				}

				// Check if tldraw is actually rendering shapes visually
				// tldraw v4 uses className "tl-shape" on rendered shape wrappers
				const shapeElements = container.querySelectorAll('.tl-shape');
				if (shapeElements.length === 0) {
					blankCount++;
					debugLog(`Health: ${shapeCount} shapes in store but 0 rendered (${blankCount}/3)`);
					if (blankCount >= 3) {
						blankCount = 0;
						onRecoveryNeeded();
					}
				} else {
					blankCount = 0;
				}
			} catch {
				blankCount++;
				if (blankCount >= 3) {
					blankCount = 0;
					onRecoveryNeeded();
				}
			}
		}, 2000);

		return () => clearInterval(interval);
	}, [editor, onRecoveryNeeded]);

	return (
		<div style={{ width: '100%', height: '100%' }}>
			<Tldraw onMount={handleMount} autoFocus={false} />
		</div>
	);
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
