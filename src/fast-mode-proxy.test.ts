/**
 * Tests for the fast-mode gates and the proxy's request/response handling.
 *
 * Fast tier is ~6x standard pricing and, until this file existed, the only
 * feedback loop on any of it was the bill: the provider claimed "fast" because
 * a proxy process was alive, not because a request had been mutated or a
 * response had come back on fast tier. The proxy tests run against a real
 * loopback HTTP server so the thing under test is the actual socket path.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { after, describe, it } from "node:test";

import {
	classifyFastTier,
	type FastModeOutcome,
	type FastModeProxyHandle,
	isFastModeCapableModelId,
	looksLikeSpeedRejection,
	MARKER_HEADER,
	readFastTierEvidence,
	shouldInject,
	startFastModeProxy,
} from "./fast-mode-proxy.js";

describe("isFastModeCapableModelId", () => {
	it("accepts the fast-tier models", () => {
		assert.equal(isFastModeCapableModelId("claude-opus-5"), true);
		assert.equal(isFastModeCapableModelId("claude-opus-4-8"), true);
		assert.equal(isFastModeCapableModelId("CLAUDE-OPUS-5"), true);
	});

	it("sees through middleman routing suffixes", () => {
		// `-data-retention` picks a zero-retention route to the same model, so
		// capability belongs to the base id.
		assert.equal(isFastModeCapableModelId("claude-opus-5-data-retention"), true);
	});

	it("still rejects models that simply aren't fast-tier models", () => {
		// Fable has no fast tier, with or without a routing suffix.
		assert.equal(isFastModeCapableModelId("claude-fable-5"), false);
		assert.equal(isFastModeCapableModelId("claude-fable-5-data-retention"), false);
		assert.equal(isFastModeCapableModelId("claude-sonnet-5"), false);
		assert.equal(isFastModeCapableModelId("gpt-5.6-luna"), false);
	});

	it("fails closed on lookalikes", () => {
		// Exact match on the base id, never a prefix: a 6x price tag is not
		// something to hand out on the strength of a shared prefix.
		assert.equal(isFastModeCapableModelId("claude-opus-50"), false);
		assert.equal(isFastModeCapableModelId("claude-opus-5-experimental"), false);
	});
});

describe("shouldInject", () => {
	it("is the looser net the gate already approved", () => {
		assert.equal(shouldInject("claude-opus-5"), true);
		assert.equal(shouldInject("claude-opus-5-data-retention"), true);
		// Dated ids still pass — this check exists to catch a body whose model
		// was rewritten between the gate and here, not to re-litigate policy.
		assert.equal(shouldInject("claude-opus-5-20260601"), true);
	});

	it("rejects non-fast models and non-strings", () => {
		assert.equal(shouldInject("claude-fable-5-data-retention"), false);
		assert.equal(shouldInject("claude-sonnet-5"), false);
		assert.equal(shouldInject(undefined), false);
		assert.equal(shouldInject(42), false);
	});
});

describe("readFastTierEvidence", () => {
	it("finds fast-tier accounting headers and the tightest remaining bucket", () => {
		const evidence = readFastTierEvidence({
			"anthropic-fast-input-tokens-remaining": "1200",
			"anthropic-fast-output-tokens-remaining": "30",
			"anthropic-fast-input-tokens-reset": "2026-07-27T21:00:00Z",
			"anthropic-ratelimit-input-tokens-remaining": "999999",
			"content-type": "application/json",
		});
		assert.equal(evidence.present, true);
		assert.equal(evidence.remaining, 30);
		assert.equal(evidence.reset, "2026-07-27T21:00:00Z");
		assert.deepEqual(evidence.names, [
			"anthropic-fast-input-tokens-remaining",
			"anthropic-fast-input-tokens-reset",
			"anthropic-fast-output-tokens-remaining",
		]);
	});

	it("reports nothing when the response carries no fast-tier accounting", () => {
		const evidence = readFastTierEvidence({
			"anthropic-ratelimit-input-tokens-remaining": "100",
			"content-type": "application/json",
		});
		assert.equal(evidence.present, false);
		assert.equal(evidence.remaining, null);
		assert.deepEqual(evidence.names, []);
		// Still records what *did* come back, so a renamed header is diagnosable
		// under HAWK_PROVIDER_DEBUG=1 instead of silently reading as "not fast".
		assert.deepEqual(evidence.anthropicNames, ["anthropic-ratelimit-input-tokens-remaining"]);
	});
});

/**
 * Captured from the middleman on 2026-07-27: two identical 16-token
 * `claude-opus-5` calls, one with `speed: "fast"` + the beta opt-in and one
 * without. Kept verbatim so the matcher is tested against what the API really
 * sends rather than what we assumed it sends.
 */
