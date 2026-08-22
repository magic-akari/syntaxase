export function isIntrinsicJsxName(name: string): boolean {
	const first = name.codePointAt(0);
	const startsWithAsciiLowercase = first !== undefined && first >= 97 && first <= 122;
	return startsWithAsciiLowercase || name.includes("-");
}
