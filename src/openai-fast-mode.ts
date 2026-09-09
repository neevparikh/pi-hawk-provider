import { baseModelId } from "./model-ids.js";
import type { FastModeTier } from "./fast-mode-badge.js";

/** Deliberately opt in models individually, not all OpenAI routes. */
export const OPENAI_FAST_MODE_MODEL_IDS = ["gpt-6-astra"] as const;

export function supportsOpenAIFastMode(model: string): boolean {
	return (OPENAI_FAST_MODE_MODEL_IDS as readonly string[]).includes(baseModelId(model));
}

export function openAIFastTier(tier: unknown): FastModeTier | undefined {
	if (tier === "fast" || tier === "priority") return "on";
	if (tier === "default" || tier === "flex") return "off";
	return undefined;
}

/** The toggle owns service_tier; other request parameters keep pi's precedence. */
export function fastModeSamplingParams(
	enabled: boolean,
	model?: Record<string, unknown>,
	request?: Record<string, unknown>,
): Record<string, unknown> {
	return { ...model, ...request, service_tier: enabled ? "fast" : "default" };
}

// A single terminal event can contain all generated content. Bound observation
// memory without ever limiting, buffering, or rewriting the caller's stream.
// Oversized/malformed events are unconfirmed, not evidence of standard tier.
export const MAX_TIER_EVENT_CHARS = 2 * 1024 * 1024;

/** Request-local, byte-transparent SSE observer. No tee/clone or background reader. */
export function observeOpenAIServiceTier(baseFetch: typeof fetch = globalThis.fetch): {
	fetch: typeof fetch;
	serviceTier: () => string | undefined;
} {
	let tier: string | undefined;
	return {
		serviceTier: () => tier,
		fetch: async (input, init) => {
			// Retries belong to the same request but must not inherit evidence.
			tier = undefined;
			const response = await baseFetch(input, init);
			if (!response.ok || !response.body ||
				!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
				return response;
			}
			const decoder = new TextDecoder();
			let line = "";
			let data: string[] = [];
			let size = 0;
			let oversized = false;
			let afterCR = false;
			const finishLine = () => {
				if (line === "") {
					if (!oversized && data.length) {
						try {
							const event = JSON.parse(data.join("\n"));
							const terminal = event?.response;
							if ((event?.type === "response.completed" && terminal?.status === "completed") ||
								(event?.type === "response.incomplete" && terminal?.status === "incomplete")) {
								tier = typeof terminal.service_tier === "string" ? terminal.service_tier : undefined;
							}
						} catch { /* Observation must not break a turn. */ }
					}
					data = [];
					size = 0;
					oversized = false;
				} else if (!oversized && line.startsWith("data:")) {
					data.push(line.slice(line[5] === " " ? 6 : 5));
				}
				line = "";
			};
			const observe = (text: string) => {
				// Scan line endings, including CRLF split across network chunks.
				for (const char of text) {
					if (afterCR && char === "\n") { afterCR = false; continue; }
					afterCR = char === "\r";
					if (char === "\r" || char === "\n") {
						finishLine();
					} else {
						if (++size > MAX_TIER_EVENT_CHARS) {
							oversized = true;
							data = [];
						}
						// Keep a nonempty sentinel so an oversized line isn't mistaken
						// for the blank event delimiter.
						line = oversized ? "!" : line + char;
					}
				}
			};
			const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					observe(decoder.decode(chunk, { stream: true }));
					controller.enqueue(chunk);
				},
				flush() {
					observe(decoder.decode());
					// No delimiter means an incomplete SSE event: don't infer a tier.
				},
			}));
			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		},
	};
}
