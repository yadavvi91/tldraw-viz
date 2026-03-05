import type Parser from 'web-tree-sitter';
import type { LanguageConfig } from './languages';
import type { CallGraph, CodeNode, CodeEdge, NodeGroup } from './types';

/** Callback prop name patterns */
const CALLBACK_PROP_PATTERN = /^on[A-Z]/;

// ─── Types for internal tracking ────────────────────────────────────────

interface HandlerInfo {
	/** Synthetic node ID for this user action */
	nodeId: string;
	/** Human-readable label */
	label: string;
	/** The AST node of the handler body (arrow function body or function expression body) */
	handlerBody: Parser.SyntaxNode;
	/** Which group this handler's flow belongs to */
	flowGroup: string;
}

interface CallbackInfo {
	/** The prop name (e.g. onDateChange) */
	propName: string;
	/** Synthetic node ID */
	nodeId: string;
	/** Human-readable name for the node */
	name: string;
	/** Label for display */
	label: string;
	/** Which group */
	flowGroup: string;
}

// ─── Main Entry Point ───────────────────────────────────────────────────

/**
 * Analyze a React component's behavioral flow.
 * Creates synthetic nodes for user actions, inline operations,
 * callback invocations, conditional logic, and display computations.
 *
 * Replaces the component function node with a detailed behavioral breakdown.
 * Returns true if behavioral analysis was performed, false if skipped.
 */
export function analyzeBehavior(
	graph: CallGraph,
	tree: Parser.Tree,
	config: LanguageConfig,
): boolean {
	const rootNode = tree.rootNode;

	// Find the component function (exported, name starts with uppercase)
	const componentNode = graph.nodes.find(
		n => n.type === 'function' && /^[A-Z]/.test(n.name),
	);
	if (!componentNode) return false;

	// Find callback props from interface
	const callbackProps = findCallbackProps(rootNode);
	if (callbackProps.length === 0) return false; // Not complex enough

	// Find the component's function body AST node
	const componentBody = findComponentBody(rootNode, componentNode.name, config);
	if (!componentBody) return false;

	// Track all new nodes, edges, groups
	const newNodes: CodeNode[] = [];
	const newEdges: CodeEdge[] = [];
	const groupMap = new Map<string, string[]>(); // groupLabel → nodeIds

	// Create synthetic parent node
	const parentNode: CodeNode = {
		id: 'synthetic-parent',
		name: 'Parent Component',
		type: 'function',
		line: 0,
		role: 'parent',
		shape: 'cloud',
		label: 'Parent Component',
	};
	newNodes.push(parentNode);

	// Pass 1: JSX Event Handlers → User Action nodes
	const handlers = extractJsxEventHandlers(componentBody, callbackProps);

	for (const handler of handlers) {
		const groupId = `group-${handler.flowGroup.toLowerCase().replace(/\s+/g, '-')}`;
		newNodes.push({
			id: handler.nodeId,
			name: handler.nodeId,
			type: 'function',
			line: 0,
			role: 'user-action',
			shape: 'oval',
			label: handler.label,
			groupId,
		});
		addToGroup(groupMap, 'User Interactions', handler.nodeId);
	}

	// Pass 2: Inline Operations → Process nodes
	const inlineOps = extractInlineOperations(handlers);

	for (const op of inlineOps) {
		const groupId = `group-${op.flowGroup.toLowerCase().replace(/\s+/g, '-')}`;
		newNodes.push({
			id: op.nodeId,
			name: op.nodeId,
			type: 'function',
			line: 0,
			role: 'process',
			shape: 'rectangle',
			label: op.label,
			groupId,
		});
		addToGroup(groupMap, op.flowGroup, op.nodeId);
	}

	// Wire: user-action → inline-ops (sequential within handler)
	wireHandlerToOps(handlers, inlineOps, newEdges);

	// Pass 3: Callback Prop Invocations → Callback nodes
	const callbacks = extractCallbackInvocations(componentBody, callbackProps, handlers);

	for (const cb of callbacks) {
		const groupId = `group-${cb.flowGroup.toLowerCase().replace(/\s+/g, '-')}`;
		newNodes.push({
			id: cb.nodeId,
			name: cb.name,
			type: 'function',
			line: 0,
			role: 'callback',
			shape: 'hexagon',
			label: cb.label,
			groupId,
		});
		addToGroup(groupMap, cb.flowGroup, cb.nodeId);

		// Wire callback → parent
		newEdges.push({
			from: cb.nodeId,
			to: 'synthetic-parent',
			label: 'to parent',
			style: 'solid',
		});
	}

	// Wire inline-ops → callbacks, or user-action → callback if no inline ops
	wireOpsToCallbacks(handlers, inlineOps, callbacks, newEdges, componentBody, callbackProps);

	// Pass 4: Conditional Logic → Decision nodes
	extractConditionalLogic(componentBody, newNodes, newEdges, groupMap, callbacks);

	// Pass 5: Display Computations → Display nodes
	extractDisplayComputations(componentBody, newNodes, newEdges, groupMap, graph);

	// Build NodeGroup array from groupMap
	const groups: NodeGroup[] = [];
	for (const [label, nodeIds] of groupMap) {
		if (nodeIds.length > 0) {
			const groupId = `group-${label.toLowerCase().replace(/\s+/g, '-')}`;
			groups.push({ id: groupId, label, nodeIds });
			// Set groupId on nodes
			for (const node of newNodes) {
				if (nodeIds.includes(node.id)) {
					node.groupId = groupId;
				}
			}
		}
	}

	// Remove the component node and its edges from the graph
	graph.nodes = graph.nodes.filter(n => n.id !== componentNode.id);
	graph.edges = graph.edges.filter(
		e => e.from !== componentNode.id && e.to !== componentNode.id,
	);

	// Also remove the existing declared helper functions' edges to/from component
	// (they'll be re-wired through display nodes)

	// Merge new nodes and edges into graph
	graph.nodes.push(...newNodes);
	graph.edges.push(...newEdges);
	graph.groups = [...(graph.groups || []), ...groups];

	return true;
}

