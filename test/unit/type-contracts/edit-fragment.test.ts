import {
	appendOriginal,
	createEditFragment,
	finishEditFragment,
	type EditFragment,
	type OriginalEditFragmentPart,
} from "../../../internal/edit-fragment.ts";

const fragment = createEditFragment();
appendOriginal(fragment, 0, 1);
finishEditFragment(fragment);

const original: OriginalEditFragmentPart = {
	kind: "original",
	sourceStart: 0,
	sourceEnd: 1,
};

// @ts-expect-error Original fragment segments have one source of truth: their source span.
original.text;

// @ts-expect-error Completed fragments can only be produced by fragment factories.
const fabricated: EditFragment = { pieces: [], lineHeads: [] };
