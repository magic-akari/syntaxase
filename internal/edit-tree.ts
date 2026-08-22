import { materializeLayoutEdits, type LayoutPointEdit, type LayoutRangeEdit } from "./edit-tree-renderer.ts";
import {
	generatedEditFragment,
	editFragmentText,
	type EditFragment,
	type EditFragmentPart,
	type EditFragmentLineHead,
} from "./edit-fragment.ts";
import {
	blankSourceRange,
	containsLineTerminator,
	lineAtOffset,
	localLineEnding,
	scanPhysicalLines,
	type LineTerminator,
	type SourceLayout,
} from "./source-layout.ts";

interface BlankOperation {
	readonly kind: "blank";
	readonly start: number;
	readonly end: number;
}

export type FixedSubstitution = ";" | "(" | ")";

interface SubstitutionOperation {
	readonly kind: "substitute";
	readonly start: number;
	readonly end: number;
	readonly replacement: FixedSubstitution;
}

type FixedOperation = BlankOperation | SubstitutionOperation;

interface RuntimeReplacement {
	readonly start: number;
	readonly end: number;
	readonly replacement: EditFragment;
	readonly sequence: number;
}

interface RuntimeReplacementNode extends RuntimeReplacement {
	children: RuntimeReplacementNode[];
}

interface ComposedReplacement {
	pieces: EditFragmentPart[];
	lineHeads: EditFragmentLineHead[];
}

interface ComposedReplacementBuilder {
	readonly pieces: EditFragmentPart[];
	readonly lineHeads: Array<EditFragmentLineHead | undefined>;
	length: number;
	nextLineHeadOrder: number;
}

interface OriginalOutputSpan {
	readonly sourceStart: number;
	readonly sourceEnd: number;
	readonly outputStart: number;
	readonly outputEnd: number;
}

interface SourceBoundaryOffsets {
	readonly sourceOffset: number;
	readonly start: number;
	readonly end: number;
}

interface SourceBoundaryCursor {
	index: number;
	previous?: SourceBoundaryOffsets;
}

interface MappedRuntimeChild extends OffsetRange {
	readonly node: RuntimeReplacementNode;
}

interface AppliedRuntimeChild extends OffsetRange {
	readonly cumulativeDelta: number;
}

interface FragmentPieceCursor {
	readonly pieces: readonly EditFragmentPart[];
	index: number;
	pieceOffset: number;
	outputOffset: number;
}

interface OriginalLayoutPiece {
	readonly kind: "original";
	readonly text: string;
	readonly sourceStart: number;
	readonly sourceEnd: number;
}

interface GeneratedLayoutPiece {
	readonly kind: "generated";
	readonly text: string;
}

type LayoutPiece = OriginalLayoutPiece | GeneratedLayoutPiece;

interface InsertedLine {
	readonly text: string;
	readonly lineEnding?: LineTerminator;
}

interface LineEndAppend {
	readonly offset: number;
	readonly orderOffset: number;
	readonly text: string;
	readonly sequence: number;
}

interface OffsetRange {
	start: number;
	end: number;
}

interface FallbackGroup extends OffsetRange {
	startLine: number;
	endLine: number;
	replacements: RuntimeReplacement[];
}

interface RebuiltGroup {
	text: string;
	pieces: LayoutPiece[];
	lineHeads: EditFragmentLineHead[];
	lines: SourceLayout;
	reuseSourceLines: boolean;
}

interface WholeLineGroup {
	group: FallbackGroup;
	rebuilt: RebuiltGroup;
}

interface ReusedLineGroup {
	group: FallbackGroup;
	rebuilt: RebuiltGroup;
}

interface LayoutBuffer {
	readonly lines: SourceLayout;
	readonly pointEdits: LayoutPointEdit[];
	readonly rangeEdits: LayoutRangeEdit[];
	sequence: number;
}

interface FixedEditTreeData {
	readonly source: string;
	readonly lines: SourceLayout;
	readonly fixed: FixedOperation[];
	sealed: boolean;
}

interface RuntimeEditTreeData {
	readonly source: string;
	readonly lines: SourceLayout;
	readonly fixed: readonly FixedOperation[];
	baseCode: string | null;
	readonly runtime: RuntimeReplacement[];
	readonly generatedEndLines: string[];
	sequence: number;
}

const editTreeData: unique symbol = Symbol("EditTreeData");
const editTreePhase: unique symbol = Symbol("EditTreePhase");

export type EditTreePhase = "fixed" | "runtime";

type EditTreeData<Phase extends EditTreePhase> = Phase extends "fixed" ? FixedEditTreeData : RuntimeEditTreeData;

/** A phase-owned edit builder. Sealing snapshots fixed edits into a distinct runtime tree. */
export interface EditTree<Phase extends EditTreePhase> {
	readonly [editTreeData]: EditTreeData<Phase>;
	readonly [editTreePhase]: Phase;
}

/**
 * Create the high-level state for one source transformation. Fixed-width edits
 * stay in place, safe line-end insertions are appended directly, single-line
 * runtime replacements reuse their physical source line, and structured
 * line-head groups additionally retain their source columns. Other replacements use
 * whole-line fallback.
 */
export function createEditTree(source: string, layout: SourceLayout = scanPhysicalLines(source)): EditTree<"fixed"> {
	return {
		[editTreeData]: {
			source,
			lines: layout,
			fixed: [],
			sealed: false,
		},
		[editTreePhase]: "fixed",
	};
}

export function addFixedBlank(tree: EditTree<"fixed">, start: number, end: number): void {
	const state = writableFixedEditTreeData(tree);
	assertEditRange(state.source, start, end);
	if (start === end) {
		return;
	}
	state.fixed.push({ kind: "blank", start, end });
}

