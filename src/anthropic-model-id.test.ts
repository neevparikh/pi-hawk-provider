import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { createEventBus, DefaultResourceLoader, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

// Middleman reports the upstream model in `message_start` (`claude-opus-5` for
// `claude-opus-5-cvp-with-data-retention`). The assistant message must still be
// recorded under the requested id, or pi-ai treats it as another model's turn
// and replays its signed thinking as plain text.
it("replays thinking as thinking when middleman reports a different upstream model", async () => {
	const home = mkdtempSync(join(tmpdir(), "hawk-anthropic-model-id-"));
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	const originalEnv = { ...process.env };
	const id = "claude-opus-5-cvp-with-data-retention";
	const reported = "claude-opus-5";
	const modelsPath = join(agentDir, "models.json");
	const requests: any[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			if (req.url === "/permitted_models") {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(["claude-opus-5"]));
				return;
			}
			requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			res.setHeader("content-type", "text/event-stream");
			for (const event of [
				{ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: reported,
					content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
				{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pondering" } },
				{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "OK" } },
				{ type: "content_block_stop", index: 1 },
				{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
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
			extraModels: [{ id, backend: "anthropic", reasoning: true, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, compat: { forceAdaptiveThinking: true } }],
		} } }));
		Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
			HAWK_ACCESS_TOKEN: "test-token", HAWK_FAST_MODE_DISABLE: "1", HAWK_MIDDLEMAN_BASE_URL: baseUrl });
		delete process.env.HAWK_ANTHROPIC_BASE_URL;
		delete process.env.HAWK_FAST_MODE;
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

		const first = { role: "user" as const, content: "hi", timestamp: 0 };
		const reply = await runtime.completeSimple(model, { messages: [first] },
			{ apiKey: "test-token", maxTokens: 64, reasoning: "medium" });
		assert.equal(reply.stopReason, "stop", reply.errorMessage);
		assert.equal(reply.model, id);
		assert.equal(reply.responseModel, reported);

		await runtime.completeSimple(model,
			{ messages: [first, reply, { role: "user", content: "again", timestamp: 0 }] },
			{ apiKey: "test-token", maxTokens: 64, reasoning: "medium" });
		const replayed = requests[1].messages[1];
		assert.equal(replayed.role, "assistant");
		assert.deepEqual(replayed.content.map((block: { type: string }) => block.type), ["thinking", "text"]);
		assert.equal(replayed.content[0].signature, "sig-abc");
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
