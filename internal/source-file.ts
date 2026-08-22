import type { Comment, Program } from "@yuku-parser/wasm";
import { createSourceGapCursor, type SourceGapCursor } from "./source-gap.ts";
import { lineTerminatorAt, scanPhysicalLines, type SourceLayout } from "./source-layout.ts";

export interface SourceFile {
	readonly text: string;
	readonly ast: Program;
	readonly comments: readonly Comment[];
	readonly gaps: SourceGapCursor;
	readonly layout: SourceLayout;
}

export function createSourceFile(text: string, ast: Program, comments: readonly Comment[]): SourceFile {
	return {
		text,
		ast,
		comments,
		gaps: createSourceGapCursor(text, comments),
		layout: scanPhysicalLines(text),
	};
}

/** Read source comments in an interval without feature-local ownership state. */
export function sourceCommentsInRange(
	sourceFile: SourceFile,
	start: number,
	end: number,
	ensureLineTermination: boolean = true,
): string {
	let result = "";
	const comments = sourceFile.comments;
	for (let index = commentIndexAtOrAfter(comments, start); index < comments.length; index += 1) {
		const comment = comments[index]!;
		if (comment.start >= end) {
			break;
		}
		if (comment.end > end) {
			continue;
		}
		result += sourceFile.text.slice(comment.start, comment.end);
		if (comment.type === "Line") {
			const terminatorEnd = ensureLineTermination ? sourceFile.text.length : end;
			const terminator = lineTerminatorAt(sourceFile.text, comment.end, terminatorEnd);
			result += terminator === "" && ensureLineTermination ? "\n" : terminator;
		}
	}
	return result;
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
