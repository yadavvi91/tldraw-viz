import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Tldraw, type Editor } from 'tldraw';
import 'tldraw/tldraw.css';
import type { ExtensionToWebview } from '../messages';
import { vscode } from './vscode';

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

	return <TldrawEditor fileContents={fileData.fileContents} uri={fileData.uri} />;
}

function TldrawEditor({ fileContents, uri }: { fileContents: string; uri: string }) {
	const handleMount = (editor: Editor) => {
		// Load the .tldr file contents
		try {
			const file = JSON.parse(fileContents);
			editor.loadSnapshot(file);
		} catch {
			// File may already be loaded via persistenceKey
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
				const file = meta.sourceFile || docMeta?.tldrawViz?.sourceFile || '';
				const line = meta.sourceLine || 0;
				const name = meta.sourceName || '';

				if (!file || line === 0) return;

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
			<Tldraw
				onMount={handleMount}
				persistenceKey={uri}
			/>
		</div>
	);
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
