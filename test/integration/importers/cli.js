import process from "node:process";
import { pathToFileURL } from "node:url";

import { syncUpstreamFixtures } from "./sync.js";

const usage = `Usage:
  node test/integration/importers/cli.js [--config PATH] --checkout ID=PATH [--checkout ID=PATH ...] [--write]

The command discovers every supported test in each pinned upstream project.
It checks committed inputs by default. --write updates generated inputs,
case metadata and catalogs, but never integration results.`;

export function parseArguments(arguments_) {
	const options = {
		checkouts: new Map(),
		write: false,
	};

	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === "--help" || argument === "-h") {
			return { help: true };
		}
		if (argument === "--write") {
			options.write = true;
			continue;
		}
		if (argument === "--config") {
			index += 1;
			if (arguments_[index] === undefined) {
				throw new Error("--config requires a path");
			}
			options.configPath = arguments_[index];
			continue;
		}
		if (argument === "--checkout") {
			index += 1;
			const checkout = arguments_[index];
			if (checkout === undefined) {
				throw new Error("--checkout requires ID=PATH");
			}
			const equals = checkout.indexOf("=");
			if (equals < 1 || equals === checkout.length - 1) {
				throw new Error(`Invalid --checkout ${checkout}; expected ID=PATH`);
			}
			const id = checkout.slice(0, equals);
			const checkoutPath = checkout.slice(equals + 1);
			if (options.checkouts.has(id)) {
				throw new Error(`Duplicate --checkout for ${id}`);
			}
			options.checkouts.set(id, checkoutPath);
			continue;
		}
		throw new Error(`Unknown argument ${argument}`);
	}

	return options;
}

export async function runCli(arguments_ = process.argv.slice(2)) {
	const options = parseArguments(arguments_);
	if (options.help) {
		process.stdout.write(`${usage}\n`);
		return;
	}
	await syncUpstreamFixtures({
		...options,
		log(message) {
			process.stdout.write(`${message}\n`);
		},
	});
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	runCli().catch((error) => {
		process.stderr.write(`${error.stack ?? error}\n`);
		process.exitCode = 1;
	});
}