const OBSERVED_FAST_RESPONSE_HEADERS = {
	"anthropic-fast-input-tokens-limit": "2000000",
	"anthropic-fast-input-tokens-remaining": "1929000",
	"anthropic-fast-input-tokens-reset": "2026-07-27T20:38:35Z",
	"anthropic-fast-output-tokens-limit": "400000",
	"anthropic-fast-output-tokens-remaining": "400000",
	"anthropic-fast-output-tokens-reset": "2026-07-27T20:38:33Z",
	"anthropic-organization-id": "36a533b0-8a62-4bb4-80a5-a774efa6c965",
	"anthropic-ratelimit-requests-limit": "20000",
	"anthropic-ratelimit-requests-remaining": "19999",
	"anthropic-ratelimit-requests-reset": "2026-07-27T20:38:32Z",
	"content-type": "application/json",
};

const OBSERVED_STANDARD_RESPONSE_HEADERS = {
	"anthropic-organization-id": "36a533b0-8a62-4bb4-80a5-a774efa6c965",
	"anthropic-ratelimit-input-tokens-limit": "13000000",
	"anthropic-ratelimit-input-tokens-remaining": "13000000",
	"anthropic-ratelimit-input-tokens-reset": "2026-07-27T20:38:34Z",
	"anthropic-ratelimit-output-tokens-limit": "2600000",
	"anthropic-ratelimit-output-tokens-remaining": "2600000",
	"anthropic-ratelimit-output-tokens-reset": "2026-07-27T20:38:34Z",
	"anthropic-ratelimit-requests-limit": "20000",
	"anthropic-ratelimit-requests-remaining": "19999",
	"anthropic-ratelimit-requests-reset": "2026-07-27T20:38:33Z",
	"anthropic-ratelimit-tokens-limit": "15600000",
	"anthropic-ratelimit-tokens-remaining": "15600000",
	"anthropic-ratelimit-tokens-reset": "2026-07-27T20:38:34Z",
	"content-type": "application/json",
};

describe("against real captured responses", () => {
	it("recognizes a turn Anthropic actually served on fast tier", () => {
		const evidence = readFastTierEvidence(OBSERVED_FAST_RESPONSE_HEADERS);
		assert.equal(evidence.present, true);
		// Tightest bucket of the two token pools.
		assert.equal(evidence.remaining, 400000);
		assert.equal(classifyFastTier(true, evidence), "on");
	});

	it("does not mistake ordinary rate-limit accounting for fast tier", () => {
		// The control response is dense with `anthropic-ratelimit-*` headers and
		// must still read as standard — no substring collision, no false yellow.
		const evidence = readFastTierEvidence(OBSERVED_STANDARD_RESPONSE_HEADERS);
		assert.equal(evidence.present, false);
		assert.equal(classifyFastTier(true, evidence), "off");
		assert.equal(evidence.anthropicNames.length, 13);
	});
});

describe("classifyFastTier", () => {
	const none = readFastTierEvidence({});
	const served = readFastTierEvidence({ "anthropic-fast-input-tokens-remaining": "500" });
	const empty = readFastTierEvidence({ "anthropic-fast-input-tokens-remaining": "0" });

	it("only says on when the response proves it", () => {
		assert.equal(classifyFastTier(true, served), "on");
	});

	it("calls an exhausted pool a cooldown", () => {
		assert.equal(classifyFastTier(true, empty), "cooldown");
	});

	it("calls an unproven request off", () => {
		// Injected but no fast-tier accounting came back: served standard.
		assert.equal(classifyFastTier(true, none), "off");
		// Never injected: nothing was asked of the API.
		assert.equal(classifyFastTier(false, served), "off");
	});
});

describe("looksLikeSpeedRejection", () => {
	it("recognizes upstream refusing the bits we added", () => {
		assert.equal(
			looksLikeSpeedRejection(400, '{"error":{"message":"speed: Extra inputs are not permitted"}}'),
			true,
		);
		assert.equal(looksLikeSpeedRejection(400, "fast-mode-2026-02-01 is not enabled"), true);
	});

	it("leaves the caller's own failures alone", () => {
		assert.equal(looksLikeSpeedRejection(400, '{"error":{"message":"max_tokens too large"}}'), false);
		assert.equal(looksLikeSpeedRejection(401, "unauthorized"), false);
		assert.equal(looksLikeSpeedRejection(500, "speed"), false); // upstream broke, not us
		assert.equal(looksLikeSpeedRejection(400, ""), false);
	});
});

