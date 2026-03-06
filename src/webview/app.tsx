import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Tldraw, Box, type Editor, parseTldrawJsonFile, loadSnapshot, getSnapshot } from 'tldraw';
import 'tldraw/tldraw.css';
import { vscode } from './vscode';

function debugLog(msg: string) {
	const d = document.getElementById('debug');
	if (d) {
		d.style.display = 'block';
		d.textContent = msg;
		setTimeout(() => { d.style.display = 'none'; }, 10_000);
	}
	console.log('[tldraw-viz]', msg);
}

class ErrorBoundary extends Component<
	{ children: React.ReactNode },
	{ error: Error | null }
> {
	state = { error: null as Error | null };
	static getDerivedStateFromError(error: Error) { return { error }; }
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

// Read file data embedded in HTML by the extension (no message passing needed)
function getEmbeddedFileData(): string | null {
	const el = document.getElementById('tldraw-data');
	if (!el?.textContent) return null;
	try {
		return atob(el.textContent);
	} catch {
		return null;
	}
}

function App() {
	const fileContents = useRef(getEmbeddedFileData());

	if (!fileContents.current) {
		return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#c00' }}>No diagram data found.</div>;
	}

	return (
		<ErrorBoundary>
			<TldrawEditor fileContents={fileContents.current} />
		</ErrorBoundary>
	);
}

function TldrawEditor({ fileContents }: { fileContents: string }) {
	const [containerReady, setContainerReady] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const editorRef = useRef<Editor | null>(null);

	// Wait for the container to have real dimensions before mounting tldraw.
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const check = () => {
			const rect = el.getBoundingClientRect();
			if (rect.width > 10 && rect.height > 10) {
				debugLog(`Container ready: ${Math.round(rect.width)}x${Math.round(rect.height)}`);
				setContainerReady(true);
				return true;
			}
			return false;
		};

		if (check()) return;

		const observer = new ResizeObserver(() => {
			if (check()) observer.disconnect();
		});
		observer.observe(el);

		const interval = setInterval(() => {
			if (check()) {
				clearInterval(interval);
				observer.disconnect();
			}
		}, 100);

		return () => {
			observer.disconnect();
			clearInterval(interval);
		};
	}, []);

	const handleMount = useCallback((ed: Editor) => {
		try {
			// Sanitize: strip vscode:// URLs and remove broken zero-size frames
			let data = JSON.parse(fileContents);
			if (Array.isArray(data.records)) {
				const brokenFrameIds = new Set<string>();
				data.records = data.records.filter((r: Record<string, unknown>) => {
					if (r.type === 'frame') {
						const props = r.props as { w?: number; h?: number } | undefined;
						if (!props?.w || !props?.h) {
							brokenFrameIds.add(r.id as string);
							return false;
						}
					}
					// Strip vscode:// URLs
					if (r.props && typeof (r.props as Record<string, unknown>).url === 'string') {
						const url = (r.props as Record<string, string>).url;
						if (url.startsWith('vscode://')) {
							(r.props as Record<string, string>).url = '';
						}
					}
					return true;
				});
				// Remove any shapes parented to broken frames
				if (brokenFrameIds.size > 0) {
					data.records = data.records.filter((r: Record<string, unknown>) =>
						!brokenFrameIds.has(r.parentId as string)
					);
					debugLog(`Removed ${brokenFrameIds.size} broken frame(s)`);
				}
			}
			const sanitized = JSON.stringify(data);
			const parseResult = parseTldrawJsonFile({
				json: sanitized,
				schema: ed.store.schema,
			});
			if (parseResult.ok) {
				const parsed = parseResult.value;
				const snapshot = getSnapshot(parsed);
				loadSnapshot(ed.store, { document: snapshot.document });
				debugLog(`Loaded ${ed.getCurrentPageShapeIds().size} shapes`);
			} else {
				console.error('[tldraw-viz] Parse failed:', parseResult.error);
			}
		} catch (err) {
			console.error('[tldraw-viz] Error loading file:', err);
		}

		ed.updateInstanceState({ isReadonly: true });

		const pages = ed.getPages();
		if (pages.length > 0) {
			ed.setCurrentPage(pages[0].id);
		}

		// Force viewport + zoomToFit at escalating delays.
		// tldraw in VS Code's iframe often needs time to settle before
		// it can properly calculate viewport bounds and render shapes.
		const fixViewport = () => {
			try {
				const container = ed.getContainer();
				if (container?.isConnected) {
					const rect = container.getBoundingClientRect();
					if (rect.width > 10 && rect.height > 10) {
						ed.updateViewportScreenBounds(container);
					} else {
						const w = window.innerWidth || 800;
						const h = window.innerHeight || 600;
						ed.updateViewportScreenBounds(new Box(0, 0, w, h));
					}
				}
				ed.zoomToFit({ animation: { duration: 0 } });
			} catch { /* ignore */ }
		};

		// Try immediately, then retry at escalating delays
		requestAnimationFrame(fixViewport);
		setTimeout(fixViewport, 100);
		setTimeout(fixViewport, 500);
		setTimeout(fixViewport, 1500);

		editorRef.current = ed;

		// Click-to-navigate: listen for shape selection changes
		let lastSelectedId: string | null = null;
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;

		ed.store.listen(
			() => {
				if (debounceTimer) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(() => {
					const selectedIds = ed.getSelectedShapeIds();
					if (selectedIds.length !== 1) {
						lastSelectedId = null;
						return;
					}

					const shapeId = selectedIds[0];
					if (shapeId === lastSelectedId) return;
					lastSelectedId = shapeId;

					const shape = ed.getShape(shapeId);
					if (!shape || shape.type !== 'geo') return;

					const meta = shape.meta as {
						sourceLine?: number;
						sourceName?: string;
						sourceFile?: string;
					} | undefined;
					if (!meta) return;

					const docMeta = (ed.getDocumentSettings().meta as {
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

		// Fix viewport when tab becomes visible again
		function handleVisibility() {
			if (!document.hidden) {
				setTimeout(() => {
					try {
						const container = ed.getContainer();
						if (container?.isConnected) {
							ed.updateViewportScreenBounds(container);
							ed.zoomToFit({ animation: { duration: 0 } });
						}
					} catch { /* editor may be disposed */ }
				}, 200);
			}
		}
		document.addEventListener('visibilitychange', handleVisibility);
	}, [fileContents]);

	return (
		<div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
			{containerReady ? (
				<Tldraw onMount={handleMount} autoFocus={false} />
			) : (
				<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888' }}>
					Waiting for layout...
				</div>
			)}
		</div>
	);
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
