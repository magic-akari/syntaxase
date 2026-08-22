import { createHash } from "node:crypto";

export function planWorkloads(operation, selected) {
	const groups = new Map();
	for (const item of selected) {
		const fingerprint = workloadFingerprint(
			operation,
			item.options,
			item.candidate.inputFile,
			item.candidate.input,
		);
		const group = groups.get(fingerprint);
		if (group === undefined) {
			groups.set(fingerprint, [item]);
		} else {
			group.push(item);
		}
	}

	return [...groups].map(([fingerprint, group]) => createWorkload(operation, fingerprint, group));
}

export function workloadFingerprint(operation, options, inputFile, input) {
	const effectiveOptions = { ...(options ?? {}) };
	if (operation === "transform" && effectiveOptions.jsx === undefined && inputFile === "input.tsx") {
		effectiveOptions.jsx = true;
	}
	return sha256(`${operation}\0${stableStringify(effectiveOptions)}\0${input}`);
}

function createWorkload(operation, fingerprint, group) {
	const canonical = group[0];
	const blockers = group.filter((item) => item.blocker !== undefined).map((item) => item.blocker);
	if (blockers.length > 1 && blockers.some((blocker) => stableStringify(blocker) !== stableStringify(blockers[0]))) {
		throw new Error(`duplicate ${operation} workload ${fingerprint} has conflicting blockers`);
	}
	const oracles = new Set(group.map((item) => item.oracle));
	if (oracles.size !== 1) {
		throw new Error(`duplicate ${operation} workload ${fingerprint} has conflicting outcome oracles`);
	}

	const blocker = blockers[0];
	const identities = group.map((item) => item.identity);
	const origins = group.map((item) => item.origin);
	const oracle = [...oracles][0];
	return {
		...canonical,
		blocker,
		fingerprint,
		identities,
		oracle,
		origins,
		catalogCase: {
			fingerprint,
			identities,
			target: canonical.target,
			inputFile: canonical.candidate.inputFile,
			inputSha256: sha256(canonical.candidate.input),
			...(canonical.options === undefined ? {} : { options: canonical.options }),
			...(blocker === undefined ? {} : { blocker }),
			oracle,
			origins,
		},
	};
}

function stableStringify(value) {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalize(value[key])]),
		);
	}
	return value;
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
