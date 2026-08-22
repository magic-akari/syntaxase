import { isNode, type AstNode, type TsEnumDeclaration, type TsEnumMember } from "../ast.ts";
import { createAstVisitor, walkAst, type NodeContext } from "../ast-walker.ts";
import { syntaxErrorAt } from "../errors.ts";
import { isIdentifierName, isStrictBindingIdentifier } from "../identifiers.ts";
import { jsStringLiteral } from "../js-string.ts";
import {
	appendGenerated,
	appendOriginal,
	appendEditFragment,
	createEditFragment,
	finishEditFragment,
	recordEditFragmentLineHead,
	type EditFragment,
} from "../edit-fragment.ts";
import {
	claimRuntimeReceiverName,
	claimSuffixedRuntimeName,
	reserveRuntimeName,
	runtimeNameIsUsed,
	type RuntimeNameAllocator,
} from "../runtime-name-allocator.ts";
import { sourceCommentsInRange, type SourceFile } from "../source-file.ts";
import { equalWidthVarPrefix } from "./source-text.ts";
import { addRuntimeReplacement, type EditTree } from "../edit-tree.ts";

export interface EnumFeatureTask {
	readonly kind: "enum";
	readonly node: TsEnumDeclaration;
}

export interface EnumLoweringContext {
	readonly baseCode: string;
	readonly edits: EditTree<"runtime">;
	readonly runtimeNames: RuntimeNameAllocator;
	readonly sourceFile: SourceFile;
}

interface EnumSyntaxNode extends AstNode {
	readonly computed?: boolean;
	readonly name?: string;
	readonly value?: unknown;
}

export function collectEnumFeature(node: TsEnumDeclaration): EnumFeatureTask | null {
	return node.declare === true ? null : { kind: "enum", node };
}

export function lowerEnum(task: EnumFeatureTask, context: EnumLoweringContext): void {
	const node = task.node;
	const emission = emitEnum(node, context.baseCode, context.sourceFile, context.runtimeNames);
	addRuntimeReplacement(context.edits, node.start, node.end, emission.replacement);
	for (const replacement of emission.identifierReplacements) {
		addRuntimeReplacement(context.edits, replacement.start, replacement.end, replacement.text);
	}
}

