/**
 * State behind the fast-mode badge (`↯`) and the `/fast status` report.
 *
 * The badge's contract, inherited from pi-cas-provider and treated as
 * publisher-agnostic by pi-vim (and by pirouette's dashboard):
 *
 *   { intent: boolean, actual?: "on" | "off" | "cooldown", model?: string }
 *
 *   - `intent` is what we're asking for on this model's turns.
 *   - `actual` is what the API *did*, on the most recent turn for that model.
 *
 * `actual` is the part that has to be earned. It used to be asserted before
 * the request went out, from nothing more than "the injection proxy process is
 * alive" — which reads as a confident yellow glyph whether or not Anthropic
 * served fast tier, and could never produce the "cooldown" state the contract
 * defines. Here it's only ever set from a `FastModeOutcome`: a specific
 * request that the proxy mutated, and a specific response whose fast-tier
 * accounting it read (see `classifyFastTier`).
 *
 * Lives apart from index.ts so it can be tested without pi's runtime.
 */
import type { FastModeOutcome } from "./fast-mode-proxy.js";

export type FastModeTier = "on" | "off" | "cooldown";

export interface FastModeBadgePayload {
	intent: boolean;
	actual?: FastModeTier;
	model?: string;
}

export interface FastModeBadgeDeps {
	/** Emit onto the `pi:fast-mode` event-bus channel. */
	emit: (payload: FastModeBadgePayload) => void;
	/** User-visible warnings. Defaults to console.warn. */
	warn?: (message: string) => void;
	/** Debug log. Defaults to a no-op. */
	debug?: (message: string, details?: unknown) => void;
}

export class FastModeBadge {
	private readonly deps: Required<FastModeBadgeDeps>;
	/** Last measured tier per hawk model id. */
	private readonly tiers = new Map<string, FastModeTier>();
	/** Last payload emitted per model ("" for model-less toggle events). */
	private readonly published = new Map<string, string>();
	/** Warnings already shown; see `warnOnce`. */
	private readonly warned = new Set<string>();

	constructor(deps: FastModeBadgeDeps) {
		this.deps = {
			warn: (message: string) => console.warn(message),
			debug: () => {},
			...deps,
		};
	}

	/**
	 * Emit a badge payload, skipping exact repeats.
	 *
	 * Requests are not turns: extensions make their own model calls (auto-mode
	 * classifies every tool call on its own model), so an un-deduped publisher
	 * emits hundreds of identical "not fast" events a day — noise every
	 * consumer then has to absorb. Returns whether anything was emitted.
	 */
	publish(payload: FastModeBadgePayload): boolean {
		const key = payload.model ?? "";
		const fingerprint = JSON.stringify([payload.intent, payload.actual ?? null]);
		if (this.published.get(key) === fingerprint) return false;
		this.published.set(key, fingerprint);
		this.deps.emit(payload);
		return true;
	}

	/** Tier measured on this model's most recent successful turn, if any. */
	lastTier(model: string): FastModeTier | undefined {
		return this.tiers.get(model);
	}

	/** Measurements so far, sorted by model — for `/fast status`. */
	measurements(): Array<[string, FastModeTier]> {
		return [...this.tiers].sort(([a], [b]) => a.localeCompare(b));
	}

	/**
	 * Fold in one completed request. This is the only path allowed to claim a
	 * tier, because it's the only one holding evidence.
	 */
	recordOutcome(outcome: FastModeOutcome): void {
		this.deps.debug("fast-mode outcome", {
			model: outcome.hawkModelId,
			bodyModel: outcome.bodyModel,
			injected: outcome.injected,
			tier: outcome.tier,
			status: outcome.status,
			retriedWithoutFastMode: outcome.retriedWithoutFastMode,
			rejectedStatus: outcome.rejectedStatus,
			fastTierHeaders: outcome.evidence.names,
			remaining: outcome.evidence.remaining,
			reset: outcome.evidence.reset,
			// Only interesting when we found no fast-tier accounting: it shows
			// whether the headers were absent or merely named something else.
			...(outcome.evidence.present
				? {}
				: { anthropicResponseHeaders: outcome.evidence.anthropicNames }),
		});

		// A failed request didn't run on any tier. Calling it "off" would blame
		// fast mode for an unrelated 500 and discard the last real measurement
		// for this model. The retry path is exempt: there we know a replacement
		// request ran, and that it ran standard.
		const succeeded = outcome.status >= 200 && outcome.status < 300;
		if (!succeeded && !outcome.retriedWithoutFastMode) return;

		this.tiers.set(outcome.hawkModelId, outcome.tier);
		this.publish({ intent: true, actual: outcome.tier, model: outcome.hawkModelId });

		if (outcome.retriedWithoutFastMode) {
			this.warnOnce(
				`retry:${outcome.hawkModelId}`,
				`[pi-hawk-provider] upstream rejected the fast-mode request for ${outcome.hawkModelId} ` +
					`(HTTP ${outcome.rejectedStatus ?? outcome.status}); retried on standard tier. ` +
					`Turns still work — they just aren't fast.`,
			);
			return;
		}
		if (outcome.tier === "cooldown") {
			this.warnOnce(
				`cooldown:${outcome.hawkModelId}`,
				`[pi-hawk-provider] fast tier is on cooldown for ${outcome.hawkModelId} — the ` +
					`extra-usage pool is empty${outcome.evidence.reset ? ` (resets ${outcome.evidence.reset})` : ""}. ` +
					`Turns run on standard tier until it refills.`,
			);
			return;
		}
		if (outcome.injected && outcome.tier === "off") {
			this.warnOnce(
				`downgrade:${outcome.hawkModelId}`,
				`[pi-hawk-provider] asked for fast tier on ${outcome.hawkModelId} but the response ` +
					`carried no fast-tier accounting headers — the call ran standard (no premium charge).`,
			);
		}
	}

	/**
	 * Say something once. These warnings describe a *state* (this model has no
	 * fast tier; the pool is empty; the call was downgraded), and the code that
	 * notices runs per request, so repeating them turns one useful sentence
	 * into a wall of log. `resetWarnings()` re-arms them.
	 */
	warnOnce(key: string, message: string): void {
		if (this.warned.has(key)) return;
		this.warned.add(key);
		this.deps.warn(message);
	}

	/** Re-arm every one-shot warning. Called on `/fast on`: the situation may
	 *  have changed, and that's the moment the user wants to hear about it. */
	resetWarnings(): void {
		this.warned.clear();
	}
}
