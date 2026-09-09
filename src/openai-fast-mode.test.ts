import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEventBus, DefaultResourceLoader, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fastModeSamplingParams, MAX_TIER_EVENT_CHARS, observeOpenAIServiceTier, openAIFastTier, supportsOpenAIFastMode } from "./openai-fast-mode.js";
import type { FastModeBadgePayload } from "./fast-mode-badge.js";

const encoder = new TextEncoder();
function terminal(tier?: string, type = "response.completed", status = "completed") {
	return `data: ${JSON.stringify({ type, response: {
		id: "response-test", status, service_tier: tier, output: [],
		...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
		usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120,
			input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 } },
	} })}\n\n`;
}
function sse(text: string, chunkSize = 8192) {
	const bytes = encoder.encode(text);
	let offset = 0;
	return new Response(new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) return controller.close();
			controller.enqueue(bytes.slice(offset, offset += chunkSize));
		},
	}), { headers: { "content-type": "text/event-stream", "x-test": "preserved" } });
}

describe("OpenAI tier observation", () => {
	it("allowlists Astra and known routing variants, not arbitrary GPT models", () => {
		for (const id of ["gpt-6-astra", "GPT-6-ASTRA", "gpt-6-astra-data-retention"]) assert.ok(supportsOpenAIFastMode(id));
		for (const id of ["gpt-5.5", "gpt-6-astra-pro", "claude-opus-5"]) assert.ok(!supportsOpenAIFastMode(id));
		assert.equal(openAIFastTier("priority"), "on");
		assert.equal(openAIFastTier("auto"), undefined);
	});

	it("owns only the tier, preserving model then request sampling precedence", () => {
		assert.deepEqual(fastModeSamplingParams(false, { a: 1, b: 1, service_tier: "fast" }, { b: 2, service_tier: "priority" }),
			{ a: 1, b: 2, service_tier: "default" });
	});

	it("preserves bytes and headers across single-byte UTF-8 / CRLF boundaries", async () => {
		const text = (': keepalive\ndata: {"type":"response.output_text.delta","delta":"⚡"}\n\n' + terminal("fast")).replaceAll("\n", "\r\n");
		const observer = observeOpenAIServiceTier(async () => sse(text, 1));
		const response = await observer.fetch("https://example.test/responses");
		assert.equal(observer.serviceTier(), undefined);
		assert.equal(response.headers.get("x-test"), "preserved");
		assert.equal(await response.text(), text);
		assert.equal(observer.serviceTier(), "fast");
	});

	it("accepts multiline data and bare CR delimiters", async () => {
		const text = 'event: response.completed\rdata: {"type":"response.completed",\rdata: "response":{"status":"completed","service_tier":"default"}}\r\r';
		const observer = observeOpenAIServiceTier(async () => sse(text, 3));
		await (await observer.fetch("https://example.test")).text();
		assert.equal(observer.serviceTier(), "default");
	});

	it("does not infer evidence from created, failed, truncated, malformed or HTTP error responses", async () => {
		for (const response of [sse(terminal("fast", "response.created", "in_progress")), sse(terminal("fast", "response.failed", "failed")),
			sse(terminal("fast").trimEnd()), sse('data: invalid\n\n'), new Response(terminal("fast"), { status: 500 })]) {
			const observer = observeOpenAIServiceTier(async () => response);
			await (await observer.fetch("https://example.test")).text();
			assert.equal(observer.serviceTier(), undefined);
		}
	});

	it("bounds oversized events and recovers at the next delimiter", async () => {
		const huge = 'data: {"padding":"' + 'x'.repeat(MAX_TIER_EVENT_CHARS) + '","type":"response.completed","response":{"status":"completed","service_tier":"fast"}}\n\n';
		const observer = observeOpenAIServiceTier(async () => sse(huge + terminal("default")));
		await (await observer.fetch("https://example.test")).text();
		assert.equal(observer.serviceTier(), "default");
	});

	it("propagates cancellation without an eager clone or background reader", async () => {
		let cancelled = false;
		let pulls = 0;
		const observer = observeOpenAIServiceTier(async () => new Response(new ReadableStream({
			pull(controller) { pulls++; controller.enqueue(encoder.encode(": ping\n\n")); },
			cancel() { cancelled = true; },
		}), { headers: { "content-type": "text/event-stream" } }));
		const response = await observer.fetch("https://example.test");
		await new Promise((r) => setTimeout(r, 5));
		assert.ok(pulls <= 2, `unbounded read ahead: ${pulls}`);
		const reader = response.body!.getReader();
		await reader.read();
		await reader.cancel();
		await new Promise((r) => setTimeout(r, 0));
		assert.ok(cancelled);
		assert.equal(observer.serviceTier(), undefined);
	});

	it("propagates read errors and isolates parallel requests", async () => {
		const broken = observeOpenAIServiceTier(async () => new Response(new ReadableStream({
			pull(controller) { controller.error(new Error("broken stream")); },
		}), { headers: { "content-type": "text/event-stream" } }));
		await assert.rejects((await broken.fetch("https://example.test")).text(), /broken stream/);
		assert.equal(broken.serviceTier(), undefined);
		await Promise.all(["fast", "default"].map(async (tier) => {
			const observer = observeOpenAIServiceTier(async () => sse(terminal(tier), 7));
			await (await observer.fetch("https://example.test")).text();
			assert.equal(observer.serviceTier(), tier);
		}));
	});
});