export function addFixedSubstitution(tree: EditTree<"fixed">, offset: number, replacement: FixedSubstitution): void {
	const state = writableFixedEditTreeData(tree);
	assertEditRange(state.source, offset, offset + 1);
	state.fixed.push({
		kind: "substitute",
		start: offset,
		end: offset + 1,
		replacement,
	});
}

/** Seal fixed-width edits into an independently owned runtime tree. */
export function sealFixedEdits(tree: EditTree<"fixed">): EditTree<"runtime"> {
	const state = writableFixedEditTreeData(tree);
	const fixed = normalizeFixedOperations(state.fixed);
	state.sealed = true;
	return {
		[editTreeData]: {
			source: state.source,
			lines: state.lines,
			fixed,
			baseCode: null,
			runtime: [],
			generatedEndLines: [],
			sequence: 0,
		},
		[editTreePhase]: "runtime",
	};
}

export function editTreeSource(tree: EditTree<"runtime">): { source: string; baseCode: string } {
	const state = runtimeEditTreeData(tree);
	return { source: state.source, baseCode: runtimeBaseCode(state) };
}

export function addRuntimeReplacement(
	tree: EditTree<"runtime">,
	start: number,
	end: number,
	replacement: string | EditFragment,
): void {
	const state = runtimeEditTreeData(tree);
	assertEditRange(state.source, start, end);
	state.runtime.push({
		start,
		end,
		replacement: typeof replacement === "string" ? generatedEditFragment(replacement) : replacement,
		sequence: state.sequence,
	});
	state.sequence += 1;
}

export function addRuntimeInsertion(tree: EditTree<"runtime">, offset: number, text: string): void {
	addRuntimeReplacement(tree, offset, offset, text);
}

/** Append generated physical lines without shifting any existing source line. */
export function addGeneratedEndLines(tree: EditTree<"runtime">, lines: readonly string[]): void {
	runtimeEditTreeData(tree).generatedEndLines.push(...lines);
}

export function renderEditTree(tree: EditTree<"runtime">): string {
	const state = runtimeEditTreeData(tree);
	const fixed = state.fixed;
	const baseCode = state.runtime.length === 0 ? "" : runtimeBaseCode(state);
	const normalizedRuntime = normalizeRuntimeLineEndAppends(baseCode, state.lines, state.runtime);
	const groups = createFallbackGroups(state.lines, normalizedRuntime.replacements);
	const reusedLineGroups: ReusedLineGroup[] = [];
	const wholeLineGroups: WholeLineGroup[] = [];
	for (const group of groups) {
		const forest = createRuntimeReplacementForest(group.replacements);
		const flat = applyRuntimeReplacements(baseCode, group, forest, fixed);
		const rebuilt = alignEditFragmentLineHeads(flat, group, baseCode, state.lines);
		if (canReuseSourceLines(rebuilt, group)) {
			reusedLineGroups.push({ group, rebuilt });
		} else {
			wholeLineGroups.push({ group, rebuilt });
		}
	}
	const layout: LayoutBuffer = {
		lines: state.lines,
		pointEdits: [],
		rangeEdits: [],
		sequence: 0,
	};

	for (const operation of subtractGroupsFromFixed(fixed, groups)) {
		if (operation.kind === "blank") {
			addBlankLayoutEdit(layout, operation.start, operation.end);
		} else {
			addOverwriteLayoutEdit(layout, operation.start, operation.end, operation.replacement);
		}
	}

	const lineEndAppends = normalizedRuntime.appends.sort((left, right) => {
		return left.offset - right.offset || left.orderOffset - right.orderOffset || left.sequence - right.sequence;
	});
	for (const append of lineEndAppends) {
		addPointLayoutEdit(layout, "append", append.offset, append.text);
	}
	for (const { group, rebuilt } of reusedLineGroups) {
		materializeReusedLineGroup(layout, group, rebuilt);
	}

	for (const { group, rebuilt } of wholeLineGroups) {
		const insertedLines = createInsertedLines(rebuilt);
		insertLayoutLines(layout, group.startLine, insertedLines);
		addBlankLayoutEdit(layout, group.start, group.end);
	}

	const code = materializeLayoutEdits(state.source, layout.rangeEdits, layout.pointEdits);
	return appendGeneratedEndLines(code, state.lines, state.generatedEndLines);
}

function writableFixedEditTreeData(tree: EditTree<"fixed">): FixedEditTreeData {
	if (tree[editTreePhase] !== "fixed") {
		throw internalEditInvariant("a fixed edit was registered on a runtime tree");
	}
	const state = tree[editTreeData];
	if (state.sealed) {
		throw internalEditInvariant("a sealed fixed tree cannot be edited or sealed again");
	}
	return state;
}

function runtimeEditTreeData(tree: EditTree<"runtime">): RuntimeEditTreeData {
	if (tree[editTreePhase] !== "runtime") {
		throw internalEditInvariant("a runtime operation was requested from a fixed tree");
	}
	return tree[editTreeData];
}

function runtimeBaseCode(state: RuntimeEditTreeData): string {
	if (state.baseCode === null) {
		state.baseCode = applyFixedOperations(state.source, state.fixed);
	}
	return state.baseCode;
}

function assertEditRange(source: string, start: number, end: number): void {
	const isValid =
		Number.isInteger(start) && Number.isInteger(end) && 0 <= start && start <= end && end <= source.length;
	if (!isValid) {
		throw internalEditInvariant(`edit range [${start}, ${end}) is outside source length ${source.length}`);
	}
}

function internalEditInvariant(message: string): Error {
	return new Error(`Internal edit invariant: ${message}`);
}

function addBlankLayoutEdit(layout: LayoutBuffer, start: number, end: number): void {
	if (start !== end) {
		layout.rangeEdits.push({ kind: "blank", start, end });
	}
}

