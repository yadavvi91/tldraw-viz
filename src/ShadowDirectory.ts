import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';

export class ShadowDirectory {
	private shadowDirName: string;
	private mermaidDirName: string;

	constructor(private workspaceRoot: vscode.Uri) {
		const config = vscode.workspace.getConfiguration('tldraw-viz');
		this.shadowDirName = config.get('shadowDir', '.tldraw');
		this.mermaidDirName = config.get('mermaidDir', '.mermaid');
	}

	/** Map a source file URI to its .tldr path in the shadow directory */
	getTldrUri(sourceUri: vscode.Uri): vscode.Uri {
		const relativePath = path.relative(
			this.workspaceRoot.fsPath,
			sourceUri.fsPath,
		);
		return vscode.Uri.joinPath(
			this.workspaceRoot,
			this.shadowDirName,
			relativePath + '.tldr',
		);
	}

	/** Map a flow name to its .tldr path */
	getFlowUri(flowName: string): vscode.Uri {
		return vscode.Uri.joinPath(
			this.workspaceRoot,
			this.shadowDirName,
			'flows',
			`${flowName}.tldr`,
		);
	}

	/** Get the .mermaid directory name */
	getMermaidDir(): string {
		return this.mermaidDirName;
	}

	/** Map a source file URI to its overview .mmd path in the .mermaid directory */
	getMermaidOverviewUri(sourceUri: vscode.Uri): vscode.Uri {
		const relativePath = path.relative(
			this.workspaceRoot.fsPath,
			sourceUri.fsPath,
		);
		return vscode.Uri.joinPath(
			this.workspaceRoot,
			this.mermaidDirName,
			relativePath + '.overview.mmd',
		);
	}

	/** Map a source file URI to its detail .mmd path in the .mermaid directory */
	getMermaidDetailUri(sourceUri: vscode.Uri): vscode.Uri {
		const relativePath = path.relative(
			this.workspaceRoot.fsPath,
			sourceUri.fsPath,
		);
		return vscode.Uri.joinPath(
			this.workspaceRoot,
			this.mermaidDirName,
			relativePath + '.detail.mmd',
		);
	}

	/** Get the .tldr path for the project architecture diagram */
	getProjectUri(): vscode.Uri {
		return vscode.Uri.joinPath(
			this.workspaceRoot,
			this.shadowDirName,
			'project-architecture.tldr',
		);
	}

	/** Get the .mmd path for the project architecture diagram */
	getProjectMermaidUri(): vscode.Uri {
		return vscode.Uri.joinPath(
			this.workspaceRoot,
			this.mermaidDirName,
			'project-architecture.mmd',
		);
	}

	/** Compute a short content hash for staleness detection */
	computeHash(content: string): string {
		return crypto
			.createHash('sha256')
			.update(content)
			.digest('hex')
			.slice(0, 16);
	}

	/** Write a .tldr file, creating parent directories as needed */
	async writeTldr(uri: vscode.Uri, content: string): Promise<void> {
		const data = Buffer.from(content, 'utf-8');
		await vscode.workspace.fs.writeFile(uri, data);
	}

	/** Read a .tldr file, returns null if not found */
	async readTldr(uri: vscode.Uri): Promise<string | null> {
		try {
			const data = await vscode.workspace.fs.readFile(uri);
			return Buffer.from(data).toString('utf-8');
		} catch {
			return null;
		}
	}

	/** Check if a cached diagram is still fresh */
	async isFresh(sourceUri: vscode.Uri, currentContent: string): Promise<boolean> {
		const tldrUri = this.getTldrUri(sourceUri);
		const raw = await this.readTldr(tldrUri);
		if (!raw) return false;

		try {
			const data = JSON.parse(raw);
			const docRecord = data.records?.find(
				(r: Record<string, unknown>) => r.id === 'document:document',
			);
			const storedHash = docRecord?.meta?.tldrawViz?.sourceHash;
			return storedHash === this.computeHash(currentContent);
		} catch {
			return false;
		}
	}
}
