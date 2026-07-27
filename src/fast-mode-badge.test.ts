import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { FastModeBadge, type FastModeBadgePayload } from "./fast-mode-badge.js";
import type { FastModeOutcome } from "./fast-mode-proxy.js";

function outcome(over: Partial<FastModeOutcome> = {}): FastModeOutcome {
	return {
		hawkModelId: "claude-opus-5",
		bodyModel: "claude-opus-5",
		injected: true,
		tier: "on",
		status: 200,
		retriedWithoutFastMode: false,
		rejectedStatus: null,
		evidence: {
			present: true,
			remaining: 500,
			reset: null,
			names: ["anthropic-fast-input-tokens-remaining"],
			anthropicNames: ["anthropic-fast-input-tokens-remaining"],
		},
		...over,
	};
}

let emitted: FastModeBadgePayload[];
let warnings: string[];
let badge: FastModeBadge;

beforeEach(() => {
	emitted = [];
	warnings = [];
	badge = new FastModeBadge({
		emit: (p) => emitted.push(p),
		warn: (m) => warnings.push(m),
	});
});

describe("publish", () => {
	it("drops exact repeats per model", () => {
		assert.equal(badge.publish({ intent: false, model: "claude-sonnet-5" }), true);
		assert.equal(badge.publish({ intent: false, model: "claude-sonnet-5" }), false);
		assert.equal(badge.publish({ intent: false, model: "claude-sonnet-5" }), false);
		assert.equal(emitted.length, 1);
	});

	it("keeps models, and the model-less toggle, independent", () => {
		badge.publish({ intent: false, model: "claude-sonnet-5" });
		badge.publish({ intent: true, actual: "on", model: "claude-opus-5" });
		badge.publish({ intent: true });
		// Sonnet repeating itself must not resurrect an emit...
		assert.equal(badge.publish({ intent: false, model: "claude-sonnet-5" }), false);
		// ...and a real change still gets through.
		assert.equal(badge.publish({ intent: true, actual: "cooldown", model: "claude-opus-5" }), true);
		assert.deepEqual(emitted, [
			{ intent: false, model: "claude-sonnet-5" },
			{ intent: true, actual: "on", model: "claude-opus-5" },
			{ intent: true },
			{ intent: true, actual: "cooldown", model: "claude-opus-5" },
		]);
	});
});

describe("recordOutcome", () => {
	it("records and publishes a measured tier", () => {
		badge.recordOutcome(outcome());
		assert.equal(badge.lastTier("claude-opus-5"), "on");
		assert.deepEqual(emitted, [{ intent: true, actual: "on", model: "claude-opus-5" }]);
		assert.deepEqual(warnings, []);
	});

	it("warns once about a silent downgrade", () => {
		badge.recordOutcome(outcome({ tier: "off", evidence: emptyEvidence() }));
		badge.recordOutcome(outcome({ tier: "off", evidence: emptyEvidence() }));
		assert.equal(badge.lastTier("claude-opus-5"), "off");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /ran standard/);
	});

	it("warns once about a cooldown, naming the reset", () => {
		badge.recordOutcome(
			outcome({
				tier: "cooldown",
				evidence: {
					present: true,
					remaining: 0,
					reset: "2026-07-28T00:00:00Z",
					names: ["anthropic-fast-input-tokens-remaining"],
					anthropicNames: ["anthropic-fast-input-tokens-remaining"],
				},
			}),
		);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /cooldown/);
		assert.match(warnings[0] ?? "", /2026-07-28T00:00:00Z/);
	});

	it("reports the rejected status, not the retry's, when it had to retry", () => {
		badge.recordOutcome(
			outcome({ tier: "off", injected: false, retriedWithoutFastMode: true, rejectedStatus: 400 }),
		);
		assert.match(warnings[0] ?? "", /HTTP 400/);
		assert.equal(badge.lastTier("claude-opus-5"), "off");
	});

	it("ignores a failed request instead of blaming fast mode for it", () => {
		badge.recordOutcome(outcome()); // a good turn: measured "on"
		emitted.length = 0;
		badge.recordOutcome(outcome({ status: 500, tier: "off", evidence: emptyEvidence() }));
		// The 500 says nothing about tiers, so the last real measurement stands.
		assert.equal(badge.lastTier("claude-opus-5"), "on");
		assert.deepEqual(emitted, []);
		assert.deepEqual(warnings, []);
	});

	it("tracks models separately", () => {
		badge.recordOutcome(outcome());
		badge.recordOutcome(outcome({ hawkModelId: "claude-opus-4-8", tier: "cooldown" }));
		assert.deepEqual(badge.measurements(), [
			["claude-opus-4-8", "cooldown"],
			["claude-opus-5", "on"],
		]);
	});
});

describe("warnOnce / resetWarnings", () => {
	it("says a thing once until re-armed", () => {
		badge.warnOnce("unsupported:claude-sonnet-5", "no fast tier here");
		badge.warnOnce("unsupported:claude-sonnet-5", "no fast tier here");
		assert.equal(warnings.length, 1);

		badge.resetWarnings();
		badge.warnOnce("unsupported:claude-sonnet-5", "no fast tier here");
		assert.equal(warnings.length, 2);
	});
});

function emptyEvidence() {
	return { present: false, remaining: null, reset: null, names: [], anthropicNames: [] };
}
