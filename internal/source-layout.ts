export type LineTerminator = "\r\n" | "\r" | "\n" | "\u2028" | "\u2029";

export interface PhysicalLine {
	/** Zero-based line number. */
	readonly index: number;
	/** UTF-16 offset of the first character on the line. */
	readonly start: number;
	/** UTF-16 offset immediately before the line terminator. */
	readonly contentEnd: number;
	/** UTF-16 offset immediately after the line terminator. */
	readonly end: number;
	readonly terminator: LineTerminator | "";
}

/** The physical-line index for one source string. */
export type SourceLayout = readonly PhysicalLine[];

function isLineTerminatorCodeUnit(character: string): character is Exclude<LineTerminator, "\r\n"> {
	return character === "\r" || character === "\n" || character === "\u2028" || character === "\u2029";
}

export function lineTerminatorAt(source: string, offset: number, end: number = source.length): LineTerminator | "" {
	if (offset >= end) {
		return "";
	}
	if (source.startsWith("\r\n", offset) && offset + 2 <= end) {
		return "\r\n";
	}

	const character = source[offset]!;
	return isLineTerminatorCodeUnit(character) ? character : "";
}

export function containsLineTerminator(source: string, start: number = 0, end: number = source.length): boolean {
	for (let offset = start; offset < end; offset += 1) {
		if (isLineTerminatorCodeUnit(source[offset]!)) {
			return true;
		}
	}
	return false;
}

/** Scan ECMAScript physical lines while retaining exact source terminators. */
export function scanPhysicalLines(source: string): SourceLayout {
	const lines: PhysicalLine[] = [];
	let lineStart = 0;
	let offset = 0;

	while (offset < source.length) {
		const terminator = lineTerminatorAt(source, offset);
		if (terminator === "") {
			offset += 1;
			continue;
		}

		const lineEnd = offset + terminator.length;
		lines.push({
			index: lines.length,
			start: lineStart,
			contentEnd: offset,
			end: lineEnd,
			terminator,
		});
		lineStart = lineEnd;
		offset = lineEnd;
	}

	lines.push({
		index: lines.length,
		start: lineStart,
		contentEnd: source.length,
		end: source.length,
		terminator: "",
	});

	return lines;
}

/** Blank a source range without changing tabs, line endings, or UTF-16 width. */
export function blankSourceRange(source: string, start: number, end: number): string {
	if (end - start >= 256) {
		return blankSourceRangeByRuns(source, start, end);
	}

	let result = "";

	for (let offset = start; offset < end; offset += 1) {
		const character = source.charAt(offset);
		const preserve = character === "\t" || isLineTerminatorCodeUnit(character);
		result += preserve ? character : " ";
	}

	return result;
}

function blankSourceRangeByRuns(source: string, start: number, end: number): string {
	const chunks: string[] = [];
	let blankStart = start;
	for (let offset = start; offset < end; offset += 1) {
		const character = source.charAt(offset);
		if (character !== "\t" && !isLineTerminatorCodeUnit(character)) {
			continue;
		}
		if (blankStart < offset) {
			chunks.push(" ".repeat(offset - blankStart));
		}
		chunks.push(character);
		blankStart = offset + 1;
	}
	if (blankStart < end) {
		chunks.push(" ".repeat(end - blankStart));
	}
	return chunks.join("");
}

export function lineAtOffset(lines: readonly PhysicalLine[], offset: number): number {
	let low = 0;
	let high = lines.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		const line = lines[middle]!;
		if (line.end <= offset && middle + 1 < lines.length) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return Math.min(low, lines.length - 1);
}

function preferredLineEnding(lines: readonly PhysicalLine[]): LineTerminator {
	for (const line of lines) {
		if (line.terminator !== "") {
			return line.terminator;
		}
	}
	return "\n";
}

export function localLineEnding(lines: readonly PhysicalLine[], line: number): LineTerminator {
	const local = lines[line]!.terminator;
	return local === "" ? preferredLineEnding(lines) : local;
}
