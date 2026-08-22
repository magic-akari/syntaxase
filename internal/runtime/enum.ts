import type { Expression, Identifier, Node, TSEnumDeclaration, TSEnumMember } from "@yuku-parser/wasm";
import { walk, type WalkContext } from "yuku-ast";
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
	readonly node: TSEnumDeclaration;
}

export interface EnumLoweringContext {
	readonly baseCode: string;
	readonly edits: EditTree<"runtime">;
	readonly runtimeNames: RuntimeNameAllocator;
	readonly sourceFile: SourceFile;
}

export function collectEnumFeature(node: TSEnumDeclaration): EnumFeatureTask | null {
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
	node: TSEnumDeclaration,
	baseCode: string,
	sourceFile: SourceFile,
	runtimeNames: RuntimeNameAllocator,
): EnumEmission {
	const id = node.id;
	const enumBindingText = baseCode.slice(id.start, id.end);
	const enumName = id.name;
	const members = node.body.members;
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
		const initializer = member.initializer;
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

		const prefixStart = member.id.end;
		const prefixComments = sourceCommentsInRange(sourceFile, prefixStart, initializer.start);
		const value = emitEnumRuntimeExpression(initializer, referenceLocals, identifierReplacements);
		const trailingComments = sourceCommentsInRange(sourceFile, initializer.end, memberBoundary);
		if (initializer.type === "Literal" && typeof initializer.value === "string") {
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

function enumMemberKey(member: TSEnumMember, baseCode: string): string {
	const id = member.id;
	if (id.type === "Identifier") {
		return jsStringLiteral(id.name);
	}
	if (id.type === "Literal" && typeof id.value === "string") {
		return baseCode.slice(id.start, id.end);
	}
	throw syntaxErrorAt(member, "Enum member names must be identifiers or strings");
}

function enumMemberReferenceName(member: TSEnumMember): string | null {
	const id = member.id;
	const name = id.type === "Identifier" ? id.name : id.type === "Literal" ? id.value : "";
	return isIdentifierName(name) ? name : null;
}

interface EnumLocalPlan {
	readonly memberLocals: ReadonlyMap<TSEnumMember, string>;
	readonly receiverName: string;
}

interface EnumNameClaimState {
	readonly enumName: string;
	readonly memberNaturalNames: ReadonlySet<string>;
	readonly runtimeNames: RuntimeNameAllocator;
}

function createEnumLocalPlan(
	members: readonly TSEnumMember[],
	enumName: string,
	runtimeNames: RuntimeNameAllocator,
): EnumLocalPlan {
	const memberNaturalNames = collectEnumMemberNaturalNames(members);
	const claimState: EnumNameClaimState = { enumName, memberNaturalNames, runtimeNames };
	const receiverName = claimEnumReceiverName(claimState);
	const memberLocals = createEnumMemberLocals(members, claimState);
	return { memberLocals, receiverName };
}

function collectEnumMemberNaturalNames(members: readonly TSEnumMember[]): Set<string> {
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
	members: readonly TSEnumMember[],
	claimState: EnumNameClaimState,
): Map<TSEnumMember, string> {
	const result = new Map<TSEnumMember, string>();
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
	node: Expression,
	referenceLocals: ReadonlyMap<string, string>,
	replacements: EnumIdentifierReplacement[],
): EditFragment {
	const state: EnumExpressionWalkState = { referenceLocals, replacements };
	walk(node, {
		Identifier(candidate, walkContext) {
			collectEnumExpressionReplacement(candidate, walkContext, state);
		},
	});
	return originalExpression(node);
}

function collectEnumExpressionReplacement(
	candidate: Identifier,
	context: WalkContext<Identifier>,
	state: EnumExpressionWalkState,
): boolean | void {
	if (!isRuntimeIdentifierReference(candidate, context.parent, context.key)) {
		return;
	}
	const local = state.referenceLocals.get(candidate.name);
	if (local !== undefined && local !== candidate.name) {
		state.replacements.push({ start: candidate.start, end: candidate.end, text: local });
	}
}

function isRuntimeIdentifierReference(_node: Identifier, parent: Node | null, key: string | null): boolean {
	if (parent === null) {
		return true;
	}
	if (
		(parent.type === "MemberExpression" && key === "property" && parent.computed !== true) ||
		((parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") &&
			key === "key" &&
			parent.computed !== true) ||
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
	return true;
}

function originalExpression(node: Node): EditFragment {
	const result = createEditFragment();
	appendOriginal(result, node.start, node.end);
	return finishEditFragment(result);
}
