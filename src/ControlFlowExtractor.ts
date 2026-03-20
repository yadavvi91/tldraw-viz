import type Parser from 'web-tree-sitter';
import type { LanguageConfig } from './languages';
import type { ControlFlowEdge, ControlFlowGraph, ControlFlowNode, ControlFlowNodeType } from './types';

/** Maximum number of nodes before we start collapsing sequential expressions */
const MAX_NODES = 80;

let nextId = 0;
function makeId(prefix: string): string {
	return `cf-${prefix}-${nextId++}`;
}

/** Get a short label from a syntax node (truncated to max chars) */
function nodeLabel(node: Parser.SyntaxNode, maxLen = 60): string {
	let text = node.text.replace(/\s+/g, ' ').trim();
	if (text.length > maxLen) {
		text = text.slice(0, maxLen - 3) + '...';
	}
	return text;
}

/** Determine the condition text from an if/while/for node */
function conditionText(node: Parser.SyntaxNode): string {
	const cond = node.childForFieldName('condition');
	if (cond) return nodeLabel(cond, 50);
	// for_statement: extract the middle expression
	const parts = node.children.filter(c => c.type !== '(' && c.type !== ')' && c.type !== 'comment');
	if (parts.length >= 3) return nodeLabel(parts[1], 50);
	return nodeLabel(node, 50);
}

interface ExtractionContext {
	config: LanguageConfig;
	cfConfig: NonNullable<LanguageConfig['controlFlow']>;
	nodes: ControlFlowNode[];
	edges: ControlFlowEdge[];
}

/**
 * Extract a control flow graph from a function's body AST node.
 *
 * @param functionNode The function/method AST node (must have a body field)
 * @param functionName Name of the function
 * @param sourceFile Relative path to source file
 * @param config Language config (must have controlFlow defined)
 */
export function extractControlFlow(
	functionNode: Parser.SyntaxNode,
	functionName: string,
	sourceFile: string,
	config: LanguageConfig,
): ControlFlowGraph {
	const cfConfig = config.controlFlow;
	if (!cfConfig) {
		throw new Error(`Language config for "${config.languageIds[0]}" has no controlFlow config`);
	}

	nextId = 0;

	const ctx: ExtractionContext = {
		config,
		cfConfig,
		nodes: [],
		edges: [],
	};

	// Entry node
	const entryNode = addNode(ctx, {
		id: makeId('entry'),
		label: `entry: ${functionName}`,
		cfType: 'entry',
		startByte: functionNode.startIndex,
		endByte: functionNode.startIndex,
		line: functionNode.startPosition.row + 1,
	});

	// Exit node
	const exitNode = addNode(ctx, {
		id: makeId('exit'),
		label: 'exit',
		cfType: 'exit',
		startByte: functionNode.endIndex,
		endByte: functionNode.endIndex,
		line: functionNode.endPosition.row + 1,
	});

	// Get the function body
	const body = functionNode.childForFieldName(config.bodyField);
	if (!body) {
		// No body (e.g. abstract method) — just connect entry→exit
		addEdge(ctx, entryNode, exitNode);
		return {
			functionName,
			functionLine: functionNode.startPosition.row + 1,
			sourceFile,
			nodes: ctx.nodes,
			edges: ctx.edges,
		};
	}

	// Process the body statements
	const { exits } = processBlock(ctx, body, entryNode, exitNode);

	// Connect any dangling exits to the exit node
	for (const exitFrom of exits) {
		addEdge(ctx, exitFrom, exitNode);
	}

	return {
		functionName,
		functionLine: functionNode.startPosition.row + 1,
		sourceFile,
		nodes: ctx.nodes,
		edges: ctx.edges,
	};
}

/** Result of processing a block of statements */
interface BlockResult {
	/** Nodes that flow out the bottom (need to connect to whatever comes next) */
	exits: string[];
}

/**
 * Process a block of statements (statement_block, block, etc.).
 * Returns the set of node IDs that exit from the bottom of this block.
 */
