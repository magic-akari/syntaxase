import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BENCHMARK_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export const CACHE_DIRECTORY = path.join(BENCHMARK_DIRECTORY, ".cache");

export const BENCHMARK_CORPUS = [
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
