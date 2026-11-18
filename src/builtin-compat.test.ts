import assert from "node:assert/strict";
import { test } from "node:test";

import { withoutRefusalFallbacks } from "./builtin-compat.js";

test("withoutRefusalFallbacks drops allowedFallbackModels and keeps other flags", () => {
	assert.deepEqual(
		withoutRefusalFallbacks({
			forceAdaptiveThinking: true,
			allowedFallbackModels: [{ model: "claude-opus-5" }],
		}),
		{ forceAdaptiveThinking: true },
	);
});

test("withoutRefusalFallbacks leaves compat without fallbacks unchanged", () => {
	assert.deepEqual(withoutRefusalFallbacks({ supportsMidConvoEffort: true }), { supportsMidConvoEffort: true });
});
