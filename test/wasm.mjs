import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";
import { runApiTests } from "./js-api.mjs";

if (typeof Uint8Array.fromBase64 !== "function") {
	Object.defineProperty(Uint8Array, "fromBase64", {
		configurable: true,
		value(value) {
			return Uint8Array.from(Buffer.from(value, "base64"));
		},
		writable: true,
	});
}

const bridgePath = process.argv[2];
const moduleSpecifier = bridgePath === undefined ? "../npm/syntaxase-wasm/index.js" : pathToFileURL(bridgePath).href;
void import(moduleSpecifier).then((syntaxase) => runApiTests(syntaxase, "WASM")).catch(reportFailure);

function reportFailure(error) {
	console.error(error);
	process.exitCode = 1;
}
