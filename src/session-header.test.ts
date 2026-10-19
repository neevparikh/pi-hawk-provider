import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_HEADER, withSessionHeader } from "./session-header.js";

test("adds the session id header, keeping existing headers", () => {
	assert.deepEqual(withSessionHeader({ "x-middleman-priority": "high" }, "abc"), {
		"x-middleman-priority": "high",
		[SESSION_HEADER]: "abc",
	});
});

test("creates headers when there were none", () => {
	assert.deepEqual(withSessionHeader(undefined, "abc"), { [SESSION_HEADER]: "abc" });
});

test("leaves headers alone without a session id", () => {
	const headers = { a: "b" };
	assert.equal(withSessionHeader(headers, undefined), headers);
	assert.equal(withSessionHeader(undefined, ""), undefined);
});