function addOverwriteLayoutEdit(layout: LayoutBuffer, start: number, end: number, replacement: string): void {
	if (start !== end) {
		layout.rangeEdits.push({ kind: "overwrite", start, end, replacement });
	}
}

function addPointLayoutEdit(layout: LayoutBuffer, kind: LayoutPointEdit["kind"], offset: number, text: string): void {
	if (text.length === 0) {
		return;
	}
	layout.pointEdits.push({ kind, offset, text, sequence: layout.sequence });
	layout.sequence += 1;
}

function insertLayoutLines(layout: LayoutBuffer, beforeLine: number, lines: readonly InsertedLine[]): void {
	for (const line of lines) {
		const ending = line.lineEnding ?? localLineEnding(layout.lines, beforeLine);
		const offset = layout.lines[beforeLine]!.start;
		addPointLayoutEdit(layout, "insertion", offset, line.text + ending);
	}
}

function layoutPieceText(pieces: readonly LayoutPiece[]): string {
	let text = "";
	for (const piece of pieces) {
		text += piece.text;
	}
	return text;
}

function createFallbackGroups(lines: SourceLayout, replacements: readonly RuntimeReplacement[]): FallbackGroup[] {
	const raw = replacements
		.map((replacement) => {
			const startLine = lineAtOffset(lines, replacement.start);
			const lastOffset = replacement.end > replacement.start ? replacement.end - 1 : replacement.start;
			const endLine = lineAtOffset(lines, lastOffset);
			return {
				start: lines[startLine]!.start,
				end: lines[endLine]!.contentEnd,
				startLine,
				endLine,
				replacements: [replacement],
			} satisfies FallbackGroup;
		})
		.sort((left, right) => left.start - right.start || left.end - right.end);

	const groups: FallbackGroup[] = [];
	for (const candidate of raw) {
		const previous = groups[groups.length - 1];
		if (previous === undefined || candidate.start > previous.end) {
			groups.push(candidate);
			continue;
		}

		previous.end = Math.max(previous.end, candidate.end);
		previous.endLine = Math.max(previous.endLine, candidate.endLine);
		previous.replacements.push(...candidate.replacements);
	}

	return groups;
}

function appendGeneratedEndLines(code: string, sourceLines: SourceLayout, generatedLines: readonly string[]): string {
	if (generatedLines.length === 0) {
		return code;
	}

	const finalLine = sourceLines[sourceLines.length - 1]!;
	const ending = localLineEnding(sourceLines, finalLine.index);
	const hasTrailingLineTerminator = code.length > 0 && containsLineTerminator(code.at(-1)!);
	const leadingEnding = code.length === 0 || hasTrailingLineTerminator ? "" : ending;
	const trailingEnding = hasTrailingLineTerminator ? ending : "";
	const text = `${leadingEnding}${generatedLines.join(ending)}${trailingEnding}`;
	return code + text;
}

function normalizeRuntimeLineEndAppends(
	code: string,
	lines: SourceLayout,
	replacements: readonly RuntimeReplacement[],
): { replacements: RuntimeReplacement[]; appends: LineEndAppend[] } {
	const candidates = new Map<RuntimeReplacement, { line: number; text: string }>();
	const blockingLines = new Set<number>();

	for (const replacement of replacements) {
		const candidate = lineEndAppendCandidate(code, lines, replacement);
		if (candidate !== null) {
			candidates.set(replacement, candidate);
			continue;
		}

		const startLine = lineAtOffset(lines, replacement.start);
		const lastOffset = replacement.end > replacement.start ? replacement.end - 1 : replacement.start;
		const endLine = lineAtOffset(lines, lastOffset);
		for (let line = startLine; line <= endLine; line += 1) {
			blockingLines.add(line);
		}
	}

	const retained: RuntimeReplacement[] = [];
	const appends: LineEndAppend[] = [];
	for (const replacement of replacements) {
		const candidate = candidates.get(replacement);
		if (candidate === undefined || blockingLines.has(candidate.line)) {
			retained.push(replacement);
			continue;
		}
		appends.push({
			offset: lines[candidate.line]!.contentEnd,
			orderOffset: replacement.start,
			text: candidate.text,
			sequence: replacement.sequence,
		});
	}
	return { replacements: retained, appends };
}

function lineEndAppendCandidate(
	code: string,
	lines: SourceLayout,
	replacement: RuntimeReplacement,
): { line: number; text: string } | null {
	if (
		replacement.start !== replacement.end ||
		replacement.replacement.pieces.some((piece) => piece.kind !== "generated")
	) {
		return null;
	}

	const text = editFragmentText(replacement.replacement, code);
	if (text.length === 0 || containsLineTerminator(text)) {
		return null;
	}
	const line = lineAtOffset(lines, replacement.start);
	const physicalLine = lines[line]!;
	if (replacement.start > physicalLine.contentEnd) {
		return null;
	}
	const suffix = code.slice(replacement.start, physicalLine.contentEnd);
	if (!/^\s*$/u.test(suffix)) {
		return null;
	}
	return { line, text };
}