// ─── Pass 1: JSX Event Handlers ─────────────────────────────────────────

function extractJsxEventHandlers(
	componentBody: Parser.SyntaxNode,
	callbackProps: string[],
): HandlerInfo[] {
	const handlers: HandlerInfo[] = [];
	const seen = new Set<string>();

	function walk(node: Parser.SyntaxNode): void {
		// Look for jsx_element or jsx_self_closing_element
		if (node.type === 'jsx_element' || node.type === 'jsx_self_closing_element') {
			const openingTag = node.type === 'jsx_element'
				? node.children.find(c => c.type === 'jsx_opening_element')
				: node;

			if (openingTag) {
				const tagName = getJsxTagName(openingTag);
				const attrs = getJsxAttributes(openingTag);

				// Check for event handler attributes
				for (const [attrName, attrValueNode] of attrs) {
					if (/^on(Change|Click|Submit|Input|Focus|Blur)$/.test(attrName)) {
						const handler = classifyHandler(tagName, attrName, attrValueNode, attrs, callbackProps);
						if (handler && !seen.has(handler.nodeId)) {
							seen.add(handler.nodeId);
							handlers.push(handler);
						}
					}
				}
			}
		}

		for (const child of node.children) {
			walk(child);
		}
	}

	walk(componentBody);
	return handlers;
}

function getJsxTagName(openingElement: Parser.SyntaxNode): string {
	// First child of jsx_opening_element is often the tag name identifier
	for (const child of openingElement.children) {
		if (child.type === 'identifier' || child.type === 'member_expression') {
			return child.text;
		}
	}
	return '';
}

function getJsxAttributes(
	openingElement: Parser.SyntaxNode,
): [string, Parser.SyntaxNode | null][] {
	const attrs: [string, Parser.SyntaxNode | null][] = [];
	for (const child of openingElement.children) {
		if (child.type === 'jsx_attribute') {
			const nameNode = child.children[0];
			const valueNode = child.children.length > 2 ? child.children[2] : null;
			if (nameNode) {
				attrs.push([nameNode.text, valueNode]);
			}
		}
	}
	return attrs;
}