interface EnumIdentifierReplacement {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

interface EnumEmission {
	readonly identifierReplacements: readonly EnumIdentifierReplacement[];
	readonly replacement: EditFragment;
}

function emitEnum(
	node: TsEnumDeclaration,
	baseCode: string,
	sourceFile: SourceFile,
	runtimeNames: RuntimeNameAllocator,
): EnumEmission {
	const id = node.id;
	const enumBindingText = baseCode.slice(id.start, id.end);
	const enumName = id.name;
	const members = node.members;
	const statements = createEditFragment();
	let previousValue: string | null = null;
	const localPlan = createEnumLocalPlan(members, enumName, runtimeNames);
	const memberLocals = localPlan.memberLocals;
	const receiverName = localPlan.receiverName;
	const referenceLocals = new Map<string, string>();
	const identifierReplacements: EnumIdentifierReplacement[] = [];
	for (const [member, local] of memberLocals) {
		const referenceName = enumMemberReferenceName(member);
		if (referenceName !== null) {
			referenceLocals.set(referenceName, local);
		}
	}

	const firstMember = members[0];
	if (firstMember !== undefined) {
		appendGenerated(statements, sourceCommentsInRange(sourceFile, node.start, firstMember.start));
	} else {
		appendGenerated(statements, sourceCommentsInRange(sourceFile, node.start, node.end));
	}

	for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
		const member = members[memberIndex]!;
		recordEditFragmentLineHead(statements, member.start);
		const key = enumMemberKey(member, baseCode);
		const variableName = memberLocals.get(member) ?? null;
		const initializer = isNode(member.initializer) ? member.initializer : null;
		const nextMember = members[memberIndex + 1];
		const memberBoundary = nextMember?.start ?? node.end;

		if (initializer === null) {
			let value = previousValue === null ? "0" : `${previousValue} + 1`;
			if (variableName !== null) {
				appendGenerated(statements, `const ${variableName} = ${value};`);
				value = variableName;
			}
			appendGenerated(statements, `${receiverName}[${receiverName}[${key}]=${value}]=${key};`);
			appendGenerated(statements, sourceCommentsInRange(sourceFile, member.end, memberBoundary));
			previousValue = variableName ?? `${receiverName}[${key}]`;
			continue;
		}

		const memberId = isNode(member.id) ? member.id : null;
		const prefixStart = memberId?.end ?? member.start;
		const prefixComments = sourceCommentsInRange(sourceFile, prefixStart, initializer.start);
		const value = emitEnumRuntimeExpression(initializer, referenceLocals, identifierReplacements);
		const trailingComments = sourceCommentsInRange(sourceFile, initializer.end, memberBoundary);
		if (initializer.type === "Literal" && typeof (initializer as EnumSyntaxNode).value === "string") {
			if (variableName !== null) {
				appendGenerated(statements, `const ${variableName}=${prefixComments}`);
				appendEditFragment(statements, value);
				appendGenerated(statements, `;${receiverName}[${key}]=${variableName};`);
				previousValue = variableName;
			} else {
				appendGenerated(statements, `${receiverName}[${key}]=${prefixComments}`);
				appendEditFragment(statements, value);
				appendGenerated(statements, ";");
				previousValue = `${receiverName}[${key}]`;
			}
			appendGenerated(statements, trailingComments);
			continue;
		}

		if (variableName !== null) {
			appendGenerated(statements, `const ${variableName}=${prefixComments}`);
			appendEditFragment(statements, value);
			appendGenerated(statements, `;${receiverName}[${receiverName}[${key}]=${variableName}]=${key};`);
			previousValue = variableName;
		} else {
			appendGenerated(statements, `${receiverName}[${receiverName}[${key}]=${prefixComments}`);
			appendEditFragment(statements, value);
			appendGenerated(statements, `]=${key};`);
			previousValue = `${receiverName}[${key}]`;
		}
		appendGenerated(statements, trailingComments);
	}

	const result = createEditFragment();
	recordEditFragmentLineHead(result, node.start);
	appendGenerated(result, equalWidthVarPrefix(baseCode, node.start, id.start));
	appendOriginal(result, id.start, id.end);
	appendGenerated(result, `;(function(${receiverName}){`);
	appendEditFragment(result, finishEditFragment(statements));
	const closingBraceOffset = node.end - 1;
	recordEditFragmentLineHead(result, closingBraceOffset);
	appendGenerated(result, `})(${enumBindingText}||(${enumBindingText}={}));`);
	return { identifierReplacements, replacement: finishEditFragment(result) };
}

function enumMemberKey(member: TsEnumMember, baseCode: string): string {
	const id = member.id as EnumSyntaxNode;
	if (id.type === "Identifier") {
		return jsStringLiteral(String(id.name));
	}
	if (id.type === "Literal" && typeof id.value === "string") {
		return baseCode.slice(id.start, id.end);
	}
	throw syntaxErrorAt(member, "Enum member names must be identifiers or strings");
}

function enumMemberReferenceName(member: TsEnumMember): string | null {
	const id = member.id as EnumSyntaxNode;
	const name = id.type === "Identifier" ? String(id.name) : typeof id.value === "string" ? id.value : "";
	return isIdentifierName(name) ? name : null;
}

interface EnumLocalPlan {
	readonly memberLocals: ReadonlyMap<TsEnumMember, string>;
	readonly receiverName: string;
}

interface EnumNameClaimState {
	readonly enumName: string;
	readonly memberNaturalNames: ReadonlySet<string>;
	readonly runtimeNames: RuntimeNameAllocator;
}

function createEnumLocalPlan(
	members: readonly TsEnumMember[],
	enumName: string,
	runtimeNames: RuntimeNameAllocator,
): EnumLocalPlan {
	const memberNaturalNames = collectEnumMemberNaturalNames(members);
	const claimState: EnumNameClaimState = { enumName, memberNaturalNames, runtimeNames };
	const receiverName = claimEnumReceiverName(claimState);
	const memberLocals = createEnumMemberLocals(members, claimState);
	return { memberLocals, receiverName };
}