function normalizeFixedOperations(operations: readonly FixedOperation[]): FixedOperation[] {
	const blanks = operations
		.filter((operation): operation is BlankOperation => operation.kind === "blank")
		.sort(compareRanges);
	const substitutions = operations
		.filter((operation): operation is SubstitutionOperation => operation.kind === "substitute")
		.sort(compareRanges);

	const mergedBlanks: BlankOperation[] = [];
	for (const blank of blanks) {
		const previous = mergedBlanks[mergedBlanks.length - 1];
		if (previous === undefined || blank.start > previous.end) {
			mergedBlanks.push({ ...blank });
		} else {
			mergedBlanks[mergedBlanks.length - 1] = {
				kind: "blank",
				start: previous.start,
				end: Math.max(previous.end, blank.end),
			};
		}
	}

	const uniqueSubstitutions: SubstitutionOperation[] = [];
	for (const substitution of substitutions) {
		const previous = uniqueSubstitutions[uniqueSubstitutions.length - 1];
		if (previous !== undefined && previous.start === substitution.start && previous.end === substitution.end) {
			if (previous.replacement === substitution.replacement) {
				continue;
			}
			throw internalEditInvariant(
				`Fixed substitutions at offset ${substitution.start} conflict: ${JSON.stringify(previous.replacement)} and ${JSON.stringify(substitution.replacement)}`,
			);
		}
		uniqueSubstitutions.push(substitution);
	}

	const splitBlanks: BlankOperation[] = [];
	let substitutionIndex = 0;
	for (const blank of mergedBlanks) {
		let cursor = blank.start;
		while (
			substitutionIndex < uniqueSubstitutions.length &&
			uniqueSubstitutions[substitutionIndex]!.end <= blank.start
		) {
			substitutionIndex += 1;
		}

		let index = substitutionIndex;
		while (index < uniqueSubstitutions.length) {
			const substitution = uniqueSubstitutions[index]!;
			if (substitution.start >= blank.end) {
				break;
			}
			if (substitution.start > cursor) {
				splitBlanks.push({ kind: "blank", start: cursor, end: substitution.start });
			}
			cursor = Math.max(cursor, substitution.end);
			index += 1;
		}
		if (cursor < blank.end) {
			splitBlanks.push({ kind: "blank", start: cursor, end: blank.end });
		}
	}

	return [...splitBlanks, ...uniqueSubstitutions].sort(compareRanges);
}

function applyFixedOperations(source: string, operations: readonly FixedOperation[]): string {
	const chunks: string[] = [];
	let cursor = 0;
	for (const operation of operations) {
		chunks.push(source.slice(cursor, operation.start));
		if (operation.kind === "substitute") {
			chunks.push(operation.replacement);
		} else {
			chunks.push(blankSourceRange(source, operation.start, operation.end));
		}
		cursor = operation.end;
	}
	chunks.push(source.slice(cursor));
	return chunks.join("");
}

function applyRuntimeReplacements(
	baseCode: string,
	group: FallbackGroup,
	forest: readonly RuntimeReplacementNode[],
	fixed: readonly FixedOperation[],
): RebuiltGroup {
	const chunks: string[] = [];
	const pieces: LayoutPiece[] = [];
	const lineHeads: EditFragmentLineHead[] = [];
	let outputLength = 0;
	let cursor = group.start;
	for (const replacement of forest) {
		const original = baseCode.slice(cursor, replacement.start);
		chunks.push(original);
		appendBaseProvenance(pieces, baseCode, cursor, replacement.start, fixed);
		outputLength += original.length;
		const composed = composeRuntimeReplacement(replacement);
		for (const lineHead of composed.lineHeads) {
			lineHeads.push({
				outputOffset: outputLength + lineHead.outputOffset,
				sourceOffset: lineHead.sourceOffset,
			});
		}
		for (const piece of composed.pieces) {
			if (piece.kind === "original") {
				const text = baseCode.slice(piece.sourceStart, piece.sourceEnd);
				chunks.push(text);
				outputLength += text.length;
				appendOriginalProvenance(pieces, text, piece.sourceStart, piece.sourceEnd);
			} else {
				chunks.push(piece.text);
				outputLength += piece.text.length;
				if (piece.text.length === 0) {
					continue;
				}
				pieces.push({
					kind: "generated",
					text: piece.text,
				});
			}
		}
		cursor = replacement.end;
	}
	const suffix = baseCode.slice(cursor, group.end);
	chunks.push(suffix);
	appendBaseProvenance(pieces, baseCode, cursor, group.end, fixed);
	const text = chunks.join("");
	return { text, pieces, lineHeads, lines: scanPhysicalLines(text), reuseSourceLines: false };
}

function compareRuntimeReplacements(left: RuntimeReplacement, right: RuntimeReplacement): number {
	const startOrder = left.start - right.start;
	if (startOrder !== 0) {
		return startOrder;
	}

	const leftIsInsertion = left.start === left.end;
	const rightIsInsertion = right.start === right.end;
	if (leftIsInsertion !== rightIsInsertion) {
		return leftIsInsertion ? -1 : 1;
	}
	if (!leftIsInsertion && left.end !== right.end) {
		return right.end - left.end;
	}
	return left.sequence - right.sequence;
}

/**
 * Runtime ranges stay in original UTF-16 coordinates. Non-empty ranges may be
 * disjoint or properly nested; an insertion belongs to a parent only when it
 * is strictly inside that parent, so boundary insertion ordering stays flat.
 */
function createRuntimeReplacementForest(replacements: readonly RuntimeReplacement[]): RuntimeReplacementNode[] {
	const ordered = [...replacements].sort(compareRuntimeReplacements);
	const roots: RuntimeReplacementNode[] = [];
	const ancestors: RuntimeReplacementNode[] = [];

	for (const replacement of ordered) {
		const node: RuntimeReplacementNode = { ...replacement, children: [] };
		let parent: RuntimeReplacementNode | undefined;

		while (ancestors.length > 0) {
			const candidate = ancestors[ancestors.length - 1]!;
			if (strictlyContainsRuntimeReplacement(candidate, node)) {
				parent = candidate;
				break;
			}
			if (runtimeReplacementRangesConflict(candidate, node)) {
				const candidateRange = `[${candidate.start}, ${candidate.end})`;
				const nodeRange = `[${node.start}, ${node.end})`;
				throw internalEditInvariant(
					`Runtime replacement ranges must be disjoint or properly nested: ${candidateRange} conflicts with ${nodeRange}`,
				);
			}
			ancestors.pop();
		}

		if (parent === undefined) {
			roots.push(node);
		} else {
			parent.children.push(node);
		}
		if (node.start !== node.end) {
			ancestors.push(node);
		}
	}

	return roots;
}