function classifyHandler(
	tagName: string,
	attrName: string,
	attrValueNode: Parser.SyntaxNode | null,
	allAttrs: [string, Parser.SyntaxNode | null][],
	callbackProps: string[],
): HandlerInfo | null {
	const handlerBody = attrValueNode ? findHandlerBody(attrValueNode) : null;

	// Input elements: classify by type attribute
	if (tagName === 'input') {
		const typeAttr = allAttrs.find(([name]) => name === 'type');
		const inputType = typeAttr?.[1]?.text?.replace(/['"{}]/g, '') || 'text';

		if (inputType === 'date' && attrName === 'onChange') {
			return {
				nodeId: 'pickDate',
				label: 'User picks a date',
				handlerBody: handlerBody!,
				flowGroup: 'User Interactions',
			};
		}
		if (inputType === 'range' && attrName === 'onChange') {
			return {
				nodeId: 'dragSlider',
				label: 'User drags time slider',
				handlerBody: handlerBody!,
				flowGroup: 'User Interactions',
			};
		}
	}

	// Button elements: classify by the callback they invoke
	if (tagName === 'button' && attrName === 'onClick' && attrValueNode) {
		const callbackName = findCallbackInHandler(attrValueNode, callbackProps);
		if (callbackName && handlerBody) {
			const info = getActionForCallback(callbackName);
			return {
				nodeId: info.actionId,
				label: info.actionLabel,
				handlerBody,
				flowGroup: 'User Interactions',
			};
		}
	}

	return null;
}

/** Map callback prop names to user action identifiers (well-known mappings) */
const CALLBACK_TO_ACTION: Record<string, { actionId: string; actionLabel: string }> = {
	onAnimationModeChange: { actionId: 'clickMode', actionLabel: 'User clicks daily/yearly/monthly' },
	onAnimationSpeedChange: { actionId: 'clickSpeed', actionLabel: 'User clicks 1x/2x/5x/10x' },
	onTogglePlay: { actionId: 'clickPlay', actionLabel: 'User clicks play/pause' },
};

/** Generate a generic action ID and label from a callback prop name */
function getActionForCallback(callbackName: string): { actionId: string; actionLabel: string } {
	if (CALLBACK_TO_ACTION[callbackName]) return CALLBACK_TO_ACTION[callbackName];
	// onFoo → clickFoo / "User clicks foo"
	const base = callbackName.replace(/^on/, '');
	const lower = base.charAt(0).toLowerCase() + base.slice(1);
	return {
		actionId: `click${base}`,
		actionLabel: `User clicks ${lower}`,
	};
}

function findHandlerBody(attrValue: Parser.SyntaxNode): Parser.SyntaxNode | null {
	// The handler is typically inside a jsx_expression: {(e) => { ... }}
	// or {handleClick} (identifier reference)
	let result: Parser.SyntaxNode | null = null;

	function walk(node: Parser.SyntaxNode): void {
		if (result) return;
		if (node.type === 'arrow_function' || node.type === 'function') {
			result = node.childForFieldName('body') || node;
			return;
		}
		for (const child of node.children) {
			walk(child);
		}
	}

	walk(attrValue);
	return result;
}

function findCallbackInHandler(
	attrValue: Parser.SyntaxNode,
	callbackProps: string[],
): string | null {
	const callbackSet = new Set(callbackProps);
	let found: string | null = null;

	function walk(node: Parser.SyntaxNode): void {
		if (found) return;
		if (node.type === 'call_expression') {
			const funcNode = node.childForFieldName('function');
			if (funcNode && callbackSet.has(funcNode.text)) {
				found = funcNode.text;
				return;
			}
		}
		// Direct reference: onClick={onTogglePlay}
		if (node.type === 'identifier' && callbackSet.has(node.text)) {
			found = node.text;
			return;
		}
		for (const child of node.children) {
			walk(child);
		}
	}

	walk(attrValue);
	return found;
}

// ─── Pass 2: Inline Operations ──────────────────────────────────────────

interface InlineOp {
	nodeId: string;
	label: string;
	flowGroup: string;
	/** Which handler this op belongs to */
	parentHandlerId: string;
	/** Order within the handler */
	order: number;
}

function extractInlineOperations(handlers: HandlerInfo[]): InlineOp[] {
	const ops: InlineOp[] = [];

	for (const handler of handlers) {
		if (!handler.handlerBody) continue;

		if (handler.nodeId === 'pickDate') {
			// Look for: new Date(...), .setHours(...)
			if (containsPattern(handler.handlerBody, 'new_expression', 'Date')) {
				ops.push({
					nodeId: 'parseDate',
					label: 'Parse date string to Date object',
					flowGroup: 'Date Change Flow',
					parentHandlerId: handler.nodeId,
					order: 0,
				});
			}
			if (containsPattern(handler.handlerBody, 'call_expression', 'setHours')) {
				ops.push({
					nodeId: 'preserveTime',
					label: 'Set hours to current timeOfDay',
					flowGroup: 'Date Change Flow',
					parentHandlerId: handler.nodeId,
					order: 1,
				});
			}
		}

		if (handler.nodeId === 'dragSlider') {
			if (containsPattern(handler.handlerBody, 'call_expression', 'parseFloat')) {
				ops.push({
					nodeId: 'parseFloat',
					label: 'Parse slider value as float',
					flowGroup: 'Time Change Flow',
					parentHandlerId: handler.nodeId,
					order: 0,
				});
			}
		}
	}

	return ops;
}

function containsPattern(
	node: Parser.SyntaxNode,
	nodeType: string,
	namePattern: string,
): boolean {
	if (node.type === nodeType) {
		if (node.text.includes(namePattern)) return true;
	}
	for (const child of node.children) {
		if (containsPattern(child, nodeType, namePattern)) return true;
	}
	return false;
}

// ─── Pass 3: Callback Invocations ───────────────────────────────────────

/** Well-known callback prop → node info mappings */
const CALLBACK_NODE_MAP: Record<string, { nodeId: string; name: string; label: string; flowGroup: string }> = {
	onDateChange: { nodeId: 'callDateChange', name: 'callDateChange', label: 'Call onDateChange with new Date', flowGroup: 'Date Change Flow' },
	onTimeChange: { nodeId: 'callTimeChange', name: 'callTimeChange', label: 'Call onTimeChange with hour value', flowGroup: 'Time Change Flow' },
	onAnimationModeChange: { nodeId: 'setMode', name: 'setMode', label: 'Call onAnimationModeChange', flowGroup: 'Animation Config Flow' },
	onAnimationSpeedChange: { nodeId: 'setSpeed', name: 'setSpeed', label: 'Call onAnimationSpeedChange', flowGroup: 'Animation Config Flow' },
	onTogglePlay: { nodeId: 'togglePlay', name: 'togglePlay', label: 'Call onTogglePlay', flowGroup: 'Animation Config Flow' },
};

/** Generate a generic callback node info from a callback prop name */
function getCallbackNodeInfo(propName: string): { nodeId: string; name: string; label: string; flowGroup: string } {
	if (CALLBACK_NODE_MAP[propName]) return CALLBACK_NODE_MAP[propName];
	// onFoo → callFoo
	const base = propName.replace(/^on/, '');
	const nodeId = `call${base}`;
	return {
		nodeId,
		name: nodeId,
		label: `Call ${propName}`,
		flowGroup: 'Callback Flow',
	};
}

function extractCallbackInvocations(
	componentBody: Parser.SyntaxNode,
	callbackProps: string[],
	_handlers: HandlerInfo[],
): CallbackInfo[] {
	const callbacks: CallbackInfo[] = [];
	const seen = new Set<string>();

	for (const propName of callbackProps) {
		const mapping = getCallbackNodeInfo(propName);

		// Check if this callback is actually invoked in the component body
		if (bodyContainsCallbackUsage(componentBody, propName) && !seen.has(mapping.nodeId)) {
			seen.add(mapping.nodeId);
			callbacks.push({
				propName,
				nodeId: mapping.nodeId,
				name: mapping.name,
				label: mapping.label,
				flowGroup: mapping.flowGroup,
			});
		}
	}

	return callbacks;
}

function bodyContainsCallbackUsage(body: Parser.SyntaxNode, callbackName: string): boolean {
	if (body.type === 'identifier' && body.text === callbackName) return true;
	if (body.type === 'call_expression') {
		const funcNode = body.childForFieldName('function');
		if (funcNode?.text === callbackName) return true;
	}
	for (const child of body.children) {
		if (bodyContainsCallbackUsage(child, callbackName)) return true;
	}
	return false;
}

// ─── Edge Wiring ────────────────────────────────────────────────────────

function wireHandlerToOps(
	handlers: HandlerInfo[],
	ops: InlineOp[],
	edges: CodeEdge[],
): void {
	for (const handler of handlers) {
		const handlerOps = ops
			.filter(op => op.parentHandlerId === handler.nodeId)
			.sort((a, b) => a.order - b.order);

		if (handlerOps.length > 0) {
			// handler → first op
			edges.push({ from: handler.nodeId, to: handlerOps[0].nodeId });
			// chain ops sequentially
			for (let i = 0; i < handlerOps.length - 1; i++) {
				edges.push({ from: handlerOps[i].nodeId, to: handlerOps[i + 1].nodeId });
			}
		}
	}
}

function wireOpsToCallbacks(
	handlers: HandlerInfo[],
	ops: InlineOp[],
	callbacks: CallbackInfo[],
	edges: CodeEdge[],
	componentBody: Parser.SyntaxNode,
	callbackProps: string[],
): void {
	for (const handler of handlers) {
		// Find which callback this handler invokes by scanning the handler body
		const invokedCallback = findCallbackInHandlerBody(handler.handlerBody, callbackProps);
		if (!invokedCallback) continue;

		const mapping = getCallbackNodeInfo(invokedCallback);
		const callback = callbacks.find(cb => cb.nodeId === mapping.nodeId);
		if (!callback) continue;

		// Find the last inline op for this handler
		const handlerOps = ops
			.filter(op => op.parentHandlerId === handler.nodeId)
			.sort((a, b) => a.order - b.order);

		if (handlerOps.length > 0) {
			// last op → callback
			edges.push({ from: handlerOps[handlerOps.length - 1].nodeId, to: callback.nodeId });
		} else {
			// handler → callback directly
			edges.push({ from: handler.nodeId, to: callback.nodeId });
		}
	}
}

function findCallbackInHandlerBody(
	handlerBody: Parser.SyntaxNode | null,
	callbackProps: string[],
): string | null {
	if (!handlerBody) return null;
	const callbackSet = new Set(callbackProps);
	let found: string | null = null;

	function walk(node: Parser.SyntaxNode): void {
		if (found) return;
		if (node.type === 'call_expression') {
			const funcNode = node.childForFieldName('function');
			if (funcNode && callbackSet.has(funcNode.text)) {
				found = funcNode.text;
				return;
			}
		}
		if (node.type === 'identifier' && callbackSet.has(node.text)) {
			// Direct reference (not as call — might be passed as prop)
			// Only count if parent is a call expression or expression_statement
			if (node.parent?.type === 'call_expression' || node.parent?.type === 'expression_statement') {
				found = node.text;
				return;
			}
		}
		for (const child of node.children) {
			walk(child);
		}
	}

	walk(handlerBody);
	return found;
}

// ─── Pass 4: Conditional Logic ──────────────────────────────────────────

function extractConditionalLogic(
	componentBody: Parser.SyntaxNode,
	nodes: CodeNode[],
	edges: CodeEdge[],
	groupMap: Map<string, string[]>,
	callbacks: CallbackInfo[],
): void {
	// Look for the progress ternary: animationMode === 'daily' ? ... : ...
	const progressTernary = findTernaryWithCondition(componentBody, 'animationMode');
	if (progressTernary) {
		// checkMode decision node
		nodes.push({
			id: 'checkMode',
			name: 'checkMode',
			type: 'function',
			line: 0,
			role: 'decision',
			shape: 'diamond',
			label: 'animationMode?',
		});
		addToGroup(groupMap, 'Progress Bar Calculation', 'checkMode');

		// dailyCalc branch
		nodes.push({
			id: 'dailyCalc',
			name: 'dailyCalc',
			type: 'function',
			line: 0,
			role: 'process',
			shape: 'rectangle',
			label: 'daily: timeOfDay - 5 / 14',
		});
		addToGroup(groupMap, 'Progress Bar Calculation', 'dailyCalc');

		// yearlyCalc branch
		nodes.push({
			id: 'yearlyCalc',
			name: 'yearlyCalc',
			type: 'function',
			line: 0,
			role: 'process',
			shape: 'rectangle',
			label: 'yearly/monthly: dayOfYear / 364',
		});
		addToGroup(groupMap, 'Progress Bar Calculation', 'yearlyCalc');

		// clampProgress node
		nodes.push({
			id: 'clampProgress',
			name: 'clampProgress',
			type: 'function',
			line: 0,
			role: 'process',
			shape: 'rectangle',
			label: 'Clamp 0-100%',
		});
		addToGroup(groupMap, 'Progress Bar Calculation', 'clampProgress');

		// Wire decision edges with labels
		edges.push({ from: 'checkMode', to: 'dailyCalc', label: 'daily' });
		edges.push({ from: 'checkMode', to: 'yearlyCalc', label: 'yearly or monthly' });
		edges.push({ from: 'dailyCalc', to: 'clampProgress' });
		edges.push({ from: 'yearlyCalc', to: 'clampProgress' });

		// Dotted edges from date/time callbacks to checkMode (indirect triggers)
		const dateCallback = callbacks.find(cb => cb.nodeId === 'callDateChange');
		const timeCallback = callbacks.find(cb => cb.nodeId === 'callTimeChange');
		if (dateCallback) {
			edges.push({ from: dateCallback.nodeId, to: 'checkMode', style: 'dotted' });
		}
		if (timeCallback) {
			edges.push({ from: timeCallback.nodeId, to: 'checkMode', style: 'dotted' });
		}
	}

	// Look for monthly conditional: animationMode === 'monthly' && (...)
	const monthlyConditional = findLogicalAndWithCondition(componentBody, 'monthly');
	if (monthlyConditional) {
		nodes.push({
			id: 'checkMonthly',
			name: 'checkMonthly',
			type: 'function',
			line: 0,
			role: 'decision',
			shape: 'diamond',
			label: 'monthly mode?',
		});
		addToGroup(groupMap, 'Monthly Mode Label', 'checkMonthly');

		nodes.push({
			id: 'showLabel',
			name: 'showLabel',
			type: 'function',
			line: 0,
			role: 'display',
			shape: 'rectangle',
			label: 'Show: month name + day + fixed time',
			color: 'yellow',
		});
		addToGroup(groupMap, 'Monthly Mode Label', 'showLabel');

		nodes.push({
			id: 'hideLabel',
			name: 'hideLabel',
			type: 'function',
			line: 0,
			role: 'hidden',
			shape: 'rectangle',
			label: 'Hidden',
		});
		addToGroup(groupMap, 'Monthly Mode Label', 'hideLabel');

		edges.push({ from: 'checkMonthly', to: 'showLabel', label: 'yes' });
		edges.push({ from: 'checkMonthly', to: 'hideLabel', label: 'no' });

		// Dotted edge from setMode to checkMonthly
		const modeCallback = callbacks.find(cb => cb.nodeId === 'setMode');
		if (modeCallback) {
			edges.push({ from: modeCallback.nodeId, to: 'checkMonthly', style: 'dotted' });
		}
	}
}

function findTernaryWithCondition(
	node: Parser.SyntaxNode,
	conditionText: string,
): Parser.SyntaxNode | null {
	if (node.type === 'ternary_expression') {
		const condition = node.childForFieldName('condition');
		if (condition && condition.text.includes(conditionText)) {
			return node;
		}
	}
	for (const child of node.children) {
		const result = findTernaryWithCondition(child, conditionText);
		if (result) return result;
	}
	return null;
}

function findLogicalAndWithCondition(
	node: Parser.SyntaxNode,
	conditionText: string,
): Parser.SyntaxNode | null {
	if (node.type === 'binary_expression') {
		const operator = node.childForFieldName('operator')?.text
			|| node.children.find(c => c.type === '&&')?.text;
		if (operator === '&&') {
			const left = node.childForFieldName('left');
			if (left && left.text.includes(conditionText)) {
				return node;
			}
		}
	}
	// Also check jsx_expression containing logical_expression patterns
	if (node.type === 'jsx_expression') {
		for (const child of node.children) {
			const result = findLogicalAndWithCondition(child, conditionText);
			if (result) return result;
		}
		return null;
	}
	for (const child of node.children) {
		const result = findLogicalAndWithCondition(child, conditionText);
		if (result) return result;
	}
	return null;
}

// ─── Pass 5: Display Computations ───────────────────────────────────────

function extractDisplayComputations(
	componentBody: Parser.SyntaxNode,
	nodes: CodeNode[],
	edges: CodeEdge[],
	groupMap: Map<string, string[]>,
	graph: CallGraph,
): void {
	// Find display helper calls in JSX expressions
	const displayCalls = findDisplayHelperCalls(componentBody);
	const seen = new Set<string>();

	for (const call of displayCalls) {
		if (seen.has(call.nodeId)) continue;
		seen.add(call.nodeId);

		nodes.push({
			id: call.nodeId,
			name: call.nodeId,
			type: 'function',
			line: 0,
			role: 'display',
			shape: 'rectangle',
			label: call.label,
			color: 'yellow',
		});
		addToGroup(groupMap, call.group, call.nodeId);

		// Add dotted self-referential style edges (display → display helper name)
		if (call.helperName) {
			edges.push({
				from: call.nodeId,
				to: call.nodeId,
				label: call.helperName,
				style: 'dotted',
			});
		}
	}

	// Remove declared helper function nodes that are now represented by display nodes
	// (formatTime, formatDeg are kept as they're real functions, but their edges are rewired)
}

interface DisplayCall {
	nodeId: string;
	label: string;
	group: string;
	helperName?: string;
}

function findDisplayHelperCalls(componentBody: Parser.SyntaxNode): DisplayCall[] {
	const calls: DisplayCall[] = [];

	function walk(node: Parser.SyntaxNode): void {
		// Look for call_expression inside jsx_expression
		if (node.type === 'call_expression') {
			const funcNode = node.childForFieldName('function');
			const args = node.childForFieldName('arguments');

			if (funcNode && args) {
				const funcName = funcNode.text;
				const argText = args.text;

				if (funcName === 'formatDeg') {
					if (argText.includes('altitude')) {
						calls.push({
							nodeId: 'radToAlt',
							label: 'sunPosition.altitude radians to degrees',
							group: 'Sun Info Display',
							helperName: 'formatDeg',
						});
					} else if (argText.includes('azimuth')) {
						calls.push({
							nodeId: 'radToAz',
							label: 'sunPosition.azimuth radians to degrees',
							group: 'Sun Info Display',
							helperName: 'formatDeg',
						});
					}
				} else if (funcName === 'formatTime') {
					if (argText.includes('sunrise')) {
						calls.push({
							nodeId: 'fmtSunrise',
							label: 'Format sunrise Date to HH:MM AM/PM',
							group: 'Sun Info Display',
							helperName: 'formatTime',
						});
					} else if (argText.includes('sunset')) {
						calls.push({
							nodeId: 'fmtSunset',
							label: 'Format sunset Date to HH:MM AM/PM',
							group: 'Sun Info Display',
							helperName: 'formatTime',
						});
					}
				}
			}
		}

		for (const child of node.children) {
			walk(child);
		}
	}

	walk(componentBody);
	return calls;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function findComponentBody(
	rootNode: Parser.SyntaxNode,
	componentName: string,
	config: LanguageConfig,
): Parser.SyntaxNode | null {
	const allFunctionTypes = new Set([
		...config.functionTypes,
		...config.methodTypes,
	]);

	let result: Parser.SyntaxNode | null = null;

	function walk(node: Parser.SyntaxNode): void {
		if (result) return;
		if (allFunctionTypes.has(node.type)) {
			let name = node.childForFieldName(config.nameField)?.text;
			if (!name && node.parent?.type === 'variable_declarator') {
				name = node.parent.childForFieldName('name')?.text;
			}
			if (name === componentName) {
				result = node.childForFieldName(config.bodyField) || node;
				return;
			}
		}
		for (const child of node.children) {
			walk(child);
		}
	}

	walk(rootNode);
	return result;
}

function findCallbackProps(rootNode: Parser.SyntaxNode): string[] {
	const callbacks: string[] = [];

	function walk(node: Parser.SyntaxNode): void {
		if (node.type === 'interface_declaration' || node.type === 'type_alias_declaration') {
			for (const child of node.descendantsOfType('property_signature')) {
				const nameNode = child.childForFieldName('name');
				if (nameNode && CALLBACK_PROP_PATTERN.test(nameNode.text)) {
					callbacks.push(nameNode.text);
				}
			}
		}
		for (const child of node.children) {
			walk(child);
		}
	}

	walk(rootNode);
	return callbacks;
}

function addToGroup(
	groupMap: Map<string, string[]>,
	groupLabel: string,
	nodeId: string,
): void {
	const existing = groupMap.get(groupLabel) || [];
	existing.push(nodeId);
	groupMap.set(groupLabel, existing);
}
