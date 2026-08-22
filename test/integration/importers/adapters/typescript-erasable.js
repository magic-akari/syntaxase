import path from "node:path";

export const adapterVersion = 3;

const compilerCaseRoot = "tests/cases/compiler";
const selectedCases = ["erasableSyntaxOnly.ts", "erasableSyntaxOnly2.ts"];
const knownCases = new Set([...selectedCases, "erasableSyntaxOnlyDeclaration.ts"]);

export async function discoverTypeScriptErasable({ project, readText, listFiles }) {
	if (typeof readText !== "function" || typeof listFiles !== "function") {
		throw new TypeError("TypeScript erasable discovery requires readText and listFiles functions");
	}
	const listed = await listFiles(compilerCaseRoot);
	const matching = listed
		.filter((sourcePath) => /^erasableSyntaxOnly.*\.ts$/u.test(path.posix.basename(sourcePath)))
		.sort();
	const unknown = matching.filter((sourcePath) => !knownCases.has(path.posix.basename(sourcePath)));
	if (unknown.length > 0) {
		throw new Error(`${project.id} has unclassified erasableSyntaxOnly cases: ${unknown.join(", ")}`);
	}
	for (const name of knownCases) {
		const sourcePath = path.posix.join(compilerCaseRoot, name);
		if (!matching.includes(sourcePath)) {
			throw new Error(`${project.id} is missing expected source ${sourcePath}`);
		}
	}

	const declarationPath = path.posix.join(compilerCaseRoot, "erasableSyntaxOnlyDeclaration.ts");
	const declarationExcluded = (project.sourceExclusions ?? []).some((entry) => entry.path === declarationPath);
	if (!declarationExcluded) {
		throw new Error(`${project.id} must explicitly classify ${declarationPath}`);
	}

	const candidates = [];
	let declarationVirtualFiles = 0;
	for (const caseName of selectedCases) {
		const sourcePath = path.posix.join(compilerCaseRoot, caseName);
		const baselinePath = `tests/baselines/reference/${caseName.replace(/\.ts$/u, ".errors.txt")}`;
		const sourceText = await readText(sourcePath);
		const baselineText = await readText(baselinePath);
		const diagnostics = parseDiagnostics(baselineText);
		for (const virtualFile of splitVirtualFiles(sourceText, sourcePath)) {
			if (isDeclarationTypeScriptFile(virtualFile.name)) {
				declarationVirtualFiles += 1;
				continue;
			}
			if (!isRuntimeTypeScriptFile(virtualFile.name)) {
				throw new Error(`${project.id} has unclassified virtual file ${sourcePath}#${virtualFile.name}`);
			}
			const fileDiagnostics = diagnostics.get(virtualFile.name) ?? [];
			const oracle = fileDiagnostics.length > 0 ? "reject" : "accept";
			candidates.push(createCandidate(caseName, sourcePath, virtualFile, oracle));
		}
	}

	return {
		candidates,
		stats: {
			declarationVirtualFiles,
			selectedCases: selectedCases.length,
			virtualWorkloads: candidates.length,
		},
	};
}

function createCandidate(caseName, sourcePath, virtualFile, oracle) {
	const suite = caseName.replace(/\.ts$/u, "");
	return {
		api: "stripTypes",
		extraction: ["virtual-file"],
		input: virtualFile.source,
		inputFile: inputFileFor(virtualFile.name),
		invocation: 1,
		oracle,
		sourcePath,
		sourceRange: {
			endLine: physicalEndLine(virtualFile.source, virtualFile.sourceStartLine),
			startLine: virtualFile.sourceStartLine,
		},
		suite: [suite],
		title: `${suite}: ${virtualFile.name}`,
		variant: `${virtualFile.name}:${oracle}`,
	};
}

function splitVirtualFiles(sourceText, sourcePath) {
	const matches = [...sourceText.matchAll(/^\/\/ @filename: ([^\r\n]+)\r?$/gmu)];
	if (matches.length === 0) {
		throw new Error(`${sourcePath} has no @filename virtual files`);
	}
	return matches.map((match, index) => {
		let sourceStart = match.index + match[0].length;
		if (sourceText.startsWith("\r\n", sourceStart)) {
			sourceStart += 2;
		} else if (/^[\r\n]/u.test(sourceText[sourceStart] ?? "")) {
			sourceStart += 1;
		}
		const sourceEnd = matches[index + 1]?.index ?? sourceText.length;
		return {
			name: match[1],
			source: sourceText.slice(sourceStart, sourceEnd),
			sourceStartLine: physicalLineCount(sourceText.slice(0, sourceStart)),
		};
	});
}

function parseDiagnostics(baselineText) {
	const diagnostics = new Map();
	for (const match of baselineText.matchAll(/^(.+)\((\d+),(\d+)\): error TS(\d+):/gmu)) {
		const list = diagnostics.get(match[1]) ?? [];
		list.push({ code: Number(match[4]), column: Number(match[3]), line: Number(match[2]) });
		diagnostics.set(match[1], list);
	}
	return diagnostics;
}

function inputFileFor(fileName) {
	if (fileName.endsWith(".cts")) {
		return "input.cts";
	}
	if (fileName.endsWith(".mts")) {
		return "input.mts";
	}
	return "input.ts";
}

function isRuntimeTypeScriptFile(fileName) {
	return /\.(?:c|m)?ts$/u.test(fileName);
}

function isDeclarationTypeScriptFile(fileName) {
	return /\.d\.(?:c|m)?ts$/u.test(fileName);
}

function physicalLineCount(source) {
	return (source.match(/\r\n|[\r\n\u2028\u2029]/gu) ?? []).length + 1;
}

function physicalEndLine(source, startLine) {
	const count = physicalLineCount(source);
	const trailingTerminator = /(?:\r\n|[\r\n\u2028\u2029])$/u.test(source);
	return startLine + count - (trailingTerminator ? 2 : 1);
}