function collectEnumMemberNaturalNames(members: readonly TsEnumMember[]): Set<string> {
	const names = new Set<string>();
	for (const member of members) {
		const name = enumMemberReferenceName(member);
		if (name !== null) {
			names.add(name);
		}
	}
	return names;
}

function claimEnumReceiverName(state: EnumNameClaimState): string {
	return claimRuntimeReceiverName(state.runtimeNames, state.enumName, (name) => state.memberNaturalNames.has(name));
}

function createEnumMemberLocals(
	members: readonly TsEnumMember[],
	claimState: EnumNameClaimState,
): Map<TsEnumMember, string> {
	const result = new Map<TsEnumMember, string>();
	const assignedNaturalNames = new Set<string>();
	for (const member of members) {
		const referenceName = enumMemberReferenceName(member);
		if (referenceName === null) {
			continue;
		}
		const duplicate = assignedNaturalNames.has(referenceName);
		assignedNaturalNames.add(referenceName);
		let local = referenceName;
		if (!isStrictBindingIdentifier(referenceName) || duplicate) {
			local = claimEnumMemberAlias(claimState, referenceName);
		}
		result.set(member, local);
	}
	return result;
}

function claimEnumMemberAlias(state: EnumNameClaimState, memberName: string): string {
	const aliasBase = `_${memberName}`;
	const conflictsWithMember = state.memberNaturalNames.has(aliasBase);
	const conflictsWithRuntimeName = runtimeNameIsUsed(state.runtimeNames, aliasBase);
	if (!conflictsWithMember && !conflictsWithRuntimeName) {
		reserveRuntimeName(state.runtimeNames, aliasBase);
		return aliasBase;
	}
	return claimSuffixedRuntimeName(state.runtimeNames, aliasBase, 1, (name) => state.memberNaturalNames.has(name));
}

interface EnumExpressionWalkState {
	readonly referenceLocals: ReadonlyMap<string, string>;
	readonly replacements: EnumIdentifierReplacement[];
}

function emitEnumRuntimeExpression(
	node: AstNode,
	referenceLocals: ReadonlyMap<string, string>,
	replacements: EnumIdentifierReplacement[],
): EditFragment {
	const state: EnumExpressionWalkState = { referenceLocals, replacements };
	walkAst(node, [createAstVisitor(state, collectEnumExpressionReplacement)]);
	return originalExpression(node);
}

function collectEnumExpressionReplacement(
	candidate: EnumSyntaxNode,
	context: NodeContext,
	state: EnumExpressionWalkState,
): boolean | void {
	if (
		candidate.type !== "Identifier" ||
		typeof candidate.name !== "string" ||
		!isRuntimeIdentifierReference(candidate, context.parent, context.key)
	) {
		return;
	}
	const local = state.referenceLocals.get(candidate.name);
	if (local !== undefined && local !== candidate.name) {
		state.replacements.push({ start: candidate.start, end: candidate.end, text: local });
	}
}

function isRuntimeIdentifierReference(node: AstNode, parent: AstNode | null, key: string | null): boolean {
	if (parent === null) {
		return true;
	}
	if (
		(parent.type === "MemberExpression" && key === "property" && (parent as EnumSyntaxNode).computed !== true) ||
		((parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") &&
			key === "key" &&
			(parent as EnumSyntaxNode).computed !== true) ||
		parent.type === "LabeledStatement" ||
		parent.type === "BreakStatement" ||
		parent.type === "ContinueStatement"
	) {
		return false;
	}
	if (
		(parent.type === "VariableDeclarator" && key === "id") ||
		((parent.type === "FunctionExpression" || parent.type === "ArrowFunctionExpression") &&
			(key === "id" || key === "params"))
	) {
		return false;
	}
	return node.type === "Identifier";
}

function originalExpression(node: AstNode): EditFragment {
	const result = createEditFragment();
	appendOriginal(result, node.start, node.end);
	return finishEditFragment(result);
}
