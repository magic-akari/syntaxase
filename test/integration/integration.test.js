import assert from "node:assert/strict";
import test from "node:test";

import {
	collectIntegrationCases,
	evaluateIntegrationCase,
	readCaseFile,
	resultFileNames,
	visibleText,
} from "./fixtures.js";

const integrationCases = await collectIntegrationCases();

test("integration fixture tree is non-empty and complete", () => {
	assert.ok(integrationCases.length > 0);
});

for (const integrationCase of integrationCases) {
	test(integrationCase.name, async () => {
		const actual = await evaluateIntegrationCase(integrationCase);
		const committed = [...integrationCase.fileNames].filter((fileName) => resultFileNames.has(fileName)).sort();
		assert.deepEqual(committed, [actual.fileName], `${integrationCase.name} has stale result files`);
		const expected = await readCaseFile(integrationCase, actual.fileName);
		if (actual.content !== expected) {
			assert.equal(
				visibleText(actual.content),
				visibleText(expected),
				`${integrationCase.name}/${actual.fileName} differs`,
			);
		}
	});
}
