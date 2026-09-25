/**
 * Anthropic fast-tier pricing.
 *
 * pi-ai prices every Anthropic turn at the model's standard rates; it doesn't
 * know about `speed: "fast"`. Turns the proxy *measured* as served on fast
 * tier are re-priced here.
 *
 * Multipliers are keyed by base model id (routing suffixes stripped) and come
 * from Anthropic's published fast-mode pricing, which is model-dependent:
 *   - Opus 5.5:          $8 / $40 per MTok  (standard $4 / $20)  → 2×
 *   - Opus 5, Opus 4.8:  $10 / $50 per MTok (standard $5 / $25)  → 2×
 * Prompt-caching multipliers apply on top of fast-mode rates, so cache reads
 * and writes scale by the same factor.
 *
 * Models not listed here (including explicitly opted-in `fastModeModels`)
 * have no known fast price and keep standard-rate costs.
 */
import { baseModelId } from "./model-ids.js";

export const ANTHROPIC_FAST_MODE_PRICE_MULTIPLIERS: Readonly<Record<string, number>> = {
	"claude-opus-4-8": 2,
	"claude-opus-5": 2,
	"claude-opus-5-5": 2,
};

export function anthropicFastModePriceMultiplier(modelId: string): number | undefined {
	return ANTHROPIC_FAST_MODE_PRICE_MULTIPLIERS[baseModelId(modelId)];
}

type UsageCost = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };

/** Scale an already-computed standard-rate cost in place. */
export function scaleUsageCost(cost: UsageCost, multiplier: number): void {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		cost[key] *= multiplier;
	}
}
