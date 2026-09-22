import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { createEventBus, DefaultResourceLoader, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { FastModeBadgePayload } from "./fast-mode-badge.js";

it("routes configured Anthropic fast models through both gates and honors the live toggle", async () => {
	const home = mkdtempSync(join(tmpdir(), "hawk-anthropic-fast-"));
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	const originalEnv = { ...process.env };
	const calls: Array<{ speed?: string; model?: string; beta?: string }> = [];
	const events: FastModeBadgePayload[] = [];
	// This fixture opts in a synthetic endpoint; it does not assert real capability.
	const id = "claude-fable-5";
	const modelsPath = join(agentDir, "models.json");
	function configure(ids: unknown) {
		writeFileSync(modelsPath, JSON.stringify({ providers: { hawk: {
			fastModeModels: ids,
			extraModels: [{ id, backend: "anthropic" }],
		} } }));
	}
	configure([id]);
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
			calls.push({ model: body.model, speed: body.speed, beta: req.headers["anthropic-beta"] as string | undefined });
			res.setHeader("content-type", "text/event-stream");
			if (body.speed === "fast") res.setHeader("anthropic-fast-input-tokens-remaining", "100");
			for (const event of [
				{ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: id,
					content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
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
		Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
			HAWK_ACCESS_TOKEN: "test-token", HAWK_FAST_MODE: "1", HAWK_FAST_MODE_DISABLE: "0",
			HAWK_MIDDLEMAN_BASE_URL: `http://127.0.0.1:${address.port}` });
		delete process.env.HAWK_ANTHROPIC_BASE_URL;
		const bus = createEventBus();
		bus.on("pi:fast-mode", (event) => events.push(event as FastModeBadgePayload));
		loader = new DefaultResourceLoader({ cwd: home, agentDir, eventBus: bus,
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
		const complete = async () => {
			const reply = await runtime.completeSimple(model, { messages: [{ role: "user", content: "OK", timestamp: 0 }] },
				{ apiKey: "test-token", maxTokens: 16 });
			assert.equal(reply.stopReason, "stop", reply.errorMessage);
		};
		const fast = loader.getExtensions().extensions[0]!.commands.get("fast")!;
		const notices: string[] = [];
		const command = (arg: string) => fast.handler(arg,
			{ ui: { notify: (text: string) => notices.push(text) } } as unknown as Parameters<typeof fast.handler>[1]);
		await command("status");
		assert.ok(notices.at(-1)?.includes(id));
		await complete();
		assert.equal(calls.at(-1)?.speed, "fast");
		assert.match(calls.at(-1)?.beta ?? "", /fast-mode-2026-02-01/);
		assert.deepEqual(events.at(-1), { intent: true, actual: "on", model: id });
		await command("off");
		await complete();
		assert.equal(calls.at(-1)?.speed, undefined);
		assert.equal(events.at(-1)?.intent, false);
		await command("on");
		configure([`${id}-extra`, null, 42]);
		await complete();
		assert.equal(calls.at(-1)?.speed, undefined);
		configure([id]);
		await complete();
		assert.equal(calls.at(-1)?.speed, "fast");
		assert.deepEqual(events.at(-1), { intent: true, actual: "on", model: id });
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
