/** Semantic role for a node in the diagram */
export type NodeRole =
	| 'user-action'
	| 'process'
	| 'callback'
	| 'decision'
	| 'display'
	| 'parent'
	| 'hidden'
	| 'entrypoint';

/** Visual shape for a node in tldraw */
export type NodeShape =
	| 'rectangle'
	| 'diamond'
	| 'ellipse'
	| 'cloud'
	| 'hexagon'
	| 'oval';

/** Edge line style */
export type EdgeStyle = 'solid' | 'dashed' | 'dotted';

/** A named group of nodes (rendered as a tldraw frame) */
export interface NodeGroup {
	id: string;
	label: string;
	nodeIds: string[];
}

/** A node in the call graph (function, method, class) */
export interface CodeNode {
	id: string;
	name: string;
	type: 'function' | 'method' | 'class' | 'interface' | 'variable';
	line: number;
	/** Parent class name if this is a method */
	parent?: string;
	/** Semantic role assigned by SemanticAnalyzer */
	role?: NodeRole;
	/** Visual shape override */
	shape?: NodeShape;
	/** tldraw color name override */
	color?: string;
	/** Group this node belongs to */
	groupId?: string;
	/** Display label (overrides default "name()" text in diagram) */
	label?: string;
}

/** A directed edge in the call graph */
export interface CodeEdge {
	from: string;
	to: string;
	label?: string;
	/** Edge line style (solid, dashed, dotted) */
	style?: EdgeStyle;
}

/** Extracted call graph from a source file */
export interface CallGraph {
	nodes: CodeNode[];
	edges: CodeEdge[];
	fileName: string;
	language: string;
	/** Semantic groups for subgraph rendering */
	groups?: NodeGroup[];
}

/** A positioned node after dagre layout */
export interface PositionedNode extends CodeNode {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A positioned group with bounding box after layout */
export interface PositionedGroup extends NodeGroup {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Layout result containing both positioned nodes and groups */
export interface LayoutResult {
	nodes: PositionedNode[];
	groups: PositionedGroup[];
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
	type: 'file' | 'flow' | 'project';
}
