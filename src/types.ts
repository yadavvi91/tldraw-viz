/** A node in the call graph (function, method, class) */
export interface CodeNode {
	id: string;
	name: string;
	type: 'function' | 'method' | 'class' | 'interface' | 'variable';
	line: number;
	/** Parent class name if this is a method */
	parent?: string;
}

/** A directed edge in the call graph */
export interface CodeEdge {
	from: string;
	to: string;
	label?: string;
}

/** Extracted call graph from a source file */
export interface CallGraph {
	nodes: CodeNode[];
	edges: CodeEdge[];
	fileName: string;
	language: string;
}

/** A positioned node after dagre layout */
export interface PositionedNode extends CodeNode {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** tldraw shape record */
export interface TldrShape {
	id: string;
	typeName: 'shape';
	type: string;
	x: number;
	y: number;
	rotation: number;
	isLocked: boolean;
	opacity: number;
	parentId: string;
	index: string;
	props: Record<string, unknown>;
	meta: Record<string, unknown>;
}

/** tldraw binding record */
export interface TldrBinding {
	id: string;
	typeName: 'binding';
	type: string;
	fromId: string;
	toId: string;
	props: Record<string, unknown>;
	meta: Record<string, unknown>;
}

/** Complete .tldr file structure */
export interface TldrFile {
	tldrawFileFormatVersion: number;
	schema: TldrSchema;
	records: TldrRecord[];
}

export interface TldrSchema {
	schemaVersion: number;
	sequences: Record<string, number>;
}

export type TldrRecord = TldrShape | TldrBinding | Record<string, unknown>;

/** Metadata we embed in .tldr files for staleness detection */
export interface TldrawVizMeta {
	sourceFile: string;
	sourceHash: string;
	generatedAt: string;
	generatorVersion: string;
	type: 'file' | 'flow';
}