function processBlock(
	ctx: ExtractionContext,
	blockNode: Parser.SyntaxNode,
	fromId: string,
	exitNodeId: string,
): BlockResult {
	const statements = blockNode.namedChildren;
	if (statements.length === 0) {
		return { exits: [fromId] };
	}

	let currentFromIds = [fromId];

	for (let i = 0; i < statements.length; i++) {
		const stmt = statements[i];

		// Skip type annotations, comments, etc.
		if (stmt.type === 'comment' || stmt.type === 'type_alias_declaration') {
			continue;
		}

		const result = processStatement(ctx, stmt, currentFromIds, exitNodeId);
		currentFromIds = result.exits;

		// If no exits, the rest of the block is unreachable
		if (currentFromIds.length === 0) break;
	}

	return { exits: currentFromIds };
}

/**
 * Process a single statement and return exit node IDs.
 */
function processStatement(
	ctx: ExtractionContext,
	stmt: Parser.SyntaxNode,
	fromIds: string[],
	exitNodeId: string,
): BlockResult {
	const { cfConfig } = ctx;

	// if_statement
	if (cfConfig.ifTypes.includes(stmt.type)) {
		return processIf(ctx, stmt, fromIds, exitNodeId);
	}

	// for_statement / for_in_statement
	if (cfConfig.forTypes.includes(stmt.type)) {
		return processLoop(ctx, stmt, fromIds, exitNodeId, 'for-loop');
	}

	// while_statement / do_statement
	if (cfConfig.whileTypes.includes(stmt.type)) {
		return processLoop(ctx, stmt, fromIds, exitNodeId, 'while-loop');
	}

	// try_statement
	if (cfConfig.tryTypes.includes(stmt.type)) {
		return processTry(ctx, stmt, fromIds, exitNodeId);
	}

	// return_statement
	if (cfConfig.returnTypes.includes(stmt.type)) {
		const node = addNode(ctx, {
			id: makeId('return'),
			label: nodeLabel(stmt),
			cfType: 'return',
			startByte: stmt.startIndex,
			endByte: stmt.endIndex,
			line: stmt.startPosition.row + 1,
		});
		connectAll(ctx, fromIds, node);
		// return connects directly to exit — no further flow
		addEdge(ctx, node, exitNodeId);
		return { exits: [] };
	}

	// throw_statement
	if (cfConfig.throwTypes.includes(stmt.type)) {
		const node = addNode(ctx, {
			id: makeId('throw'),
			label: nodeLabel(stmt),
			cfType: 'throw',
			startByte: stmt.startIndex,
			endByte: stmt.endIndex,
			line: stmt.startPosition.row + 1,
		});
		connectAll(ctx, fromIds, node);
		return { exits: [] };
	}

	// switch_statement
	if (cfConfig.switchTypes?.includes(stmt.type)) {
		return processSwitch(ctx, stmt, fromIds, exitNodeId);
	}

	// Generic statement — classify by content
	const cfType = classifyStatement(stmt, ctx);
	const node = addNode(ctx, {
		id: makeId(cfType),
		label: nodeLabel(stmt),
		cfType,
		startByte: stmt.startIndex,
		endByte: stmt.endIndex,
		line: stmt.startPosition.row + 1,
	});
	connectAll(ctx, fromIds, node);
	return { exits: [node] };
}

/** Process an if/else chain */
function processIf(
	ctx: ExtractionContext,
	ifNode: Parser.SyntaxNode,
	fromIds: string[],
	exitNodeId: string,
): BlockResult {
	const condNode = addNode(ctx, {
		id: makeId('if'),
		label: `if (${conditionText(ifNode)})`,
		cfType: 'if-condition',
		startByte: ifNode.startIndex,
		endByte: ifNode.endIndex,
		line: ifNode.startPosition.row + 1,
	});
	connectAll(ctx, fromIds, condNode);

	const allExits: string[] = [];

	// True branch (consequence)
	const consequence = ifNode.childForFieldName('consequence');
	if (consequence) {
		const trueResult = processBlock(ctx, consequence, condNode, exitNodeId);
		// Label the first edge from condNode to the first true-branch node
		labelLastEdgeFrom(ctx, condNode, 'true');
		allExits.push(...trueResult.exits);
	} else {
		allExits.push(condNode);
	}

	// False branch (alternative) — could be else-if or else block
	const alternative = ifNode.childForFieldName('alternative');
	if (alternative) {
		if (alternative.type === 'else_clause') {
			const elseBody = alternative.namedChildren[0];
			if (elseBody && cfConfig(ctx).ifTypes.includes(elseBody.type)) {
				// else if — recursive
				const elseIfResult = processIf(ctx, elseBody, [condNode], exitNodeId);
				allExits.push(...elseIfResult.exits);
			} else if (elseBody) {
				const falseResult = processBlock(ctx, elseBody, condNode, exitNodeId);
				labelLastEdgeFrom(ctx, condNode, 'false');
				allExits.push(...falseResult.exits);
			} else {
				allExits.push(condNode);
			}
		} else if (cfConfig(ctx).ifTypes.includes(alternative.type)) {
			// else if (chained)
			const elseIfResult = processIf(ctx, alternative, [condNode], exitNodeId);
			allExits.push(...elseIfResult.exits);
		} else {
			const falseResult = processBlock(ctx, alternative, condNode, exitNodeId);
			labelLastEdgeFrom(ctx, condNode, 'false');
			allExits.push(...falseResult.exits);
		}
	} else {
		// No else — false branch falls through
		allExits.push(condNode);
	}

	return { exits: allExits };
}

