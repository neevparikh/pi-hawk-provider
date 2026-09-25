import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { createEventBus, DefaultResourceLoader, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { anthropicFastModePriceMultiplier, scaleUsageCost } from "./anthropic-fast-pricing.js";

describe("anthropicFastModePriceMultiplier", () => {
	it("uses published fast-mode rates by base model id", () => {
		assert.equal(anthropicFastModePriceMultiplier("claude-opus-5-5"), 2);
		assert.equal(anthropicFastModePriceMultiplier("claude-opus-5"), 2);
		assert.equal(anthropicFastModePriceMultiplier("claude-opus-4-8"), 2);
		assert.equal(anthropicFastModePriceMultiplier("CLAUDE-OPUS-5-5-data-retention"), 2);
	});

	it("has no price for models without a published fast rate", () => {
		assert.equal(anthropicFastModePriceMultiplier("claude-opus-4-6"), undefined);
		assert.equal(anthropicFastModePriceMultiplier("claude-sonnet-5"), undefined);
		assert.equal(anthropicFastModePriceMultiplier("claude-opus-50"), undefined);
	});

	it("scales every cost component", () => {
		const cost = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 };
		scaleUsageCost(cost, 2);
		assert.deepEqual(cost, { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 });
	});
});

it("prices measured fast Anthropic turns at fast-mode rates, and only those", async () => {
	const home = mkdtempSync(join(tmpdir(), "hawk-anthropic-fast-price-"));
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	const originalEnv = { ...process.env };
	const id = "claude-opus-5-5";
	const modelsPath = join(agentDir, "models.json");
	// Whether the fake upstream serves fast tier when asked (false = silent downgrade).
	let serveFast = true;
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			if (req.url === "/permitted_models") {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(["claude-opus-5"]));
				return;
			}
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			res.setHeader("content-type", "text/event-stream");
			if (body.speed === "fast" && serveFast) res.setHeader("anthropic-fast-input-tokens-remaining", "100");
			for (const event of [
				{ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: id,
					content: [], stop_reason: null, stop_sequence: null,
					usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 1_000_000 } } },
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 1_000_000 } },
				{ type: "message_stop" },
			]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			res.end();
		});
	});
	let loader: DefaultResourceLoader | undefined;
	try {
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const baseUrl = `http://127.0.0.1:${address.port}`;
		writeFileSync(modelsPath, JSON.stringify({ providers: { hawk: {
			baseUrl,
			extraModels: [{ id, backend: "anthropic",
				cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } }],
		} } }));
		Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
			HAWK_ACCESS_TOKEN: "test-token", HAWK_FAST_MODE: "1", HAWK_FAST_MODE_DISABLE: "0",
			HAWK_MIDDLEMAN_BASE_URL: baseUrl });
		delete process.env.HAWK_ANTHROPIC_BASE_URL;
		loader = new DefaultResourceLoader({ cwd: home, agentDir, eventBus: createEventBus(),
			settingsManager: SettingsManager.inMemory({}), noExtensions: true, noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: [resolve("src/index.ts")] });
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath,
			modelsStorePath: join(agentDir, "models-store.json") });
		for (const { name, config } of loader.getExtensions().runtime.pendingProviderRegistrations) runtime.registerProvider(name, config);
		const model = runtime.getModel("hawk", id);
		assert.ok(model);
		const cost = async () => {
			const reply = await runtime.completeSimple(model, { messages: [{ role: "user", content: "OK", timestamp: 0 }] },
				{ apiKey: "test-token", maxTokens: 16 });
			assert.equal(reply.stopReason, "stop", reply.errorMessage);
			return reply.usage.cost;
		};
		const fast = loader.getExtensions().extensions[0]!.commands.get("fast")!;
		const command = (arg: string) => fast.handler(arg,
			{ ui: { notify: () => {} } } as unknown as Parameters<typeof fast.handler>[1]);

		// 1M each of input / output / cache read at $8 / $40 / $0.40.
		const fastCost = await cost();
		assert.equal(fastCost.input, 8);
		assert.equal(fastCost.output, 40);
		assert.ok(Math.abs(fastCost.cacheRead - 0.4) < 1e-9);
		assert.ok(Math.abs(fastCost.total - 48.4) < 1e-9);

		// Asked for fast, served standard: standard price.
		serveFast = false;
		assert.ok(Math.abs((await cost()).total - 24.2) < 1e-9);

		// Toggle off: standard price.
		serveFast = true;
		await command("off");
		assert.ok(Math.abs((await cost()).total - 24.2) < 1e-9);
	} finally {
		for (const ext of loader?.getExtensions().extensions ?? []) {
			for (const handler of ext.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" });
		}
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
		process.env = originalEnv;
		rmSync(home, { recursive: true, force: true });
	}
});