function strictlyContainsRuntimeReplacement(parent: RuntimeReplacement, child: RuntimeReplacement): boolean {
	if (parent.start === parent.end) {
		return false;
	}
	if (child.start === child.end) {
		return parent.start < child.start && child.start < parent.end;
	}
	const contained = parent.start <= child.start && child.end <= parent.end;
	const sameRange = parent.start === child.start && parent.end === child.end;
	return contained && !sameRange;
}

function runtimeReplacementRangesConflict(left: RuntimeReplacement, right: RuntimeReplacement): boolean {
	if (left.start === left.end || right.start === right.end) {
		return false;
	}
	const overlaps = left.start < right.end && right.start < left.end;
	return overlaps && !strictlyContainsRuntimeReplacement(left, right);
}

function composeRuntimeReplacement(node: RuntimeReplacementNode): ComposedReplacement {
	if (node.children.length === 0) {
		const pieces: EditFragmentPart[] = [];
		for (const piece of node.replacement.pieces) {
			appendComposedPiece(pieces, piece);
		}
		return { pieces, lineHeads: [...node.replacement.lineHeads] };
	}

	const builder: ComposedReplacementBuilder = {
		pieces: [],
		lineHeads: [],
		length: 0,
		nextLineHeadOrder: 0,
	};
	appendRuntimeReplacementNode(builder, node);

	const lineHeads: EditFragmentLineHead[] = [];
	for (const lineHead of builder.lineHeads) {
		if (lineHead !== undefined) {
			lineHeads.push(lineHead);
		}
	}
	return { pieces: builder.pieces, lineHeads };
}

function composedPieceLength(piece: EditFragmentPart): number {
	return piece.kind === "original" ? piece.sourceEnd - piece.sourceStart : piece.text.length;
}

function appendRuntimeReplacementNode(builder: ComposedReplacementBuilder, node: RuntimeReplacementNode): void {
	const nodeOutputStart = builder.length;
	const lineHeadOrderStart = builder.nextLineHeadOrder;
	builder.nextLineHeadOrder += node.replacement.lineHeads.length;

	if (node.children.length === 0) {
		for (const piece of node.replacement.pieces) {
			appendComposedBuilderPiece(builder, piece);
		}
		for (let index = 0; index < node.replacement.lineHeads.length; index += 1) {
			const lineHead = node.replacement.lineHeads[index]!;
			builder.lineHeads[lineHeadOrderStart + index] = {
				outputOffset: nodeOutputStart + lineHead.outputOffset,
				sourceOffset: lineHead.sourceOffset,
			};
		}
		return;
	}

	const mapped = mapRuntimeChildren(node.replacement.pieces, node.children);
	const cursor: FragmentPieceCursor = {
		pieces: node.replacement.pieces,
		index: 0,
		pieceOffset: 0,
		outputOffset: 0,
	};
	const applied: AppliedRuntimeChild[] = [];
	let cumulativeDelta = 0;
	for (const child of mapped.children) {
		advanceFragmentPieceCursor(cursor, child.start, builder);
		advanceFragmentPieceCursor(cursor, child.end);

		const childOutputStart = builder.length;
		appendRuntimeReplacementNode(builder, child.node);
		const childOutputLength = builder.length - childOutputStart;
		cumulativeDelta += childOutputLength - (child.end - child.start);
		applied.push({
			start: child.start,
			end: child.end,
			cumulativeDelta,
		});
	}
	advanceFragmentPieceCursor(cursor, mapped.outputLength, builder);
	projectRuntimeLineHeads(builder, node, nodeOutputStart, lineHeadOrderStart, applied);
}

function mapRuntimeChildren(
	pieces: readonly EditFragmentPart[],
	children: readonly RuntimeReplacementNode[],
): { children: MappedRuntimeChild[]; outputLength: number } {
	const spans: OriginalOutputSpan[] = [];
	let outputOffset = 0;
	for (const piece of pieces) {
		const outputStart = outputOffset;
		outputOffset += composedPieceLength(piece);
		if (piece.kind === "original") {
			spans.push({
				sourceStart: piece.sourceStart,
				sourceEnd: piece.sourceEnd,
				outputStart,
				outputEnd: outputOffset,
			});
		}
	}

	const cursor: SourceBoundaryCursor = { index: 0 };
	const mapped: MappedRuntimeChild[] = [];
	for (const child of children) {
		const startBoundary = sourceBoundaryOffsets(spans, cursor, child.start);
		const start = startBoundary.start;
		const end = child.start === child.end ? start : sourceBoundaryOffsets(spans, cursor, child.end).end;
		if (start > end) {
			throw internalEditInvariant(
				`Nested runtime replacement [${child.start}, ${child.end}) maps to a reversed output range [${start}, ${end})`,
			);
		}
		mapped.push({ node: child, start, end });
	}
	return { children: mapped, outputLength: outputOffset };
}

