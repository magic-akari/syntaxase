import { accessSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const benchmarkDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.dirname(benchmarkDirectory);
const defaultBridgePath = path.join(repositoryDirectory, "zig-out", "wasm", "index.js");
const bridgePath = path.resolve(process.env.SYNTAXASE_WASM_BRIDGE ?? defaultBridgePath);
const wasiRuntimePackages = ["@emnapi/core", "@emnapi/runtime"];

try {
	accessSync(bridgePath);
} catch {
	throw new Error(`Missing Syntaxase WebAssembly bridge at ${bridgePath}. Run \`mise run build:wasm-stage\` first.`);
}

const config = defineConfig({
	root: benchmarkDirectory,
	cacheDir: path.join(benchmarkDirectory, ".cache", "vitest"),
	resolve: {
		alias: {
			"syntaxase-wasm": bridgePath,
			...wasiRuntimeAliases(),
		},
	},
	optimizeDeps: {
		include: wasiRuntimePackages,
		exclude: ["oxc-transform", "@oxc-transform/binding-wasm32-wasip1"],
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

// Keep the package's relative WASM URLs outside dependency prebundling.
config.optimizeDeps.exclude.push("@nibling/typestrip");

export default config;

function wasiRuntimeAliases() {
	const require = createRequire(import.meta.url);
	const binding = Object.keys(require("./package.json").dependencies).find((name) =>
		name.endsWith("/binding-wasm32-wasip1"),
	);
	const runtimeRequire = createRequire(require.resolve(`${binding}/package.json`));
	// The core and context must use the same ABI as the WASI binding.
	return Object.fromEntries(
		wasiRuntimePackages.map((name) => {
			const manifestPath = runtimeRequire.resolve(`${name}/package.json`);
			return [name, path.resolve(path.dirname(manifestPath), runtimeRequire(manifestPath).module)];
		}),
	);
}
