/** JSX lowering strategy used by every Syntaxase JavaScript package. */
export type JSXRuntime = "automatic" | "classic" | "preserve";

export type JSXConfig =
	| {
			runtime?: "automatic";
			development?: boolean;
			importSource?: string;
			pragma?: never;
			pragmaFrag?: never;
	  }
	| {
			runtime: "classic";
			development?: never;
			importSource?: never;
			pragma?: string;
			pragmaFrag?: string;
	  }
	| {
			runtime: "preserve";
			development?: never;
			importSource?: never;
			pragma?: never;
			pragmaFrag?: never;
	  };

export interface TransformOptions {
	jsx?: boolean | JSXConfig;
}

export interface StripTypesOptions {
	lang?: "ts" | "tsx";
}

/** Transform erasable TypeScript and supported runtime TypeScript/JSX syntax to JavaScript. */
export function transform(sourceText: string, options?: TransformOptions): string;

/** Erase only fixed-width TypeScript syntax while preserving source length and line layout. */
export function stripTypes(sourceText: string, options?: StripTypesOptions): string;
