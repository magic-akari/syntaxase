/** A slice copied from the position-preserving intermediate source. */
export interface OriginalEditFragmentPart {
	readonly kind: "original";
	readonly sourceStart: number;
	readonly sourceEnd: number;
}

/** Text synthesized by a runtime lowering. */
export interface GeneratedEditFragmentPart {
	readonly kind: "generated";
	readonly text: string;
}

export type EditFragmentPart = OriginalEditFragmentPart | GeneratedEditFragmentPart;

/** The first generated fragment that begins on one original physical line, recorded in output order. */
export interface EditFragmentLineHead {
	readonly outputOffset: number;
	readonly sourceOffset: number;
}

declare const editFragmentBrand: unique symbol;

/** A nested fragment in the EditTree. */
export interface EditFragment {
	readonly [editFragmentBrand]: true;
	readonly pieces: readonly EditFragmentPart[];
	readonly lineHeads: readonly EditFragmentLineHead[];
}

interface MutableOriginalEditFragmentPart {
	kind: "original";
	sourceStart: number;
	sourceEnd: number;
}

interface MutableGeneratedEditFragmentPart {
	kind: "generated";
	text: string;
}

type MutableEditFragmentPart = MutableOriginalEditFragmentPart | MutableGeneratedEditFragmentPart;

interface EditFragmentData {
	readonly pieces: MutableEditFragmentPart[];
	readonly lineHeads: EditFragmentLineHead[];
	length: number;
}

const editFragmentData: unique symbol = Symbol("EditFragmentBuilder");

/** Opaque mutable state for constructing one structured replacement. */
export interface EditFragmentBuilder {
	readonly [editFragmentData]: EditFragmentData;
}

/**
 * Starts a replacement without recovering provenance through a text diff.
 * Original content is represented only by spans in the position-preserving
 * intermediate source.
 */
export function createEditFragment(): EditFragmentBuilder {
	return {
		[editFragmentData]: {
			pieces: [],
			lineHeads: [],
			length: 0,
		},
	};
}

export function appendGenerated(state: EditFragmentBuilder, text: string): void {
	if (text.length === 0) {
		return;
	}

	const data = state[editFragmentData];
	const previous = data.pieces[data.pieces.length - 1];
	if (previous?.kind === "generated") {
		previous.text += text;
	} else {
		data.pieces.push({ kind: "generated", text });
	}
	data.length += text.length;
}

export function appendOriginal(state: EditFragmentBuilder, sourceStart: number, sourceEnd: number): void {
	if (sourceStart === sourceEnd) {
		return;
	}

	const data = state[editFragmentData];
	const previous = data.pieces[data.pieces.length - 1];
	if (previous?.kind === "original" && previous.sourceEnd === sourceStart) {
		previous.sourceEnd = sourceEnd;
	} else {
		data.pieces.push({
			kind: "original",
			sourceStart,
			sourceEnd,
		});
	}
	data.length += sourceEnd - sourceStart;
}

export function recordEditFragmentLineHead(state: EditFragmentBuilder, sourceOffset: number): void {
	const data = state[editFragmentData];
	data.lineHeads.push({
		outputOffset: data.length,
		sourceOffset,
	});
}

export function appendEditFragment(state: EditFragmentBuilder, content: EditFragment): void {
	const data = state[editFragmentData];
	const outputOffset = data.length;

	for (const piece of content.pieces) {
		if (piece.kind === "generated") {
			appendGenerated(state, piece.text);
			continue;
		}

		appendOriginal(state, piece.sourceStart, piece.sourceEnd);
	}

	for (const lineHead of content.lineHeads) {
		data.lineHeads.push({
			outputOffset: outputOffset + lineHead.outputOffset,
			sourceOffset: lineHead.sourceOffset,
		});
	}
}

/** Returns a detached snapshot of the replacement built so far. */
export function finishEditFragment(state: EditFragmentBuilder): EditFragment {
	const data = state[editFragmentData];
	const pieces: EditFragmentPart[] = [];
	const lineHeads: EditFragmentLineHead[] = [];

	for (const piece of data.pieces) {
		pieces.push({ ...piece });
	}
	for (const lineHead of data.lineHeads) {
		lineHeads.push({ ...lineHead });
	}

	return { pieces, lineHeads } as unknown as EditFragment;
}

export function generatedEditFragment(text: string): EditFragment {
	if (text.length === 0) {
		return { pieces: [], lineHeads: [] } as unknown as EditFragment;
	}
	return { pieces: [{ kind: "generated", text }], lineHeads: [] } as unknown as EditFragment;
}

export function editFragmentText(content: EditFragment, source: string): string {
	let text = "";
	for (const piece of content.pieces) {
		text += piece.kind === "original" ? source.slice(piece.sourceStart, piece.sourceEnd) : piece.text;
	}
	return text;
}
