/**
 * `/permitted_models` only answers a person's own login. A delegated token,
 * such as the one a restricted `hawk` login issues, gets 401 there but may
 * read `/permitted_models_info`, which lists the same models with details.
 */

/** Names of the live models in a `/permitted_models_info` response. */
export function namesFromModelInfo(payload: unknown): string[] {
	if (!Array.isArray(payload)) return [];
	const names: string[] = [];
	for (const entry of payload) {
		if (!entry || typeof entry !== "object") continue;
		const { name, dead } = entry as { name?: unknown; dead?: unknown };
		if (typeof name === "string" && name.length > 0 && dead !== true) names.push(name);
	}
	return names;
}

export function shouldTryModelInfo(status: number): boolean {
	return status === 401 || status === 403;
}
