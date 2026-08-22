import type { Comment } from "@yuku-parser/wasm";

export interface SourceSpan {
	readonly start: number;
	readonly end: number;
}

interface SourceGapData {
	readonly comments: readonly Comment[];
	readonly source: string;
}

const sourceGapData: unique symbol = Symbol("SourceGapCursor");

/** Read fixed syntax from parser-bounded source gaps without materializing a token stream. */
export interface SourceGapCursor {
	readonly [sourceGapData]: SourceGapData;
}

export function createSourceGapCursor(source: string, comments: readonly Comment[]): SourceGapCursor {
	return { [sourceGapData]: { comments, source } };
}

export function findSourceText(
	cursor: SourceGapCursor,
	start: number,
	end: number,
	text: string,
	direction: "forward" | "backward" = "forward",
): SourceSpan | undefined {
	const data = cursor[sourceGapData];
	let result: SourceSpan | undefined;
	let offset = start;
	let commentIndex = commentIndexAtOrAfter(data.comments, start);
	if (commentIndex > 0 && data.comments[commentIndex - 1]!.end > start) {
		commentIndex -= 1;
	}

	while (offset + text.length <= end) {
		const comment = data.comments[commentIndex];
		if (comment !== undefined && comment.start < end) {
			if (offset >= comment.start && offset < comment.end) {
				offset = comment.end;
				commentIndex += 1;
				continue;
			}
			if (comment.end <= offset) {
				commentIndex += 1;
				continue;
			}
		}
		if (data.source.startsWith(text, offset)) {
			result = { start: offset, end: offset + text.length };
			if (direction === "forward") {
				return result;
			}
			offset += text.length;
			continue;
		}
		offset += 1;
	}
	return result;
}

/** End offset of the previous non-comment, non-whitespace source run. */
export function previousSyntaxEnd(cursor: SourceGapCursor, start: number, end: number): number | undefined {
	const data = cursor[sourceGapData];
	let offset = end;
	while (offset > start) {
		const comment = commentContaining(data.comments, offset - 1);
		if (comment !== undefined) {
			offset = comment.start;
			continue;
		}
		if (data.source[offset - 1]!.trim() === "") {
			offset -= 1;
			continue;
		}
		return offset;
	}
	return undefined;
}

function commentIndexAtOrAfter(comments: readonly Comment[], offset: number): number {
	let low = 0;
	let high = comments.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		if (comments[middle]!.start >= offset) {
			high = middle;
		} else {
			low = middle + 1;
		}
	}
	return low;
}

function commentContaining(comments: readonly Comment[], offset: number): Comment | undefined {
	const next = commentIndexAtOrAfter(comments, offset + 1);
	const comment = comments[next - 1];
	return comment !== undefined && comment.start <= offset && offset < comment.end ? comment : undefined;
}
