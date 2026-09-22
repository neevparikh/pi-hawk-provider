import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { baseModelId, parseFastModeModelIds, stripMiddlemanSuffix } from "./model-ids.js";

describe("parseFastModeModelIds", () => {
	it("ignores malformed lists and normalizes only explicit string ids", () => {
		for (const raw of [undefined, null, true, "claude-opus-5", {}]) {
			assert.deepEqual(parseFastModeModelIds(raw), []);
		}
		assert.deepEqual(parseFastModeModelIds([
			"  CLAUDE-OPUS-5 ", "claude-opus-5-data-retention", "", " ", 1, null,
			"claude-opus-5-experimental",
		]), ["claude-opus-5", "claude-opus-5-experimental"]);
	});
});

describe("stripMiddlemanSuffix", () => {
	it("removes a known routing suffix", () => {
		assert.equal(stripMiddlemanSuffix("claude-fable-5-data-retention"), "claude-fable-5");
	});

	it("returns undefined when there's no suffix, so callers can tell the difference", () => {
		assert.equal(stripMiddlemanSuffix("claude-opus-5"), undefined);
		// A suffix-only id isn't a model id.
		assert.equal(stripMiddlemanSuffix("-data-retention"), undefined);
	});
});

describe("baseModelId", () => {
	it("always returns a comparable id", () => {
		assert.equal(baseModelId("  CLAUDE-Opus-5-Data-Retention "), "claude-opus-5");
		assert.equal(baseModelId("claude-opus-5"), "claude-opus-5");
	});
});
