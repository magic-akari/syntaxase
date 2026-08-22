import type { SourceLocation } from "acorn";

/** Shared parser-node identity. Feature modules own the structural views they consume. */
export interface AstNode {
	readonly type: string;
	readonly start: number;
	readonly end: number;
	readonly loc?: SourceLocation | null;
}

export interface AstProgram extends AstNode {
	readonly type: "Program";
}

export interface IdentifierNode extends AstNode {
	readonly type: "Identifier";
	readonly name: string;
}

export interface TsEnumDeclaration extends AstNode {
	readonly type: "TSEnumDeclaration";
	readonly declare?: boolean;
	readonly id: IdentifierNode;
	readonly members: readonly TsEnumMember[];
}

export interface TsEnumMember extends AstNode {
	readonly type: "TSEnumMember";
	readonly id: AstNode;
	readonly initializer?: AstNode | null;
}

export interface TsModuleDeclaration extends AstNode {
	readonly type: "TSModuleDeclaration";
	readonly id: AstNode;
	readonly body: AstNode;
}

export interface TsImportEqualsDeclaration extends AstNode {
	readonly type: "TSImportEqualsDeclaration";
	readonly id: IdentifierNode;
	readonly importKind?: "type" | "value";
	readonly isExport?: boolean;
	readonly isTypeOnly?: boolean;
	readonly moduleReference: AstNode;
}

export interface TsParameterProperty extends AstNode {
	readonly type: "TSParameterProperty";
	readonly parameter: AstNode;
}

export interface ClassBodyNode extends AstNode {
	readonly type: "ClassBody";
	readonly body: readonly AstNode[];
}

export interface FunctionLikeNode extends AstNode {
	readonly body: AstNode | null;
	readonly params: readonly AstNode[];
}

export interface MethodDefinitionNode extends AstNode {
	readonly type: "MethodDefinition";
	readonly kind: string;
	readonly value: FunctionLikeNode;
}

export interface ExportDeclarationNode extends AstNode {
	readonly type: "ExportAllDeclaration" | "ExportDefaultDeclaration" | "ExportNamedDeclaration";
	readonly declaration?: AstNode | null;
	readonly exportKind?: "type" | "value";
}

export interface SyntaxToken {
	readonly type: {
		readonly label: string;
	};
	readonly start: number;
	readonly end: number;
}

export interface SyntaxComment {
	readonly type: "Line" | "Block";
	readonly start: number;
	readonly end: number;
}

export function isNode(value: unknown): value is AstNode {
	if (value === null || typeof value !== "object") {
		return false;
	}

	const candidate = value as Partial<AstNode>;
	return (
		typeof candidate.type === "string" && typeof candidate.start === "number" && typeof candidate.end === "number"
	);
}
