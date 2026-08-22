import path from "node:path";
import { fileURLToPath } from "node:url";

const BENCHMARK_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export const CACHE_DIRECTORY = path.join(BENCHMARK_DIRECTORY, ".cache");

export const BENCHMARK_CORPUS = [
	{
		id: "hono-types",
		label: "Hono types.ts",
		operation: "stripTypes",
		jsx: false,
		repository: "https://github.com/honojs/hono",
		revision: "971106d132ec8a989be12ec5c8e63cfaf597cd4f",
		upstreamPath: "src/types.ts",
		license: "MIT",
		url: "https://raw.githubusercontent.com/honojs/hono/971106d132ec8a989be12ec5c8e63cfaf597cd4f/src/types.ts",
		bytes: 77_937,
		sha256: "ce5a6ed84c07e54329c14709426f908aec4d94fb535c2b1a59f08128e69afb2e",
	},
	{
		id: "vue-errors",
		label: "Vue errors.ts",
		operation: "transform",
		jsx: false,
		repository: "https://github.com/vuejs/core",
		revision: "e131369833d71b2c9e8bbafda427d331ef59a6fd",
		upstreamPath: "packages/compiler-core/src/errors.ts",
		license: "MIT",
		url: "https://raw.githubusercontent.com/vuejs/core/e131369833d71b2c9e8bbafda427d331ef59a6fd/packages/compiler-core/src/errors.ts",
		bytes: 8_428,
		sha256: "24d05de85f9a4efbf5862f135fa4db8ea7d71f8b0aeb49fe89ef1cd7efd88742",
	},
	{
		id: "typescript-binder",
		label: "TypeScript binder.ts",
		operation: "transform",
		jsx: false,
		repository: "https://github.com/microsoft/TypeScript",
		revision: "050880ce59e30b356b686bd3144efe24f875ebc8",
		upstreamPath: "src/compiler/binder.ts",
		license: "Apache-2.0",
		url: "https://raw.githubusercontent.com/microsoft/TypeScript/050880ce59e30b356b686bd3144efe24f875ebc8/src/compiler/binder.ts",
		bytes: 194_463,
		sha256: "b2a0d4d09bfdd389297e346776d12297e4add7e0b62ba2015862e6b50dcb2aa3",
	},
	{
		id: "typescript-parser",
		label: "TypeScript parser.ts",
		operation: "transform",
		jsx: false,
		repository: "https://github.com/microsoft/TypeScript",
		revision: "050880ce59e30b356b686bd3144efe24f875ebc8",
		upstreamPath: "src/compiler/parser.ts",
		license: "Apache-2.0",
		url: "https://raw.githubusercontent.com/microsoft/TypeScript/050880ce59e30b356b686bd3144efe24f875ebc8/src/compiler/parser.ts",
		bytes: 539_685,
		sha256: "7d63eca71e53e31f7c26b3804eefe61a8809aa6989ce0a7ce1377919e81b963f",
	},
	{
		id: "react-router-tsx",
		label: "React Router lib.tsx",
		operation: "transform",
		jsx: true,
		repository: "https://github.com/remix-run/react-router",
		revision: "e650acfa72280373471b329931f024d9445f2925",
		upstreamPath: "packages/react-router/lib/dom/lib.tsx",
		license: "MIT",
		url: "https://raw.githubusercontent.com/remix-run/react-router/e650acfa72280373471b329931f024d9445f2925/packages/react-router/lib/dom/lib.tsx",
		bytes: 104_982,
		sha256: "9da6789f41b7cade64ae9144b9dd4283aef42909e0f889765c9119bbe1166d85",
	},
];

export function corpusCachePath(corpus) {
	const extension = path.extname(corpus.upstreamPath);
	const fileName = `${corpus.id}-${corpus.sha256}${extension}`;
	return path.join(CACHE_DIRECTORY, fileName);
}

export function publicCorpusMetadata(corpus) {
	return {
		id: corpus.id,
		label: corpus.label,
		operation: corpus.operation,
		jsx: corpus.jsx,
		repository: corpus.repository,
		revision: corpus.revision,
		upstreamPath: corpus.upstreamPath,
		license: corpus.license,
		url: corpus.url,
		bytes: corpus.bytes,
		sha256: corpus.sha256,
	};
}
