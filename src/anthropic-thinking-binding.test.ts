import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { createEventBus, DefaultResourceLoader, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

// Some Claude models bind signed thinking to the messages that preceded it.
// After a compaction those messages are gone, and every later request is
// rejected unless it asks for mismatched blocks to be dropped. pi-ai sends that
// only for models flagged `supportsMidConvoEffort`, so the flag has to survive
// the trip from an `extraModels` entry to the request.
it("sends thinking binding controls for an extra model that asks for them", async () => {
	const home = mkdtempSync(join(tmpdir(), "hawk-anthropic-binding-"));
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	const originalEnv = { ...process.env };
	const modelsPath = join(agentDir, "models.json");
	const requests: { body: any; beta: string | undefined }[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			if (req.url === "/permitted_models") {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(["claude-sonnet-4-5"]));
				return;
			}
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			requests.push({ body, beta: req.headers["anthropic-beta"] as string | undefined });
			res.setHeader("content-type", "text/event-stream");
			for (const event of [
				{ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: body.model,
					content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
				{ type: "content_block_stop", index: 0 },
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
		const extra = { backend: "anthropic", reasoning: true };
		writeFileSync(modelsPath, JSON.stringify({ providers: { hawk: {
			baseUrl,
			extraModels: [
				{ ...extra, id: "claude-binding", compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true } },
				{ ...extra, id: "claude-plain", compat: { forceAdaptiveThinking: true } },
			],
		} } }));
		Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agentDir, HAWK_MODELS_JSON: modelsPath,
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

		for (const id of ["claude-binding", "claude-plain"]) {
			const model = runtime.getModel("hawk", id);
			assert.ok(model);
			const reply = await runtime.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{ apiKey: "test-token", maxTokens: 64, reasoning: "medium" });
			assert.equal(reply.stopReason, "stop", reply.errorMessage);
		}
		const [binding, plain] = requests;
		assert.equal(binding.body.model, "claude-binding");
		assert.deepEqual(binding.body.thinking.block_binding, { prefix_mismatch_behavior: "drop_block" });
		assert.match(binding.beta ?? "", /thinking-binding-controls/);
		assert.equal(plain.body.model, "claude-plain");
		assert.equal(plain.body.thinking.block_binding, undefined);
		assert.doesNotMatch(plain.beta ?? "", /thinking-binding-controls/);
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
