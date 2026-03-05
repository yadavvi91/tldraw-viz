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

/**
 * Force tldraw to recalculate viewport bounds from the container element.
 * In VS Code's nested iframe, getBoundingClientRect() can temporarily return
 * zero dimensions, causing tldraw to think the viewport is empty and unmount
 * all shape DOM elements. This function forces a re-evaluation.
 *
 * IMPORTANT: Do NOT call this during tldraw's initialization — it interferes
 * with tldraw's _willSetInitialBounds flag. Only use for recovery.
 */
function forceViewportUpdate(ed: Editor): boolean {
	try {
		const container = ed.getContainer();
		if (!container?.isConnected) return false;

		const rect = container.getBoundingClientRect();
		if (rect.width < 2 || rect.height < 2) {
			debugLog(`Viewport fix: container too small (${rect.width}x${rect.height}), skipping`);
			return false;
		}

		ed.updateViewportScreenBounds(container);
		ed.zoomToFit({ animation: { duration: 0 } });
		debugLog(`Viewport fix: updated to ${Math.round(rect.width)}x${Math.round(rect.height)}`);
		return true;
	} catch {
		return false;
	}
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

	// Fix viewport when tab becomes visible (VS Code may have zeroed dimensions while hidden)
	useEffect(() => {
		if (!editor) return;

		function handleVisibility() {
			if (!document.hidden) {
				// Small delay to let VS Code finish layout before measuring
				setTimeout(() => forceViewportUpdate(editor!), 200);
			}
		}

		document.addEventListener('visibilitychange', handleVisibility);
		return () => document.removeEventListener('visibilitychange', handleVisibility);
	}, [editor]);

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

	// Health check: detect blank canvas and recover by fixing viewport bounds
	// Root cause: VS Code's nested iframe can cause getBoundingClientRect() to
	// return zero dimensions, making tldraw think the viewport is empty and
	// unmounting all shape DOM elements. Instead of remounting (which recreates
	// the same problem), we force a viewport bounds recalculation.
	useEffect(() => {
		if (!editor) return;

		let blankCount = 0;
		let viewportFixAttempts = 0;

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
						onRecoveryNeeded(); // Container truly gone — remount
					}
					return;
				}

				// Check if tldraw is actually rendering shapes visually
				const shapeElements = container.querySelectorAll('.tl-shape');
				if (shapeElements.length === 0) {
					blankCount++;
					viewportFixAttempts++;
					debugLog(`Health: ${shapeCount} shapes but 0 rendered — fixing viewport (attempt ${viewportFixAttempts})`);

					// First, try fixing viewport bounds (much better than remounting)
					const fixed = forceViewportUpdate(editor);

					if (!fixed || viewportFixAttempts > 10) {
						// Viewport fix failed repeatedly — fall back to full remount
						debugLog('Viewport fix exhausted — remounting');
						blankCount = 0;
						viewportFixAttempts = 0;
						onRecoveryNeeded();
					}
				} else {
					blankCount = 0;
					viewportFixAttempts = 0;
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
