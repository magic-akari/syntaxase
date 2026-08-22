import { blankSourceRange } from "./source-layout.ts";

export interface BlankLayoutEdit {
	readonly kind: "blank";
	readonly start: number;
	readonly end: number;
}

export interface OverwriteLayoutEdit {
	readonly kind: "overwrite";
	readonly start: number;
	readonly end: number;
	readonly replacement: string;
}

export type LayoutRangeEdit = BlankLayoutEdit | OverwriteLayoutEdit;

export interface LayoutPointEdit {
	readonly kind: "insertion" | "append";
	readonly offset: number;
	readonly sequence: number;
	readonly text: string;
}

function compareRangeEdits(left: LayoutRangeEdit, right: LayoutRangeEdit): number {
	return left.start - right.start || left.end - right.end;
}

function comparePointEdits(left: LayoutPointEdit, right: LayoutPointEdit): number {
	if (left.offset !== right.offset) {
		return left.offset - right.offset;
	}
	if (left.kind !== right.kind) {
		return left.kind === "insertion" ? -1 : 1;
	}
	return left.sequence - right.sequence;
}

function transformedRangeSlice(source: string, edit: LayoutRangeEdit, start: number, end: number): string {
	if (edit.kind === "blank") {
		return blankSourceRange(source, start, end);
	}
	const replacementStart = start - edit.start;
	const replacementEnd = end - edit.start;
	return edit.replacement.slice(replacementStart, replacementEnd);
}

/** Materialize trusted, normalized layout edits in one linear source pass. */
export function materializeLayoutEdits(
	source: string,
	rangeEdits: readonly LayoutRangeEdit[],
	pointEdits: readonly LayoutPointEdit[],
): string {
	const ranges = [...rangeEdits].sort(compareRangeEdits);
	const points = [...pointEdits].sort(comparePointEdits);
	const chunks: string[] = [];
	let cursor = 0;
	let rangeIndex = 0;
	let pointIndex = 0;
	let activeRange: LayoutRangeEdit | undefined;

	while (true) {
		while (points[pointIndex]?.offset === cursor) {
			chunks.push(points[pointIndex]!.text);
			pointIndex += 1;
		}

		if (cursor === source.length) {
			break;
		}

		if (activeRange !== undefined && cursor === activeRange.end) {
			activeRange = undefined;
			rangeIndex += 1;
		}

		const nextRange = ranges[rangeIndex];
		if (activeRange === undefined && nextRange?.start === cursor) {
			activeRange = nextRange;
		}

		let boundary = source.length;
		if (activeRange !== undefined) {
			boundary = activeRange.end;
		} else if (nextRange !== undefined) {
			boundary = nextRange.start;
		}

		const nextPoint = points[pointIndex];
		if (nextPoint !== undefined && nextPoint.offset < boundary) {
			boundary = nextPoint.offset;
		}

		if (activeRange === undefined) {
			chunks.push(source.slice(cursor, boundary));
		} else {
			chunks.push(transformedRangeSlice(source, activeRange, cursor, boundary));
		}
		cursor = boundary;
	}

	return chunks.join("");
}