/** Resolve a required nested boundary while source offsets advance monotonically. */
function sourceBoundaryOffsets(
	spans: readonly OriginalOutputSpan[],
	cursor: SourceBoundaryCursor,
	sourceOffset: number,
): SourceBoundaryOffsets {
	if (cursor.previous?.sourceOffset === sourceOffset) {
		return cursor.previous;
	}
	while (cursor.index < spans.length && spans[cursor.index]!.sourceEnd < sourceOffset) {
		cursor.index += 1;
	}

	const candidate = spans[cursor.index];
	if (candidate !== undefined && candidate.sourceStart < sourceOffset && sourceOffset < candidate.sourceEnd) {
		const outputOffset = candidate.outputStart + sourceOffset - candidate.sourceStart;
		const result = { sourceOffset, start: outputOffset, end: outputOffset };
		cursor.previous = result;
		return result;
	}

	const left = candidate?.sourceEnd === sourceOffset ? candidate : undefined;
	let right = candidate?.sourceStart === sourceOffset ? candidate : undefined;
	if (left !== undefined) {
		const next = spans[cursor.index + 1];
		if (next?.sourceStart === sourceOffset) {
			right = next;
		}
	}
	const start = right?.outputStart ?? left?.outputEnd;
	const end = left?.outputEnd ?? right?.outputStart;
	if (start === undefined || end === undefined) {
		throw internalEditInvariant(
			`Nested runtime replacement boundary ${sourceOffset} is absent from its parent fragment`,
		);
	}

	const result = { sourceOffset, start, end };
	cursor.previous = result;
	return result;
}

function advanceFragmentPieceCursor(
	cursor: FragmentPieceCursor,
	target: number,
	builder?: ComposedReplacementBuilder,
): void {
	if (target < cursor.outputOffset) {
		throw internalEditInvariant(`Nested runtime replacements map out of order at output offset ${target}`);
	}
	while (cursor.outputOffset < target) {
		const piece = cursor.pieces[cursor.index];
		if (piece === undefined) {
			throw internalEditInvariant(`Nested runtime replacement boundary ${target} exceeds its parent fragment`);
		}
		const pieceLength = composedPieceLength(piece);
		const available = pieceLength - cursor.pieceOffset;
		const consumed = Math.min(target - cursor.outputOffset, available);
		if (builder !== undefined) {
			appendComposedBuilderPiece(builder, sliceComposedPiece(piece, cursor.pieceOffset, consumed));
		}
		cursor.pieceOffset += consumed;
		cursor.outputOffset += consumed;
		if (cursor.pieceOffset === pieceLength) {
			cursor.index += 1;
			cursor.pieceOffset = 0;
		}
	}
}

function sliceComposedPiece(piece: EditFragmentPart, relativeStart: number, length: number): EditFragmentPart {
	if (piece.kind === "generated") {
		return { kind: "generated", text: piece.text.slice(relativeStart, relativeStart + length) };
	}
	return {
		kind: "original",
		sourceStart: piece.sourceStart + relativeStart,
		sourceEnd: piece.sourceStart + relativeStart + length,
	};
}

function appendComposedBuilderPiece(builder: ComposedReplacementBuilder, piece: EditFragmentPart): void {
	appendComposedPiece(builder.pieces, piece);
	builder.length += composedPieceLength(piece);
}

function projectRuntimeLineHeads(
	builder: ComposedReplacementBuilder,
	node: RuntimeReplacementNode,
	nodeOutputStart: number,
	lineHeadOrderStart: number,
	children: readonly AppliedRuntimeChild[],
): void {
	let childIndex = 0;
	for (let index = 0; index < node.replacement.lineHeads.length; index += 1) {
		const lineHead = node.replacement.lineHeads[index]!;
		while (childIndex < children.length && children[childIndex]!.end <= lineHead.outputOffset) {
			childIndex += 1;
		}
		const activeChild = children[childIndex];
		if (
			activeChild !== undefined &&
			activeChild.start !== activeChild.end &&
			activeChild.start <= lineHead.outputOffset
		) {
			continue;
		}
		const delta = childIndex === 0 ? 0 : children[childIndex - 1]!.cumulativeDelta;
		builder.lineHeads[lineHeadOrderStart + index] = {
			outputOffset: nodeOutputStart + lineHead.outputOffset + delta,
			sourceOffset: lineHead.sourceOffset,
		};
	}
}

function appendComposedPiece(pieces: EditFragmentPart[], piece: EditFragmentPart): void {
	if (composedPieceLength(piece) === 0) {
		return;
	}
	const previous = pieces[pieces.length - 1];
	if (previous?.kind === "original" && piece.kind === "original" && previous.sourceEnd === piece.sourceStart) {
		pieces[pieces.length - 1] = { ...previous, sourceEnd: piece.sourceEnd };
		return;
	}
	if (previous?.kind === "generated" && piece.kind === "generated") {
		pieces[pieces.length - 1] = { ...previous, text: previous.text + piece.text };
		return;
	}
	pieces.push({ ...piece });
}

interface RebuiltInsertion {
	offset: number;
	text: string;
}

