/**
 * Upstream model-id normalization shared by the model registry (index.ts) and
 * the fast-mode gates (fast-mode-proxy.ts).
 *
 * Middleman/Hawk exposes some models under routing suffixes that don't exist
 * in pi-ai's built-in metadata tables — `claude-fable-5-data-retention` is the
 * zero-data-retention route for `claude-fable-5`, and the upstream response
 * even reports `model: "claude-fable-5"`. A suffix picks a *route*, not a
 * different model, so anything that reasons about the model itself (metadata
 * lookup, fast-tier capability) has to look past it.
 */

/** Known middleman routing suffixes. Keep longest-first so more specific
 *  suffixes win. */
export const MIDDLEMAN_MODEL_SUFFIXES = ["-data-retention"] as const;

/** The model id with a known routing suffix removed, or undefined if it
 *  carries none. Undefined (rather than the input) so callers can tell
 *  "there was a suffix" from "there wasn't" — the model picker uses it to
 *  disambiguate otherwise-identical labels. */
export function stripMiddlemanSuffix(modelId: string): string | undefined {
	for (const suffix of MIDDLEMAN_MODEL_SUFFIXES) {
		if (modelId.length > suffix.length && modelId.endsWith(suffix)) {
			return modelId.slice(0, -suffix.length);
		}
	}
	return undefined;
}

/** The underlying model id: trimmed, lowercased, routing suffix removed.
 *  Always returns something, so it's the right form to compare against a list
 *  of model ids. */
export function baseModelId(modelId: string): string {
	const normalized = modelId.trim().toLowerCase();
	return stripMiddlemanSuffix(normalized) ?? normalized;
}
