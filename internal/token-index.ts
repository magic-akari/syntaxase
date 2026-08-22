import type { AstNode, SyntaxToken } from "./ast.ts";

interface TokenIndexData {
	readonly source: string;
	readonly tokens: readonly SyntaxToken[];
}

const tokenIndexData: unique symbol = Symbol("TokenIndexState");

/** An opaque, read-only index over the tokens for one source string. */
export interface TokenIndexState {
	readonly [tokenIndexData]: TokenIndexData;
}

export function createTokenIndex(source: string, tokens: readonly SyntaxToken[]): TokenIndexState {
	return {
		[tokenIndexData]: { source, tokens },
	};
}

function indexAtOrAfter(index: TokenIndexState, offset: number): number {
	const tokens = index[tokenIndexData].tokens;
	let low = 0;
	let high = tokens.length;

	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		const token = tokens[middle]!;
		if (token.start >= offset) {
			high = middle;
		} else {
			low = middle + 1;
		}
	}

	return low;
}

export function firstTokenAtOrAfter(index: TokenIndexState, offset: number): SyntaxToken | undefined {
	const tokens = index[tokenIndexData].tokens;
	return tokens[indexAtOrAfter(index, offset)];
}

export function lastTokenBefore(index: TokenIndexState, offset: number): SyntaxToken | undefined {
	const tokens = index[tokenIndexData].tokens;
	return tokens[indexAtOrAfter(index, offset) - 1];
}

export function findTokenByText(
	index: TokenIndexState,
	start: number,
	end: number,
	text: string,
): SyntaxToken | undefined {
	const tokens = index[tokenIndexData].tokens;
	for (let tokenIndex = indexAtOrAfter(index, start); tokenIndex < tokens.length; tokenIndex += 1) {
		const token = tokens[tokenIndex]!;
		if (token.start >= end) {
			break;
		}
		if (token.end > end) {
			continue;
		}
		if (tokenText(index, token) === text) {
			return token;
		}
	}

	return undefined;
}

export function findTokenByLabel(
	index: TokenIndexState,
	start: number,
	end: number,
	label: string,
): SyntaxToken | undefined {
	const tokens = index[tokenIndexData].tokens;
	for (let tokenIndex = indexAtOrAfter(index, start); tokenIndex < tokens.length; tokenIndex += 1) {
		const token = tokens[tokenIndex]!;
		if (token.start >= end) {
			break;
		}
		if (token.end > end) {
			continue;
		}
		if (token.type.label === label) {
			return token;
		}
	}

	return undefined;
}

export function requireTokenByText(index: TokenIndexState, start: number, end: number, text: string): SyntaxToken {
	const token = findTokenByText(index, start, end, text);
	if (token === undefined) {
		throw missingToken(text, start, end);
	}
	return token;
}

export function requireTokenByLabel(index: TokenIndexState, start: number, end: number, label: string): SyntaxToken {
	const token = findTokenByLabel(index, start, end, label);
	if (token === undefined) {
		throw missingToken(label, start, end);
	}
	return token;
}

export function requireLastTokenByText(index: TokenIndexState, start: number, end: number, text: string): SyntaxToken {
	const tokens = index[tokenIndexData].tokens;
	for (let tokenIndex = indexAtOrAfter(index, end) - 1; tokenIndex >= 0; tokenIndex -= 1) {
		const token = tokens[tokenIndex]!;
		if (token.start < start) {
			break;
		}
		if (token.end <= end && tokenText(index, token) === text) {
			return token;
		}
	}
	throw missingToken(text, start, end);
}

export function requireLastTokenByLabel(
	index: TokenIndexState,
	start: number,
	end: number,
	label: string,
): SyntaxToken {
	const tokens = index[tokenIndexData].tokens;
	for (let tokenIndex = indexAtOrAfter(index, end) - 1; tokenIndex >= 0; tokenIndex -= 1) {
		const token = tokens[tokenIndex]!;
		if (token.start < start) {
			break;
		}
		if (token.end <= end && token.type.label === label) {
			return token;
		}
	}
	throw missingToken(label, start, end);
}

export function requireLastTokenInRange(index: TokenIndexState, start: number, end: number): SyntaxToken {
	const token = lastTokenBefore(index, end);
	if (token === undefined || token.start < start || token.end > end) {
		throw missingToken("syntax token", start, end);
	}
	return token;
}

export function requireTokenAtOrAfterByLabel(index: TokenIndexState, offset: number, label: string): SyntaxToken {
	const token = firstTokenAtOrAfter(index, offset);
	if (token === undefined || token.type.label !== label) {
		throw missingToken(label, offset, offset);
	}
	return token;
}

export function tokenNameEnd(index: TokenIndexState, node: AstNode): number {
	const token = firstTokenAtOrAfter(index, node.start);
	if (token === undefined) {
		throw missingToken("identifier", node.start, node.end);
	}
	return token.end;
}

export function tokenText(index: TokenIndexState, token: SyntaxToken): string {
	const source = index[tokenIndexData].source;
	return source.slice(token.start, token.end);
}

function missingToken(expected: string, start: number, end: number): Error {
	return new Error(`Internal parser invariant: expected ${JSON.stringify(expected)} in [${start}, ${end})`);
}