describe("provider integration with pi's real extension loader and Responses parser", () => {
	let home: string;
	let loader: DefaultResourceLoader;
	let runtime: ModelRuntime;
	let originalFetch: typeof fetch;
	let originalEnv: NodeJS.ProcessEnv;
	let events: FastModeBadgePayload[];
	let notices: string[];
	const context = { messages: [{ role: "user" as const, content: "OK", timestamp: 0 }] };

	async function command(args: string) {
		const fast = loader.getExtensions().extensions[0]!.commands.get("fast")!;
		await fast.handler(args, { ui: { notify: (text: string) => notices.push(text) } } as unknown as Parameters<typeof fast.handler>[1]);
	}
	function model(id = "gpt-6-astra") {
		const m = runtime.getModel("hawk", id);
		assert.ok(m, `missing model ${id}`);
		return { ...m, cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
			samplingParams: { service_tier: "priority", metadata: { test: "model" } } };
	}
	async function complete(tier: string | undefined, options: SimpleStreamOptions = {}, id?: string) {
		return runtime.completeSimple(model(id), context, {
			apiKey: "test-token", reasoning: "low", maxTokens: 32,
			fetch: async () => sse(terminal(tier), 17), ...options,
		});
	}
	before(async () => {
		home = mkdtempSync(join(tmpdir(), "hawk-fast-test-"));
		originalEnv = { ...process.env };
		originalFetch = globalThis.fetch;
		Object.assign(process.env, { HOME: home, HAWK_ACCESS_TOKEN: "test-token", HAWK_FAST_MODE_DISABLE: "1", PI_OFFLINE: "1" });
		delete process.env.HAWK_FAST_MODE;
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "hawk-state.json"), JSON.stringify({ fastMode: true, preserved: "yes" }));
		globalThis.fetch = async (input) => {
			assert.match(String(input), /\/permitted_models$/);
			return Response.json(["gpt-6-astra", "gpt-6-astra-data-retention", "gpt-5.4", "claude-opus-5"]);
		};
		const bus = createEventBus();
		events = [];
		notices = [];
		bus.on("pi:fast-mode", (data) => events.push(data as FastModeBadgePayload));
		loader = new DefaultResourceLoader({ cwd: home, agentDir: join(home, ".pi", "agent"), eventBus: bus,
			settingsManager: SettingsManager.inMemory({}), noExtensions: true, noSkills: true, noPromptTemplates: true,
			noThemes: true, noContextFiles: true, additionalExtensionPaths: [resolve("src/index.ts")] });
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: join(home, "models.json"),
			modelsStorePath: join(home, "models-store.json"), refreshOnCreate: false });
		for (const { name, config } of loader.getExtensions().runtime.pendingProviderRegistrations) runtime.registerProvider(name, config);
		assert.deepEqual(events.at(-1), { intent: true });
	});
	after(() => {
		globalThis.fetch = originalFetch;
		process.env = originalEnv;
		rmSync(home, { recursive: true, force: true });
	});
	beforeEach(async () => { await command("on"); events.length = 0; notices.length = 0; });

	it("sends fast, preserves payload hooks/headers and corrects all cost components exactly once", async () => {
		let request: Record<string, unknown> | undefined;
		let sawResponse = false;
		const result = await complete("fast", {
			samplingParams: { metadata: { test: "request" } },
			onPayload: (body) => { request = body as Record<string, unknown>; },
			onResponse: ({ headers }) => { sawResponse = headers["x-test"] === "preserved"; },
		});
		assert.equal(request?.service_tier, "fast");
		assert.deepEqual(request?.metadata, { test: "request" });
		assert.ok(sawResponse);
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(events, [{ intent: true, model: "gpt-6-astra" }, { intent: true, actual: "on", model: "gpt-6-astra" }]);
		const { cost } = result.usage;
		assert.ok(Math.abs(cost.input - 0.0012) < 1e-12);
		assert.equal(cost.output, 0.002);
		assert.ok(Math.abs(cost.cacheRead - 0.00006) < 1e-12);
		assert.equal(cost.cacheWrite, 0.00025);
		assert.equal(cost.total, cost.input + cost.output + cost.cacheRead + cost.cacheWrite);
	});

	it("streams text and tool arguments before terminal tier evidence arrives", async () => {
		const item = { type: "function_call", id: "fc_test", call_id: "call_test", name: "lookup", arguments: "" };
		const encodeEvent = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const stream = runtime.streamSimple(model(), context, {
			apiKey: "test-token", reasoning: "low",
			fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(c) {
				controller = c;
				c.enqueue(encoder.encode([
					{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_test", role: "assistant", content: [] } },
					{ type: "response.output_text.delta", output_index: 0, delta: "Hello" },
					{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_test", role: "assistant", content: [{ type: "output_text", text: "Hello" }] } },
					{ type: "response.output_item.added", output_index: 1, item },
					{ type: "response.function_call_arguments.delta", output_index: 1, delta: '{"key":"value"}' },
					{ type: "response.output_item.done", output_index: 1, item: { ...item, arguments: '{"key":"value"}' } },
				].map(encodeEvent).join("")));
			} }), { headers: { "content-type": "text/event-stream" } }),
		});
		const types: string[] = [];
		for await (const event of stream) {
			types.push(event.type);
			if (event.type === "toolcall_end") {
				assert.equal(events.at(-1)?.actual, undefined);
				assert.deepEqual(event.toolCall.arguments, { key: "value" });
				controller.enqueue(encoder.encode(terminal("fast")));
				controller.close();
			}
		}
		assert.ok(types.includes("text_delta"));
		assert.ok(types.includes("toolcall_delta"));
		const result = await stream.result();
		assert.equal(result.stopReason, "toolUse");
		assert.equal(result.content[0]?.type, "text");
		assert.equal(events.at(-1)?.actual, "on");
	});

	it("rebases fast pricing on applicable long-context rates", async () => {
		const m = model();
		const result = await runtime.completeSimple({ ...m, cost: { ...m.cost,
			tiers: [{ inputTokensAbove: 50, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
		} }, context, { apiKey: "test-token", reasoning: "low", fetch: async () => sse(terminal("fast")) });
		assert.ok(Math.abs(result.usage.cost.input - 0.0024) < 1e-12);
	});

	it("uses actual tier for standard fallback and avoids doubling pi's priority / flex pricing", async () => {
		const standard = await complete("default");
		assert.deepEqual(events.at(-1), { intent: true, actual: "off", model: "gpt-6-astra" });
		for (const [tier, multiplier] of [["priority", 2], ["fast", 2], ["flex", 0.5]] as const) {
			const result = await complete(tier);
			assert.equal(result.usage.cost.total, standard.usage.cost.total * multiplier);
		}
	});

	it("off beats static model and request tier overrides and persists without deleting other state", async () => {
		await command("off");
		let requested: unknown;
		await complete("default", { samplingParams: { service_tier: "fast" }, onPayload: (body) => { requested = body; } });
		assert.equal((requested as { service_tier: string }).service_tier, "default");
		assert.equal(events.at(-1)?.intent, false);
		assert.deepEqual(JSON.parse(readFileSync(join(home, ".pi", "agent", "hawk-state.json"), "utf8")), { fastMode: false, preserved: "yes" });
		await command("status");
		assert.match(notices.at(-1)!, /Provider-wide/);
		assert.match(notices.at(-1)!, /OpenAI is unaffected/);
		await loader.reload();
		assert.deepEqual(events.at(-1), { intent: false });
		// A fresh registration uses the newly loaded toggle as well.
		for (const { name, config } of loader.getExtensions().runtime.pendingProviderRegistrations) runtime.registerProvider(name, config);
		await complete("default", { onPayload: (body) => { requested = body; } });
		assert.equal((requested as { service_tier: string }).service_tier, "default");
	});

	it("environment overrides the saved preference only at startup", async () => {
		process.env.HAWK_FAST_MODE = "0";
		await loader.reload();
		assert.deepEqual(events.at(-1), { intent: false });
		assert.equal(JSON.parse(readFileSync(join(home, ".pi", "agent", "hawk-state.json"), "utf8")).fastMode, true);
		delete process.env.HAWK_FAST_MODE;
		for (const { name, config } of loader.getExtensions().runtime.pendingProviderRegistrations) runtime.registerProvider(name, config);
	});

	it("keeps missing service_tier unknown, never charging premium from intent", async () => {
		await complete("fast");
		const unknown = await complete(undefined);
		const standard = await complete("default");
		assert.ok(events.some((event) => event.intent && event.actual === undefined));
		assert.equal(unknown.usage.cost.total, standard.usage.cost.total);
	});

	it("does not relight after off/on invalidates an in-flight request", async () => {
		let release!: () => void;
		let started!: () => void;
		const waiting = new Promise<void>((r) => { started = r; });
		const pending = complete("fast", { fetch: async () => {
			started(); await new Promise<void>((r) => { release = r; }); return sse(terminal("fast"));
		} });
		await waiting;
		await command("off");
		await command("on");
		events.length = 0;
		release();
		const result = await pending;
		assert.equal(result.stopReason, "stop");
		assert.equal(events.length, 0);
		await complete("fast");
		assert.equal(events.at(-1)?.actual, "on");
	});

	it("attributes concurrent routing variants independently and leaves unsupported models untouched", async () => {
		await Promise.all([complete("fast"), complete("default", {}, "gpt-6-astra-data-retention")]);
		assert.ok(events.some((e) => e.model === "gpt-6-astra" && e.actual === "on"));
		assert.ok(events.some((e) => e.model === "gpt-6-astra-data-retention" && e.actual === "off"));
		let tier: unknown;
		await complete("priority", { onPayload: (body) => { tier = (body as { service_tier: string }).service_tier; } }, "gpt-5.4");
		assert.equal(tier, "priority");
		assert.deepEqual(events.at(-1), { intent: false, model: "gpt-5.4" });
	});

	it("allows explicit final payload hooks and reflects their requested tier", async () => {
		await complete("default", { onPayload: (body) => ({ ...(body as object), service_tier: "default" }) });
		assert.deepEqual(events.at(-1), { intent: false, actual: "off", model: "gpt-6-astra" });
	});

	it("prices a measured length-limited response but never confirms HTTP errors or aborts", async () => {
		const length = await complete("fast", { fetch: async () => sse(terminal("fast", "response.incomplete", "incomplete")) });
		assert.equal(length.stopReason, "length");
		assert.equal(events.at(-1)?.actual, "on");
		for (const options of [
			{ fetch: async () => new Response('{"error":{"message":"unavailable"}}', { status: 500 }), maxRetries: 0 },
			{ signal: AbortSignal.abort() },
			{ fetch: async () => sse(terminal("fast", "response.failed", "failed")) },
		] satisfies SimpleStreamOptions[]) {
			await command("on"); events.length = 0;
			const result = await complete("fast", options);
			assert.ok(["error", "aborted"].includes(result.stopReason));
			assert.ok(events.every((e) => e.actual === undefined));
		}
	});
});