/** Process a for/while loop */
function processLoop(
	ctx: ExtractionContext,
	loopNode: Parser.SyntaxNode,
	fromIds: string[],
	exitNodeId: string,
	cfType: 'for-loop' | 'while-loop',
): BlockResult {
	const condNode = addNode(ctx, {
		id: makeId(cfType),
		label: `${cfType === 'for-loop' ? 'for' : 'while'} (${conditionText(loopNode)})`,
		cfType,
		startByte: loopNode.startIndex,
		endByte: loopNode.endIndex,
		line: loopNode.startPosition.row + 1,
	});
	connectAll(ctx, fromIds, condNode);

	// Loop body
	const body = loopNode.childForFieldName('body');
	if (body) {
		const bodyResult = processBlock(ctx, body, condNode, exitNodeId);
		labelLastEdgeFrom(ctx, condNode, 'body');
		// Back-edge: body exits loop back to condition
		for (const exitFrom of bodyResult.exits) {
			addEdge(ctx, exitFrom, condNode, 'loop');
		}
	}

	// Exit: condition is false → falls through
	return { exits: [condNode] };
}

/** Process a try/catch/finally block */
function processTry(
	ctx: ExtractionContext,
	tryNode: Parser.SyntaxNode,
	fromIds: string[],
	exitNodeId: string,
): BlockResult {
	const tryLabel = addNode(ctx, {
		id: makeId('try'),
		label: 'try',
		cfType: 'try',
		startByte: tryNode.startIndex,
		endByte: tryNode.endIndex,
		line: tryNode.startPosition.row + 1,
	});
	connectAll(ctx, fromIds, tryLabel);

	const allExits: string[] = [];

	// Try body
	const body = tryNode.childForFieldName('body');
	if (body) {
		const bodyResult = processBlock(ctx, body, tryLabel, exitNodeId);
		allExits.push(...bodyResult.exits);
	}

	// Catch handler(s)
	const catchClauses = tryNode.namedChildren.filter(c =>
		c.type === 'catch_clause'
	);
	for (const catchClause of catchClauses) {
		const catchNode = addNode(ctx, {
			id: makeId('catch'),
			label: `catch${catchClause.childForFieldName('parameter') ? ` (${nodeLabel(catchClause.childForFieldName('parameter')!, 30)})` : ''}`,
			cfType: 'catch',
			startByte: catchClause.startIndex,
			endByte: catchClause.endIndex,
			line: catchClause.startPosition.row + 1,
		});
		addEdge(ctx, tryLabel, catchNode, 'catch');

		const catchBody = catchClause.childForFieldName('body');
		if (catchBody) {
			const catchResult = processBlock(ctx, catchBody, catchNode, exitNodeId);
			allExits.push(...catchResult.exits);
		} else {
			allExits.push(catchNode);
		}
	}

	// Finally handler
	const finallyClause = tryNode.namedChildren.find(c =>
		c.type === 'finally_clause'
	);
	if (finallyClause) {
		const finallyNode = addNode(ctx, {
			id: makeId('finally'),
			label: 'finally',
			cfType: 'finally',
			startByte: finallyClause.startIndex,
			endByte: finallyClause.endIndex,
			line: finallyClause.startPosition.row + 1,
		});
		// All exits from try/catch funnel through finally
		connectAll(ctx, allExits, finallyNode);
		allExits.length = 0;

		const finallyBody = finallyClause.childForFieldName('body');
		if (finallyBody) {
			const fResult = processBlock(ctx, finallyBody, finallyNode, exitNodeId);
			allExits.push(...fResult.exits);
		} else {
			allExits.push(finallyNode);
		}
	}

	return { exits: allExits };
}