function alignEditFragmentLineHeads(
	rebuilt: RebuiltGroup,
	group: FallbackGroup,
	source: string,
	sourceLines: SourceLayout,
): RebuiltGroup {
	if (rebuilt.lineHeads.length === 0) {
		return rebuilt;
	}

	const lineHeads = [...rebuilt.lineHeads].sort((left, right) => left.outputOffset - right.outputOffset);
	const insertions: RebuiltInsertion[] = [];
	const outputPosition = { line: 0, column: 0 };
	let outputCursor = 0;
	let previousOutputLine: number | null = null;
	let previousSourceLine: number | null = null;
	let reuseSourceLines = true;
	const claimedSourceLines = new Set<number>();

	for (const lineHead of lineHeads) {
		advanceOutputPosition(outputPosition, rebuilt.text, outputCursor, lineHead.outputOffset);
		outputCursor = lineHead.outputOffset;
		const sourceLine = lineAtOffset(sourceLines, lineHead.sourceOffset);
		if (claimedSourceLines.has(sourceLine)) {
			continue;
		}
		claimedSourceLines.add(sourceLine);
		const sourceLineStart = sourceLines[sourceLine]!.start;
		const sourceColumn = lineHead.sourceOffset - sourceLineStart;
		const sourcePrefix = blankSourceRange(source, sourceLineStart, lineHead.sourceOffset);
		const sourceLineDelta =
			previousSourceLine === null ? sourceLine - group.startLine : sourceLine - previousSourceLine;
		const desiredOutputLine = previousOutputLine === null ? sourceLineDelta : previousOutputLine + sourceLineDelta;
		const targetOutputLine = Math.max(outputPosition.line, desiredOutputLine);
		const lineEnding = localLineEnding(sourceLines, sourceLine);
		let insertion = "";

		if (outputPosition.line < targetOutputLine) {
			for (let line = outputPosition.line; line < targetOutputLine; line += 1) {
				insertion += lineEnding;
			}
			insertion += sourcePrefix;
		} else if (outputPosition.column < sourceColumn) {
			const missingPrefixStart = sourceLineStart + outputPosition.column;
			insertion = blankSourceRange(source, missingPrefixStart, lineHead.sourceOffset);
		} else if (outputPosition.column > sourceColumn) {
			insertion = lineEnding + sourcePrefix;
		}
		previousSourceLine = sourceLine;

		if (insertion !== "") {
			insertions.push({ offset: lineHead.outputOffset, text: insertion });
			advanceOutputPosition(outputPosition, insertion, 0, insertion.length);
		}
		previousOutputLine = outputPosition.line;
		reuseSourceLines &&= outputPosition.line === sourceLine - group.startLine;
	}

	if (insertions.length === 0) {
		return { ...rebuilt, reuseSourceLines };
	}

	const pieces: LayoutPiece[] = [];
	let cursor = 0;
	for (const insertion of insertions) {
		pieces.push(...sliceProvenancePieces(rebuilt.pieces, cursor, insertion.offset));
		pieces.push({
			kind: "generated",
			text: insertion.text,
		});
		cursor = insertion.offset;
	}
	pieces.push(...sliceProvenancePieces(rebuilt.pieces, cursor, rebuilt.text.length));
	const text = insertRebuiltText(rebuilt.text, insertions);

	return { text, pieces, lineHeads: [], lines: scanPhysicalLines(text), reuseSourceLines };
}

function canReuseSourceLines(rebuilt: RebuiltGroup, group: FallbackGroup): boolean {
	const outputLineCount = rebuilt.lines.length;
	const sourceLineCount = group.endLine - group.startLine + 1;
	const isInlineReplacement = sourceLineCount === 1 && outputLineCount === 1;
	return isInlineReplacement || (rebuilt.reuseSourceLines && outputLineCount <= sourceLineCount);
}

function materializeReusedLineGroup(layout: LayoutBuffer, group: FallbackGroup, rebuilt: RebuiltGroup): void {
	const outputLines = rebuilt.lines;
	const outputLinePieces = splitProvenancePiecesByLine(rebuilt.pieces, outputLines);
	const sourceLineCount = group.endLine - group.startLine + 1;

	for (let index = 0; index < sourceLineCount; index += 1) {
		const sourceLine = group.startLine + index;
		const physicalSourceLine = layout.lines[sourceLine]!;
		const outputLine = outputLines[index];
		if (outputLine === undefined) {
			addBlankLayoutEdit(layout, physicalSourceLine.start, physicalSourceLine.contentEnd);
			continue;
		}

		const outputPieces = outputLinePieces[index]!;
		const outputWidth = outputLine.contentEnd - outputLine.start;
		const sourceWidth = physicalSourceLine.contentEnd - physicalSourceLine.start;
		if (outputWidth === 0) {
			addBlankLayoutEdit(layout, physicalSourceLine.start, physicalSourceLine.contentEnd);
			continue;
		}

		const overwriteWidth = Math.min(outputWidth, sourceWidth);
		if (sourceWidth > 0) {
			const overwritePieces = sliceProvenancePieces(outputPieces, 0, overwriteWidth);
			if (overwriteWidth < sourceWidth) {
				overwritePieces.push({
					kind: "generated",
					text: " ".repeat(sourceWidth - overwriteWidth),
				});
			}
			addOverwriteLayoutEdit(
				layout,
				physicalSourceLine.start,
				physicalSourceLine.contentEnd,
				layoutPieceText(overwritePieces),
			);
		}
		if (outputWidth > sourceWidth) {
			const appendedPieces = sliceProvenancePieces(outputPieces, sourceWidth, outputWidth);
			addPointLayoutEdit(layout, "append", physicalSourceLine.contentEnd, layoutPieceText(appendedPieces));
		}
	}
}

function advanceOutputPosition(
	position: { line: number; column: number },
	text: string,
	start: number,
	end: number,
): void {
	let cursor = start;
	while (cursor < end) {
		const character = text[cursor]!;
		if (character === "\r") {
			if (text[cursor + 1] === "\n" && cursor + 1 < end) {
				cursor += 1;
			}
			position.line += 1;
			position.column = 0;
		} else if (character === "\n" || character === "\u2028" || character === "\u2029") {
			position.line += 1;
			position.column = 0;
		} else {
			position.column += 1;
		}
		cursor += 1;
	}
}

function insertRebuiltText(text: string, insertions: readonly RebuiltInsertion[]): string {
	const chunks: string[] = [];
	let cursor = 0;
	for (const insertion of insertions) {
		chunks.push(text.slice(cursor, insertion.offset), insertion.text);
		cursor = insertion.offset;
	}
	chunks.push(text.slice(cursor));
	return chunks.join("");
}

function createInsertedLines(rebuilt: RebuiltGroup): InsertedLine[] {
	return rebuilt.lines.map((line) => {
		const text = rebuilt.text.slice(line.start, line.contentEnd);
		if (line.terminator === "") {
			return { text };
		}
		return {
			text,
			lineEnding: line.terminator,
		};
	});
}

