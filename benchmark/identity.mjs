import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function implementationIdentity(modulePath) {
	const rootDirectory = path.dirname(modulePath);
	const requireFromImplementation = createRequire(pathToFileURL(modulePath));
	const packageJsonPath = path.join(rootDirectory, "package.json");
	const packageJson = readJsonFile(packageJsonPath);
	const dependencies = Object.fromEntries(
		Object.keys(packageJson?.dependencies ?? {})
			.sort()
			.map((name) => {
				const entry = requireFromImplementation.resolve(name);
				return [name, fileIdentity(entry)];
			}),
	);
	return {
		runtimeSha256: runtimeFingerprint(rootDirectory),
		packageJsonSha256: optionalFileFingerprint(packageJsonPath),
		packageLockSha256: optionalFileFingerprint(path.join(rootDirectory, "package-lock.json")),
		dependencies,
	};
}

export function runtimeFingerprint(rootDirectory) {
	const files = [];
	for (const entry of readdirSync(rootDirectory, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".js")) {
			files.push(path.join(rootDirectory, entry.name));
		}
	}
	collectJavaScriptFiles(path.join(rootDirectory, "internal"), files);
	files.sort();

	const hash = createHash("sha256");
	for (const filePath of files) {
		hash.update(path.relative(rootDirectory, filePath));
		hash.update("\0");
		hash.update(readFileSync(filePath));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function fileFingerprint(filePath) {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function collectJavaScriptFiles(directory, files) {
	if (!existsSync(directory)) {
		return;
	}
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			collectJavaScriptFiles(entryPath, files);
		} else if (entry.isFile() && entry.name.endsWith(".js")) {
			files.push(entryPath);
		}
	}
}

function optionalFileFingerprint(filePath) {
	if (!existsSync(filePath)) {
		return null;
	}
	return fileFingerprint(filePath);
}

function readJsonFile(filePath) {
	if (!existsSync(filePath)) {
		return null;
	}
	return JSON.parse(readFileSync(filePath, "utf8"));
}

function fileIdentity(filePath) {
	return {
		path: filePath,
		sha256: fileFingerprint(filePath),
	};
}
