interface RuntimeNameAllocatorState {
	readonly nextSuffixes: Map<string, Map<number, number>>;
	readonly reservedNames: Set<string>;
	readonly sourceNames: ReadonlySet<string>;
}

const runtimeNameAllocatorState: unique symbol = Symbol("RuntimeNameAllocatorState");

export interface RuntimeNameAllocator {
	readonly [runtimeNameAllocatorState]: RuntimeNameAllocatorState;
}

export function createRuntimeNameAllocator(sourceNames: ReadonlySet<string>): RuntimeNameAllocator {
	return {
		[runtimeNameAllocatorState]: {
			nextSuffixes: new Map(),
			reservedNames: new Set(),
			sourceNames,
		},
	};
}

function runtimeNameIsSource(allocator: RuntimeNameAllocator, name: string): boolean {
	const state = allocator[runtimeNameAllocatorState];
	return state.sourceNames.has(name);
}

function runtimeNameIsReserved(allocator: RuntimeNameAllocator, name: string): boolean {
	return allocator[runtimeNameAllocatorState].reservedNames.has(name);
}

export function runtimeNameIsUsed(allocator: RuntimeNameAllocator, name: string): boolean {
	return runtimeNameIsSource(allocator, name) || runtimeNameIsReserved(allocator, name);
}

export function reserveRuntimeName(allocator: RuntimeNameAllocator, name: string): void {
	allocator[runtimeNameAllocatorState].reservedNames.add(name);
}

export function claimRuntimeReceiverName(
	allocator: RuntimeNameAllocator,
	preferredName: string,
	isAdditionallyUnavailable?: (name: string) => boolean,
): string {
	if (!runtimeNameIsReserved(allocator, preferredName) && isAdditionallyUnavailable?.(preferredName) !== true) {
		return preferredName;
	}
	return claimSuffixedRuntimeName(allocator, preferredName, 1, isAdditionallyUnavailable);
}

export function claimSuffixedRuntimeName(
	allocator: RuntimeNameAllocator,
	baseName: string,
	minimumSuffix: number,
	isAdditionallyUnavailable?: (name: string) => boolean,
): string {
	const state = allocator[runtimeNameAllocatorState];
	let suffixesForBase = state.nextSuffixes.get(baseName);
	if (suffixesForBase === undefined) {
		suffixesForBase = new Map();
		state.nextSuffixes.set(baseName, suffixesForBase);
	}
	let suffix = suffixesForBase.get(minimumSuffix) ?? minimumSuffix;
	while (true) {
		const candidate = `${baseName}${suffix}`;
		suffix += 1;
		if (runtimeNameIsUsed(allocator, candidate) || isAdditionallyUnavailable?.(candidate) === true) {
			continue;
		}
		suffixesForBase.set(minimumSuffix, suffix);
		state.reservedNames.add(candidate);
		return candidate;
	}
}
