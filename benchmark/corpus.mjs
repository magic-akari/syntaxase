import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BENCHMARK_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export const CACHE_DIRECTORY = path.join(BENCHMARK_DIRECTORY, ".cache");

export const BENCHMARK_CORPUS = [
	{
		id: "astro-config",
		label: "Astro config.ts",
		lang: "ts",
		repository: "https://github.com/withastro/astro",
		revision: "d48312502ef33a32aef3f25b6b6035db8b38e189",
		upstreamPath: "packages/astro/src/types/public/config.ts",
		license: "MIT",
		url: "https://raw.githubusercontent.com/withastro/astro/d48312502ef33a32aef3f25b6b6035db8b38e189/packages/astro/src/types/public/config.ts",
		bytes: 128_185,
		sha256: "c1e2ffa4e82802e9c31f128338d76a15419a1f99ec21c1a0f711eeef3a517010",
	},
	{
		id: "effect-schema-ast",
		label: "Effect SchemaAST.ts",
		lang: "ts",
		repository: "https://github.com/Effect-TS/effect",
		revision: "a63dcbf04e5c3d8d934a41bc6122e9951b1cefa9",
		upstreamPath: "packages/effect/src/SchemaAST.ts",
		license: "MIT",
		url: "https://raw.githubusercontent.com/Effect-TS/effect/a63dcbf04e5c3d8d934a41bc6122e9951b1cefa9/packages/effect/src/SchemaAST.ts",
		bytes: 130_652,
		sha256: "44d2162a5f3405e79d84c405127ac9c84fb9c8768bdaf2afadda75152bfb2f79",
	},
	{
		id: "hono-types",
		label: "Hono types.ts",
		lang: "ts",
		repository: "https://github.com/honojs/hono",
		revision: "971106d132ec8a989be12ec5c8e63cfaf597cd4f",
		upstreamPath: "src/types.ts",
		license: "MIT",
		url: "https://raw.githubusercontent.com/honojs/hono/971106d132ec8a989be12ec5c8e63cfaf597cd4f/src/types.ts",
		bytes: 77_937,
		sha256: "ce5a6ed84c07e54329c14709426f908aec4d94fb535c2b1a59f08128e69afb2e",
	},
	{
		id: "react-router-tsx",
		label: "React Router lib.tsx",
		lang: "tsx",
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

export function readCorpus(corpus) {
	const cachePath = corpusCachePath(corpus);
	let buffer;
	try {
		buffer = readFileSync(cachePath);
	} catch (error) {
		if (error.code === "ENOENT") {
			throw new Error(`Missing benchmark corpus ${corpus.id}. Run \`mise run bench:prepare\` first.`);
		}
		throw error;
	}

	verifyCorpus(corpus, buffer, cachePath);
	return buffer;
}

export function verifyCorpus(corpus, buffer, source) {
	if (buffer.length !== corpus.bytes) {
		throw new Error(`${corpus.id} from ${source} has ${buffer.length} bytes; expected ${corpus.bytes}`);
	}

	const digest = createHash("sha256").update(buffer).digest("hex");
	if (digest !== corpus.sha256) {
		throw new Error(`${corpus.id} from ${source} has SHA-256 ${digest}; expected ${corpus.sha256}`);
	}
}