function appendOriginalProvenance(pieces: LayoutPiece[], text: string, sourceStart: number, sourceEnd: number): void {
	if (text.length === 0) {
		return;
	}
	pieces.push({
		kind: "original",
		text,
		sourceStart,
		sourceEnd,
	});
}

function appendBaseProvenance(
	pieces: LayoutPiece[],
	baseCode: string,
	start: number,
	end: number,
	fixed: readonly FixedOperation[],
): void {
	if (start === end) {
		return;
	}

	let cursor = start;
	let operationIndex = firstOperationEndingAfter(fixed, start);
	while (operationIndex < fixed.length) {
		const operation = fixed[operationIndex]!;
		if (operation.start >= end) {
			break;
		}

		const originalEnd = Math.min(operation.start, end);
		if (cursor < originalEnd) {
			const original = baseCode.slice(cursor, originalEnd);
			appendOriginalProvenance(pieces, original, cursor, originalEnd);
			cursor = originalEnd;
		}

		const operationStart = Math.max(cursor, operation.start);
		const operationEnd = Math.min(end, operation.end);
		if (operationStart >= operationEnd) {
			operationIndex += 1;
			continue;
		}
		pieces.push({
			kind: "generated",
			text: baseCode.slice(operationStart, operationEnd),
		});
		cursor = operationEnd;
		operationIndex += 1;
	}

	if (cursor < end) {
		const original = baseCode.slice(cursor, end);
		appendOriginalProvenance(pieces, original, cursor, end);
	}
}

function firstOperationEndingAfter(operations: readonly FixedOperation[], offset: number): number {
	let low = 0;
	let high = operations.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		if (operations[middle]!.end <= offset) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
}

function sliceProvenancePieces(pieces: readonly LayoutPiece[], start: number, end: number): LayoutPiece[] {
	const result: LayoutPiece[] = [];
	let generatedOffset = 0;
	for (const piece of pieces) {
		const pieceStart = generatedOffset;
		const pieceEnd = pieceStart + piece.text.length;
		generatedOffset = pieceEnd;
		const sliceStart = Math.max(start, pieceStart);
		const sliceEnd = Math.min(end, pieceEnd);
		if (sliceStart >= sliceEnd) {
			continue;
		}
		const relativeStart = sliceStart - pieceStart;
		const relativeEnd = sliceEnd - pieceStart;
		const text = piece.text.slice(relativeStart, relativeEnd);
		if (piece.kind === "generated") {
			result.push({ ...piece, text });
		} else {
			result.push({
				kind: "original",
				text,
				sourceStart: piece.sourceStart + relativeStart,
				sourceEnd: piece.sourceStart + relativeEnd,
			});
		}
	}
	return result;
}

function splitProvenancePiecesByLine(pieces: readonly LayoutPiece[], lines: SourceLayout): LayoutPiece[][] {
	const result: LayoutPiece[][] = [];
	let firstPieceIndex = 0;
	let firstPieceStart = 0;

	for (const line of lines) {
		while (firstPieceIndex < pieces.length) {
			const piece = pieces[firstPieceIndex]!;
			const pieceEnd = firstPieceStart + piece.text.length;
			if (pieceEnd > line.start) {
				break;
			}
			firstPieceIndex += 1;
			firstPieceStart = pieceEnd;
		}

		const linePieces: LayoutPiece[] = [];
		let pieceIndex = firstPieceIndex;
		let pieceStart = firstPieceStart;
		while (pieceIndex < pieces.length && pieceStart < line.contentEnd) {
			const piece = pieces[pieceIndex]!;
			const pieceEnd = pieceStart + piece.text.length;
			const sliceStart = Math.max(line.start, pieceStart);
			const sliceEnd = Math.min(line.contentEnd, pieceEnd);
			if (sliceStart < sliceEnd) {
				appendProvenancePieceSlice(linePieces, piece, sliceStart - pieceStart, sliceEnd - pieceStart);
			}
			pieceIndex += 1;
			pieceStart = pieceEnd;
		}
		result.push(linePieces);
	}

	return result;
}

function appendProvenancePieceSlice(target: LayoutPiece[], piece: LayoutPiece, start: number, end: number): void {
	const text = piece.text.slice(start, end);
	if (piece.kind === "generated") {
		target.push({ ...piece, text });
		return;
	}
	target.push({
		kind: "original",
		text,
		sourceStart: piece.sourceStart + start,
		sourceEnd: piece.sourceStart + end,
	});
}

function subtractGroupsFromFixed(
	operations: readonly FixedOperation[],
	groups: readonly OffsetRange[],
): FixedOperation[] {
	const result: FixedOperation[] = [];
	let groupIndex = 0;
	for (const operation of operations) {
		while (groupIndex < groups.length && groups[groupIndex]!.end <= operation.start) {
			groupIndex += 1;
		}

		let cursor = operation.start;
		let index = groupIndex;
		while (index < groups.length) {
			const group = groups[index]!;
			if (group.start >= operation.end) {
				break;
			}
			if (group.start > cursor) {
				appendFixedSegment(result, operation, cursor, group.start);
			}
			cursor = Math.max(cursor, group.end);
			if (cursor >= operation.end) {
				break;
			}
			index += 1;
		}
		if (cursor < operation.end) {
			appendFixedSegment(result, operation, cursor, operation.end);
		}
	}
	return result.sort(compareRanges);
}

function appendFixedSegment(result: FixedOperation[], operation: FixedOperation, start: number, end: number): void {
	if (start >= end) {
		return;
	}
	if (operation.kind === "blank") {
		result.push({ kind: "blank", start, end });
		return;
	}
	result.push({
		kind: "substitute",
		start,
		end,
		replacement: operation.replacement,
	});
}

function compareRanges(left: OffsetRange, right: OffsetRange): number {
	return left.start - right.start || left.end - right.end;
}