// --- proxy end-to-end (loopback only) ---

interface UpstreamCapture {
	body: Record<string, unknown>;
	beta: string | undefined;
	marker: string | string[] | undefined;
}

/** Fake middleman. `respond` decides what each request gets back, so a test
 *  can play "rejects speed", "serves fast tier", "silently downgrades". */
async function startUpstream(
	respond: (req: IncomingMessage, res: ServerResponse, call: number) => void,
): Promise<{ url: string; calls: UpstreamCapture[]; close: () => Promise<void> }> {
	const calls: UpstreamCapture[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			let body: Record<string, unknown> = {};
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
			} catch {
				/* leave empty */
			}
			calls.push({
				body,
				beta: req.headers["anthropic-beta"] as string | undefined,
				marker: req.headers[MARKER_HEADER],
			});
			respond(req, res, calls.length);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return {
		url: `http://127.0.0.1:${address.port}/anthropic`,
		calls,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
	for (const fn of cleanups) await fn();
});

async function post(
	proxy: FastModeProxyHandle,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
	const res = await fetch(`${proxy.getBaseUrl()}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	return { status: res.status, text: await res.text() };
}

describe("fast-mode proxy", () => {
	it("injects speed + beta only for marked requests, and reports the tier it can prove", async () => {
		const upstream = await startUpstream((_req, res) => {
			res.writeHead(200, {
				"content-type": "application/json",
				"anthropic-fast-input-tokens-remaining": "4321",
			});
			res.end('{"ok":true}');
		});
		cleanups.push(upstream.close);
		const outcomes: FastModeOutcome[] = [];
		const proxy = await startFastModeProxy(upstream.url, {
			onOutcome: (o) => outcomes.push(o),
		});
		cleanups.push(proxy.close);

		await post(proxy, { model: "claude-opus-5", messages: [] }, { [MARKER_HEADER]: "claude-opus-5" });
		assert.equal(upstream.calls[0]?.body.speed, "fast");
		assert.match(upstream.calls[0]?.beta ?? "", /fast-mode-2026-02-01/);
		// The marker is ours; it must never reach upstream.
		assert.equal(upstream.calls[0]?.marker, undefined);
		assert.deepEqual(
			outcomes.map((o) => [o.hawkModelId, o.injected, o.tier]),
			[["claude-opus-5", true, "on"]],
		);
		assert.equal(outcomes[0]?.evidence.remaining, 4321);

		// Unmarked traffic passes through untouched and isn't reported.
		await post(proxy, { model: "claude-sonnet-5", messages: [] });
		assert.equal(upstream.calls[1]?.body.speed, undefined);
		assert.equal(upstream.calls[1]?.beta, undefined);
		assert.equal(outcomes.length, 1);
	});

	it("reports off when the response carries no fast-tier accounting", async () => {
		const upstream = await startUpstream((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"ok":true}');
		});
		cleanups.push(upstream.close);
		const outcomes: FastModeOutcome[] = [];
		const proxy = await startFastModeProxy(upstream.url, { onOutcome: (o) => outcomes.push(o) });
		cleanups.push(proxy.close);

		const res = await post(
			proxy,
			{ model: "claude-opus-5", messages: [] },
			{ [MARKER_HEADER]: "claude-opus-5" },
		);
		assert.equal(res.status, 200);
		// We asked, we injected, and the API said nothing about fast tier —
		// which is exactly the silent downgrade the old code called "on".
		assert.equal(outcomes[0]?.injected, true);
		assert.equal(outcomes[0]?.tier, "off");
	});

	it("reports cooldown when the fast-tier pool is empty", async () => {
		const upstream = await startUpstream((_req, res) => {
			res.writeHead(200, {
				"content-type": "application/json",
				"anthropic-fast-input-tokens-remaining": "0",
				"anthropic-fast-input-tokens-reset": "2026-07-28T00:00:00Z",
			});
			res.end('{"ok":true}');
		});
		cleanups.push(upstream.close);
		const outcomes: FastModeOutcome[] = [];
		const proxy = await startFastModeProxy(upstream.url, { onOutcome: (o) => outcomes.push(o) });
		cleanups.push(proxy.close);

		await post(proxy, { model: "claude-opus-5", messages: [] }, { [MARKER_HEADER]: "claude-opus-5" });
		assert.equal(outcomes[0]?.tier, "cooldown");
		assert.equal(outcomes[0]?.evidence.reset, "2026-07-28T00:00:00Z");
	});

	it("retries clean when upstream rejects the fast-mode bits", async () => {
		const upstream = await startUpstream((_req, res, call) => {
			if (call === 1) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end('{"error":{"message":"speed: Extra inputs are not permitted"}}');
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"ok":true,"attempt":2}');
		});
		cleanups.push(upstream.close);
		const outcomes: FastModeOutcome[] = [];
		const proxy = await startFastModeProxy(upstream.url, { onOutcome: (o) => outcomes.push(o) });
		cleanups.push(proxy.close);

		const res = await post(
			proxy,
			{ model: "claude-opus-5", messages: [] },
			{ [MARKER_HEADER]: "claude-opus-5" },
		);

		// The caller sees a working turn, not a 400 it can't do anything about.
		assert.equal(res.status, 200);
		assert.equal(res.text, '{"ok":true,"attempt":2}');
		assert.equal(upstream.calls.length, 2);
		assert.equal(upstream.calls[0]?.body.speed, "fast");
		assert.equal(upstream.calls[1]?.body.speed, undefined);
		assert.equal(upstream.calls[1]?.beta, undefined);
		assert.deepEqual(
			outcomes.map((o) => [o.tier, o.retriedWithoutFastMode, o.rejectedStatus, o.status]),
			[["off", true, 400, 200]],
		);
	});

	it("passes through an error that isn't our fault", async () => {
		const upstream = await startUpstream((_req, res) => {
			res.writeHead(400, { "content-type": "application/json" });
			res.end('{"error":{"message":"max_tokens: must be >= 1"}}');
		});
		cleanups.push(upstream.close);
		const outcomes: FastModeOutcome[] = [];
		const proxy = await startFastModeProxy(upstream.url, { onOutcome: (o) => outcomes.push(o) });
		cleanups.push(proxy.close);

		const res = await post(
			proxy,
			{ model: "claude-opus-5", messages: [] },
			{ [MARKER_HEADER]: "claude-opus-5" },
		);
		assert.equal(res.status, 400);
		assert.match(res.text, /max_tokens/);
		assert.equal(upstream.calls.length, 1, "must not retry someone else's 400");
		assert.equal(outcomes[0]?.tier, "off");
	});

	it("streams straight through: outcome lands with the headers, not at the end", async () => {
		// The badge must not cost latency. If the proxy ever starts buffering
		// successful responses to inspect them, this test hangs at the barrier.
		let releaseTail: (() => void) | undefined;
		const tailReleased = new Promise<void>((resolve) => {
			releaseTail = resolve;
		});
		const upstream = await startUpstream((_req, res) => {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"anthropic-fast-input-tokens-remaining": "77",
			});
			res.write("event: message_start\ndata: {}\n\n");
			void tailReleased.then(() => {
				res.write("event: message_stop\ndata: {}\n\n");
				res.end();
			});
		});
		cleanups.push(upstream.close);

		const firstOutcome = new Promise<FastModeOutcome>((resolve) => {
			void startFastModeProxy(upstream.url, { onOutcome: resolve }).then((proxy) => {
				cleanups.push(proxy.close);
				void post(
					proxy,
					{ model: "claude-opus-5", messages: [] },
					{ [MARKER_HEADER]: "claude-opus-5" },
				);
			});
		});

		// Resolves while the upstream stream is still open.
		const outcome = await firstOutcome;
		assert.equal(outcome.tier, "on");
		releaseTail?.();
	});

	it("reports honestly when the body can't be injected", async () => {
		const upstream = await startUpstream((_req, res) => {
			res.writeHead(200, {
				"content-type": "application/json",
				"anthropic-fast-input-tokens-remaining": "10",
			});
			res.end("{}");
		});
		cleanups.push(upstream.close);
		const outcomes: FastModeOutcome[] = [];
		const proxy = await startFastModeProxy(upstream.url, { onOutcome: (o) => outcomes.push(o) });
		cleanups.push(proxy.close);

		// Marked, but the body names a model the proxy won't inject into.
		await post(
			proxy,
			{ model: "claude-sonnet-5", messages: [] },
			{ [MARKER_HEADER]: "claude-opus-5" },
		);
		assert.equal(upstream.calls[0]?.body.speed, undefined);
		assert.equal(outcomes[0]?.injected, false);
		assert.equal(outcomes[0]?.tier, "off", "fast-tier headers don't matter if we never asked");
		assert.equal(outcomes[0]?.bodyModel, "claude-sonnet-5");
	});
});
