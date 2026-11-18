/**
 * pi-ai's built-in catalog lists refusal-fallback models for some Anthropic
 * models (`compat.allowedFallbackModels`), which pi-ai sends as `fallbacks`.
 * Middleman may route a Hawk model and its catalog fallbacks through different
 * accounts, and Anthropic rejects such requests ("fallbacks: models must use
 * the same lab and account as model"), so drop them from built-in compat.
 */
export function withoutRefusalFallbacks<T extends object>(compat: T): Omit<T, "allowedFallbackModels"> {
	const { allowedFallbackModels: _dropped, ...rest } = compat as T & { allowedFallbackModels?: unknown };
	return rest;
}
