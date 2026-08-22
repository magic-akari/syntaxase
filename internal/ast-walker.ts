import type { AstNode } from "./ast.ts";

export interface NodeContext {
	readonly parent: AstNode | null;
	readonly key: string | null;
	readonly index: number | null;
	/** Ephemeral during a walk. Snapshot before retaining the context. */
	readonly ancestors: readonly AstNode[];
}

export interface AstVisitor {
	enter(node: AstNode, context: NodeContext): boolean | void;
}

export type AstVisitorFunction<State, Node extends AstNode = AstNode> = (
	node: Node,
	context: NodeContext,
	state: State,
) => boolean | void;

interface WalkState {
	readonly ancestors: AstNode[];
	readonly visitors: readonly AstVisitor[];
}

export function createAstVisitor<State, Node extends AstNode = AstNode>(
	state: State,
	enter: AstVisitorFunction<State, Node>,
): AstVisitor {
	return {
		enter(node, context) {
			return enter(node as Node, context, state);
		},
	};
}

/** Walk parser-owned node relationships once, with an independent pruning bit per visitor. */
export function walkAst(root: AstNode, visitors: readonly AstVisitor[]): void {
	if (visitors.length === 0) {
		return;
	}
	if (visitors.length > 30) {
		throw new RangeError("Internal AST invariant: walks support at most 30 simultaneous visitors");
	}
	const state: WalkState = { ancestors: [], visitors };
	const visitorMask = (1 << visitors.length) - 1;
	visitAst(root, { parent: null, key: null, index: null, ancestors: state.ancestors }, visitorMask, state);
}

export function snapshotNodeContext(context: NodeContext): NodeContext {
	return {
		parent: context.parent,
		key: context.key,
		index: context.index,
		ancestors: [...context.ancestors],
	};
}

function visitAst(node: AstNode, context: NodeContext, visitorMask: number, state: WalkState): void {
	let descendantMask = visitorMask;
	for (let visitorIndex = 0; visitorIndex < state.visitors.length; visitorIndex += 1) {
		const visitorBit = 1 << visitorIndex;
		if ((visitorMask & visitorBit) === 0) {
			continue;
		}
		if (state.visitors[visitorIndex]!.enter(node, context) === false) {
			descendantMask &= ~visitorBit;
		}
	}

	if (descendantMask !== 0) {
		state.ancestors.push(node);
		visitChildren(node, descendantMask, state);
		state.ancestors.pop();
	}
}

/** Parser AST nodes are acyclic plain objects whose syntax children are enumerable node-shaped values. */
function visitChildren(node: AstNode, visitorMask: number, state: WalkState): void {
	const fields = node as unknown as Record<string, unknown>;
	for (const key in fields) {
		const value = fields[key];
		if (value === null || typeof value !== "object") {
			continue;
		}
		if (!Array.isArray(value)) {
			if (typeof (value as { type?: unknown }).type === "string") {
				visitAst(
					value as AstNode,
					{ parent: node, key, index: null, ancestors: state.ancestors },
					visitorMask,
					state,
				);
			}
			continue;
		}
		for (let index = 0; index < value.length; index += 1) {
			const child = value[index];
			if (child !== null && typeof child === "object" && typeof (child as { type?: unknown }).type === "string") {
				visitAst(
					child as AstNode,
					{ parent: node, key, index, ancestors: state.ancestors },
					visitorMask,
					state,
				);
			}
		}
	}
}
