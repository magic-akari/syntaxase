import { accessSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const benchmarkDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.dirname(benchmarkDirectory);
const defaultBridgePath = path.join(repositoryDirectory, "zig-out", "wasm", "index.js");
const bridgePath = path.resolve(process.env.SYNTAXASE_WASM_BRIDGE ?? defaultBridgePath);
const oxcWorkerPath = path.join(
	benchmarkDirectory,
	"node_modules",
	"@oxc-transform",
	"binding-wasm32-wasi",
	"wasi-worker-browser.mjs",
);

try {
	accessSync(bridgePath);
} catch {
	throw new Error(`Missing Syntaxase WebAssembly bridge at ${bridgePath}. Run \`mise run build:wasm-stage\` first.`);
}

export default defineConfig({
	root: benchmarkDirectory,
	cacheDir: path.join(benchmarkDirectory, ".cache", "vitest"),
	resolve: {
		alias: {
			"syntaxase-wasm": bridgePath,
			"@oxc-transform/binding-wasm32-wasi/wasi-worker-browser.mjs": oxcWorkerPath,
		},
	},
	optimizeDeps: {
		exclude: ["oxc-transform", "@oxc-transform/binding-wasm32-wasi"],
	},
	server: {
		fs: {
			allow: [repositoryDirectory],
		},
		headers: {
			"Cross-Origin-Embedder-Policy": "require-corp",
			"Cross-Origin-Opener-Policy": "same-origin",
		},
	},
	test: {
		include: ["browser/**/*.bench.mjs"],
		fileParallelism: false,
		maxWorkers: 1,
		testTimeout: 300_000,
		hookTimeout: 300_000,
		browser: {
			enabled: true,
			headless: true,
			isolate: false,
			ui: false,
			commands: {
				reportBenchmark(_context, report) {
					process.stdout.write(`${report}\n`);
				},
			},
			provider: playwright({
				launchOptions: {
					args: ["--js-flags=--expose-gc"],
					channel: "chrome",
				},
			}),
			instances: [{ browser: "chromium" }],
		},
	},
});