/** Process a switch statement */
function processSwitch(
	ctx: ExtractionContext,
	switchNode: Parser.SyntaxNode,
	fromIds: string[],
	exitNodeId: string,
): BlockResult {
	const disc = switchNode.childForFieldName('value') || switchNode.childForFieldName('condition');
	const switchLabel = addNode(ctx, {
		id: makeId('switch'),
		label: `switch (${disc ? nodeLabel(disc, 40) : '...'})`,
		cfType: 'if-condition',
		startByte: switchNode.startIndex,
		endByte: switchNode.endIndex,
		line: switchNode.startPosition.row + 1,
	});
	connectAll(ctx, fromIds, switchLabel);

	const allExits: string[] = [];
	const body = switchNode.childForFieldName('body');
	if (!body) return { exits: [switchLabel] };

	const cases = body.namedChildren.filter(c =>
		c.type === 'switch_case' || c.type === 'switch_default'
	);
	for (const caseNode of cases) {
		const isDefault = caseNode.type === 'switch_default';
		const caseValue = caseNode.childForFieldName('value');
		const label = isDefault ? 'default' : `case ${caseValue ? nodeLabel(caseValue, 30) : '...'}`;

		// Process case body statements (everything after the colon)
		const stmts = caseNode.namedChildren.filter(c => c.type !== 'comment');
		if (stmts.length === 0) {
			allExits.push(switchLabel);
			continue;
		}

		// First statement gets labeled edge from switch
		let currentFromIds = [switchLabel];
		for (const stmt of stmts) {
			if (stmt.type === 'break_statement') {
				// break exits the switch
				allExits.push(...currentFromIds);
				currentFromIds = [];
				break;
			}
			const result = processStatement(ctx, stmt, currentFromIds, exitNodeId);
			currentFromIds = result.exits;
		}
		// Label the edge from switch to first case node
		labelLastEdgeFrom(ctx, switchLabel, label);
		allExits.push(...currentFromIds);
	}

	return { exits: allExits };
}

/** Classify a generic statement by its content */
function classifyStatement(
	stmt: Parser.SyntaxNode,
	ctx: ExtractionContext,
): ControlFlowNodeType {
	// Check for await expressions
	if (containsType(stmt, ctx.cfConfig.awaitTypes)) {
		return 'await';
	}

	// Check for call expressions
	if (containsType(stmt, ctx.config.callTypes)) {
		return 'call';
	}

	// Variable declarations / assignments
	if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration'
		|| stmt.type === 'expression_statement' && stmt.namedChildren[0]?.type === 'assignment_expression') {
		return 'assignment';
	}

	return 'expression';
}

/** Check if any descendant of node has one of the given types */
function containsType(node: Parser.SyntaxNode, types: string[]): boolean {
	if (types.includes(node.type)) return true;
	for (const child of node.children) {
		if (containsType(child, types)) return true;
	}
	return false;
}

// ── Helpers ─────────────────────────────────────────────────────────

function addNode(ctx: ExtractionContext, node: ControlFlowNode): string {
	ctx.nodes.push(node);
	return node.id;
}

function addEdge(ctx: ExtractionContext, from: string, to: string, label?: string): void {
	// Avoid duplicate edges
	if (ctx.edges.some(e => e.from === from && e.to === to)) return;
	ctx.edges.push({ from, to, label });
}

function connectAll(ctx: ExtractionContext, fromIds: string[], toId: string): void {
	for (const from of fromIds) {
		addEdge(ctx, from, toId);
	}
}

/** Label the most recent edge from a given node */
function labelLastEdgeFrom(ctx: ExtractionContext, fromId: string, label: string): void {
	for (let i = ctx.edges.length - 1; i >= 0; i--) {
		if (ctx.edges[i].from === fromId && !ctx.edges[i].label) {
			ctx.edges[i].label = label;
			return;
		}
	}
}

/** Helper to get cfConfig from context */
function cfConfig(ctx: ExtractionContext): NonNullable<LanguageConfig['controlFlow']> {
	return ctx.cfConfig;
}
