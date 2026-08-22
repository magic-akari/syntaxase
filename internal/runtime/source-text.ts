import { blankSourceRange } from "../source-layout.ts";

export function equalWidthVarPrefix(source: string, declarationStart: number, nameStart: number): string {
	const blankSuffix = blankSourceRange(source, declarationStart + 3, nameStart);
	return `var${blankSuffix}`;
}
