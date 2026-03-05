import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Tldraw, Box, type Editor, parseTldrawJsonFile, loadSnapshot, getSnapshot } from 'tldraw';
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
 * Force tldraw to recalculate viewport bounds.
 * In VS Code's nested iframe, getBoundingClientRect() can return zero/tiny
 * dimensions, causing tldraw's culling system to hide all shapes (display: none).
 *
 * This function tries the container first, then falls back to window dimensions
 * via a Box object (bypassing getBoundingClientRect entirely).
 */
function forceViewportUpdate(ed: Editor, alsoZoomToFit = true): boolean {
	try {
		const container = ed.getContainer();
		if (!container?.isConnected) return false;

		const rect = container.getBoundingClientRect();
		if (rect.width > 10 && rect.height > 10) {
			// Container has proper dimensions — use it directly
			ed.updateViewportScreenBounds(container);
		} else {
			// Container has bad dimensions — use window size as fallback
			const w = window.innerWidth || document.documentElement.clientWidth || 800;
			const h = window.innerHeight || document.documentElement.clientHeight || 600;
			debugLog(`Viewport fix: container bad (${Math.round(rect.width)}x${Math.round(rect.height)}), using window ${w}x${h}`);
			ed.updateViewportScreenBounds(new Box(0, 0, w, h));
		}

		if (alsoZoomToFit) {
			ed.zoomToFit({ animation: { duration: 0 } });
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if shapes are loaded but all hidden by tldraw's culling system.
 * When viewport bounds are wrong (e.g., 1x1), tldraw culls all shapes
 * by setting display:none on .tl-shape elements.
 */
function areAllShapesCulled(container: HTMLElement): boolean {
	const shapeElements = container.querySelectorAll('.tl-shape');
	if (shapeElements.length === 0) return false; // no DOM elements at all — different problem
	return Array.from(shapeElements).every(
		el => (el as HTMLElement).style.display === 'none'
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

	// Post-mount visibility check: ensure shapes are visible after tldraw initializes.
	// tldraw's initial updateViewportScreenBounds may use bad getBoundingClientRect() values,
	// resulting in a 1x1 viewport that culls all shapes. We check at escalating intervals
	// and fix if needed, starting after tldraw's _willSetInitialBounds has been consumed.
	useEffect(() => {
		if (!editor) return;

		let cancelled = false;

		const ensureVisible = () => {
			if (cancelled) return;
			const shapeCount = editor.getCurrentPageShapeIds().size;
			if (shapeCount === 0) return; // empty diagram is valid

			const container = editor.getContainer();
			if (!container?.isConnected) return;

			const shapeElements = container.querySelectorAll('.tl-shape');
			const noShapesInDom = shapeElements.length === 0;
			const allCulled = !noShapesInDom && areAllShapesCulled(container);

			if (noShapesInDom || allCulled) {
				debugLog(`Post-mount fix: ${shapeCount} shapes, ${shapeElements.length} in DOM, allCulled=${allCulled}`);
				forceViewportUpdate(editor);
			}
		};

		// Check at escalating intervals (after tldraw's initial setup completes)
		const timers = [
			setTimeout(ensureVisible, 300),
			setTimeout(ensureVisible, 700),
			setTimeout(ensureVisible, 1500),
			setTimeout(ensureVisible, 3000),
		];

		return () => {
			cancelled = true;
			timers.forEach(clearTimeout);
		};
	}, [editor]);

	// Ongoing health check: detect blank canvas from viewport corruption.
	// Catches both: (a) shapes not in DOM at all, (b) shapes in DOM but all culled.
	useEffect(() => {
		if (!editor) return;

		let failCount = 0;

		const interval = setInterval(() => {
			try {
				const shapeCount = editor.getCurrentPageShapeIds().size;
				if (shapeCount === 0) {
					failCount = 0;
					return;
				}

				const container = editor.getContainer();
				if (!container?.isConnected) {
					failCount++;
					if (failCount >= 3) {
						failCount = 0;
						onRecoveryNeeded();
					}
					return;
				}

				const shapeElements = container.querySelectorAll('.tl-shape');
				const noShapesInDom = shapeElements.length === 0;
				const allCulled = !noShapesInDom && areAllShapesCulled(container);

				if (noShapesInDom || allCulled) {
					failCount++;
					debugLog(`Health: ${shapeCount} shapes, ${shapeElements.length} in DOM, allCulled=${allCulled} (${failCount}/5)`);

					// Try viewport fix first
					const fixed = forceViewportUpdate(editor);

					if (!fixed && failCount >= 5) {
						debugLog('Health: viewport fix exhausted — remounting');
						failCount = 0;
						onRecoveryNeeded();
					}
				} else {
					failCount = 0;
				}
			} catch {
				failCount++;
				if (failCount >= 3) {
					failCount = 0;
					onRecoveryNeeded();
				}
			}
		}, 2000);

		return () => clearInterval(interval);
	}, [editor, onRecoveryNeeded]);

	return (
		<div style={{ position: 'absolute', inset: 0 }}>
			<Tldraw onMount={handleMount} autoFocus={false} />
		</div>
	);
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
