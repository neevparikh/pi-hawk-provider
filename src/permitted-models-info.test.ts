import assert from "node:assert/strict";
import { test } from "node:test";
import { namesFromModelInfo, shouldTryModelInfo } from "./permitted-models-info.js";

test("namesFromModelInfo keeps live, named models", () => {
	assert.deepEqual(
		namesFromModelInfo([
			{ name: "claude-a", dead: false },
			{ name: "claude-b" },
			{ name: "claude-dead", dead: true },
			{ name: "" },
			{ lab: "x" },
			null,
			"claude-c",
		]),
		["claude-a", "claude-b"],
	);
});

test("namesFromModelInfo returns nothing for a non-list", () => {
	assert.deepEqual(namesFromModelInfo({ error: "nope" }), []);
});

test("shouldTryModelInfo only on auth refusals", () => {
	assert.equal(shouldTryModelInfo(401), true);
	assert.equal(shouldTryModelInfo(403), true);
	assert.equal(shouldTryModelInfo(500), false);
});
