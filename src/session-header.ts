/**
 * Tag every Middleman request with pi's session id.
 *
 * Middleman records `x-metr-*` request headers in its traffic log's
 * `correlation` bag, and Hawk's `/traffic` API returns them, so a person can
 * group their own requests by pi session (and find the session file a request
 * came from) without reading bodies. pi passes its session id to providers as
 * `options.sessionId`; compaction and branch-summary requests get fresh ids
 * of their own, so they show up as their own short sessions.
 */
export const SESSION_HEADER = "x-metr-session-id" as const;

export function withSessionHeader<H extends Record<string, string | null>>(
	headers: H | undefined,
	sessionId: string | undefined,
): H | Record<string, string> | undefined {
	if (!sessionId) return headers;
	return { ...(headers ?? {}), [SESSION_HEADER]: sessionId };
}
