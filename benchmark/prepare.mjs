import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import process from "node:process";

import { BENCHMARK_CORPUS, CACHE_DIRECTORY, corpusCachePath } from "./corpus.mjs";

await mkdir(CACHE_DIRECTORY, { recursive: true });

for (const corpus of BENCHMARK_CORPUS) {
	const cachePath = corpusCachePath(corpus);
	const cached = await readCachedCorpus(cachePath);
	if (cached !== null) {
		verifyCorpus(corpus, cached, cachePath);
		process.stdout.write(`ready      ${corpus.id} (${formatBytes(cached.length)})\n`);
		continue;
	}

	process.stdout.write(`downloading ${corpus.id}\n`);
	const response = await fetch(corpus.url, {
		redirect: "follow",
		signal: AbortSignal.timeout(60_000),
	});
	if (!response.ok) {
		throw new Error(`Failed to download ${corpus.id}: HTTP ${response.status} ${response.statusText}`);
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	verifyCorpus(corpus, buffer, corpus.url);
	await writeCacheFile(cachePath, buffer);
	process.stdout.write(`ready      ${corpus.id} (${formatBytes(buffer.length)})\n`);
}

function readCachedCorpus(cachePath) {
	return readFile(cachePath).catch((error) => {
		if (error.code === "ENOENT") {
			return null;
		}
		throw error;
	});
}

function verifyCorpus(corpus, buffer, source) {
	if (buffer.length !== corpus.bytes) {
		throw new Error(
			`${corpus.id} from ${source} has ${buffer.length} bytes; expected ${corpus.bytes}. ` +
				"Remove the cached file and retry only after checking the pinned upstream revision.",
		);
	}

	const digest = createHash("sha256").update(buffer).digest("hex");
	if (digest !== corpus.sha256) {
		throw new Error(
			`${corpus.id} from ${source} has SHA-256 ${digest}; expected ${corpus.sha256}. ` +
				"Remove the cached file and retry only after checking the pinned upstream revision.",
		);
	}
}

async function writeCacheFile(cachePath, buffer) {
	const temporaryPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
	try {
		await writeFile(temporaryPath, buffer, { flag: "wx" });
		await rename(temporaryPath, cachePath);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

function formatBytes(bytes) {
	return `${(bytes / 1024).toFixed(1)} KiB`;
}
