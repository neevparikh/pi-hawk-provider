/**
 * Local HTTP forwarding proxy that injects Anthropic fast-mode opt-in bits
 * on outbound `/v1/messages` requests.
 *
 * Why this exists: pi-ai (v0.76 at time of writing) does not expose
 * `speed: "fast"` on its request body builder and does not append the
 * `fast-mode-2026-02-01` opt-in to the `anthropic-beta` header. Both bits
 * are required for the Anthropic Messages API to actually serve fast tier:
 * without the beta the server returns 400 "speed: Extra inputs are not
 * permitted"; without the body field the server runs the call on standard
 * tier and `anthropic-fast-*-tokens-*` response headers stay untouched.
 *
 * Rather than patch pi-ai (the maintainer declined that work in issue
 * #1381 with "you can create a custom provider that implements this"),
 * this module runs a tiny local proxy that pi-ai talks to instead of the
 * real middleman. For requests that carry a marker header set by
 * `streamHawk`, the proxy mutates the body and headers on the way out.
 * Non-marker requests pass through untouched, so the proxy is also fine
 * for hawk's non-fast traffic.
 *
 * Sitting in the request path also makes it the only component that can tell
 * you what actually happened, so it does two more things:
 *
 *   - **Verifies.** After the response headers land it reads Anthropic's
 *     `anthropic-fast-*-tokens-*` accounting and reports it back through
 *     `onOutcome`. "We asked for fast tier" and "the API served it" are
 *     different claims, and only the second one is worth showing a user.
 *   - **Fails safe.** If upstream rejects a request *because of* the bits we
 *     added, the original request is replayed verbatim. Turning on fast mode
 *     can cost money and can fail to be fast, but it can't break a turn.
 *
 * Modeled on pi-cas-provider/src/http-log-proxy.ts (proven pattern for a
 * local mutating proxy in this ecosystem), minus the logging and auth-
 * rewriting paths we don't need here.
 */

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import { baseModelId } from "./model-ids.js";

/** Beta opt-in token Anthropic requires alongside `body.speed = "fast"`. */
const FAST_MODE_BETA = "fast-mode-2026-02-01";

/** Marker header callers set on requests they want mutated. Its value is the
 *  *hawk* model id (`claude-opus-5`), which the proxy hands back on the
 *  outcome callback so the badge can be attributed to the right model without
 *  the caller having to correlate anything. Stripped before forwarding. */
export const MARKER_HEADER = "x-hawk-fast-mode" as const;
/** Local toggle generation, stripped alongside the model marker. */
export const GENERATION_HEADER = "x-hawk-fast-mode-generation" as const;

/**
 * Single source of truth for the models Anthropic serves fast tier on.
 *
 * Both fast-mode gates derive from this list, so enabling a new model is a
 * one-line change here rather than an edit that has to be mirrored:
 *   - `shouldInject` below — the proxy-side injection gate.
 *   - `isFastModeCapableModel` in `src/index.ts` — the per-turn gate.
 * It also drives the user-facing `/fast` strings in `src/index.ts`.
 *
 * The two gates match against this list differently on purpose; see the note
 * on each.
 */
export const FAST_MODE_MODEL_IDS = [
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
] as const;

/** What actually happened to one fast-mode request, reported after the
 *  upstream response headers arrive. This is the only place that knows the
 *  truth: the caller can see that it *asked* for fast tier, but not whether
 *  the body was mutated or whether Anthropic served it. */
export interface FastModeOutcome {
  /** Hawk model id carried on the marker header, e.g. `claude-opus-5`. */
  hawkModelId: string;
  /** Toggle generation at request dispatch, for ignoring stale badge reports. */
  generation?: number;
  /** Model id in the request body (may carry a routing suffix). */
  bodyModel: string | null;
  /** Whether `speed: "fast"` + the beta header actually went out. */
  injected: boolean;
  /** Ground truth for the badge, from the response (see `classifyFastTier`). */
  tier: "on" | "off" | "cooldown";
  /** Upstream HTTP status. */
  status: number;
  /** Set when upstream rejected the request *because of* the fast-mode bits
   *  and the proxy transparently retried without them. */
  retriedWithoutFastMode: boolean;
  /** Status of the rejected first attempt, when there was one. `status` is
   *  then the retry's. */
  rejectedStatus: number | null;
  /** Fast-tier accounting headers seen on the response (diagnostics). */
  evidence: FastTierEvidence;
}

/** Fast-tier accounting Anthropic reports back on the response.
 *
 *  Measured against the middleman on 2026-07-27 with two otherwise-identical
 *  16-token calls to `claude-opus-5` (see `readFastTierEvidence`). A call
 *  served on fast tier answers with a fast-tier bucket and *drops* the usual
 *  token rate-limit headers:
 *
 *    anthropic-fast-input-tokens-limit:      2000000
 *    anthropic-fast-input-tokens-remaining:  1929000
 *    anthropic-fast-input-tokens-reset:      2026-07-27T20:38:35Z
 *    anthropic-fast-output-tokens-{limit,remaining,reset}: ...
 *
 *  while the control call carries `anthropic-ratelimit-{input,output}-tokens-*`
 *  and no `anthropic-fast-*` header at all. So presence of the fast bucket is
 *  the tier signal, and its absence really does mean standard — that's what
 *  makes after-the-fact verification possible. */
export interface FastTierEvidence {
  /** Any `anthropic-*fast*` header present on the response. */
  present: boolean;
  /** Smallest `*-remaining` value parsed, or null if none was reported. */
  remaining: number | null;
  /** First `*-reset` value seen, or null. When the pool is empty this is when
   *  it refills. */
  reset: string | null;
  /** Matched header names, for debug logging. */
  names: string[];
  /** Every `anthropic-*` header name on the response. When `present` is false
   *  this is what tells you whether the accounting headers were genuinely
   *  absent or just renamed — the one part of this contract we don't control.
   *  Surfaced under `HAWK_PROVIDER_DEBUG=1`. */
  anthropicNames: string[];
}

export interface FastModeProxyOptions {
  /** Called once per marker-bearing request, after the upstream response
   *  headers arrive. Never throws into the proxy — exceptions are swallowed. */
  onOutcome?: (outcome: FastModeOutcome) => void;
}

export interface FastModeProxyHandle {
  /** Replacement for the upstream anthropicBaseUrl, e.g. "http://127.0.0.1:54321/anthropic". */
  getBaseUrl(): string;
  /** Update the real upstream the proxy forwards to. Safe to call at runtime. */
  setUpstreamBaseUrl(url: string): void;
  /** Stop the server. Idempotent. */
  close(): Promise<void>;
  /** Port the proxy bound to (for logging / diagnostics). */
  readonly port: number;
}

interface ParsedUpstream {
  url: URL;
  /** Path component of the original upstream, e.g. "/anthropic". Preserved in getBaseUrl(). */
  pathPrefix: string;
}

function parseUpstream(raw: string): ParsedUpstream {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`fast-mode proxy: upstream base URL must be http(s), got ${url.protocol}`);
  }
  return { url, pathPrefix: url.pathname.replace(/\/+$/, "") };
}

/**
 * Prefix match (case-insensitive), deliberately looser than the exact-match
 * gate in `isFastModeCapableModel`. This is a belt-and-braces check on the way
 * out: a request only reaches here carrying the marker header if that stricter
 * gate already approved it, so this just guards against injecting `speed` into
 * a body whose model was rewritten between the two points.
 */
export function shouldInject(bodyModel: unknown): boolean {
  if (typeof bodyModel !== "string") return false;
  const base = baseModelId(bodyModel);
  return FAST_MODE_MODEL_IDS.some((id) => base.startsWith(id));
}

/**
 * Whether Anthropic serves fast tier for this upstream model id. The
 * authoritative per-turn gate (`streamHawk` calls it before setting the marker
 * header), so it fails closed: exact match against `FAST_MODE_MODEL_IDS`,
 * never a prefix, because fast tier is ~6x standard pricing and
 * `claude-opus-50` must not sneak through on the strength of sharing a prefix
 * with `claude-opus-5`.
 *
 * Middleman *routing* suffixes are transparent, though: `-data-retention`
 * picks a zero-retention route to the same model (the upstream response even
 * reports the base id), so capability is a property of the base. Models that
 * simply aren't fast-tier models — Fable, Sonnet, Haiku, OpenAI — are still
 * excluded by the exact match on their base id.
 */
export function isFastModeCapableModelId(modelId: string): boolean {
  const base = baseModelId(modelId);
  return FAST_MODE_MODEL_IDS.some((candidate) => candidate === base);
}

/**
 * Append `fast-mode-2026-02-01` to an existing `anthropic-beta` header, or
 * create it. Preserves any prior betas (pi-ai may add interleaved-thinking
 * etc. in future versions) and dedups.
 */
function withFastModeBeta(existing: string | string[] | undefined): string {
  const flat = Array.isArray(existing) ? existing.join(",") : (existing ?? "");
  const tokens = flat
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!tokens.includes(FAST_MODE_BETA)) tokens.push(FAST_MODE_BETA);
  return tokens.join(",");
}

/**
 * Read Anthropic's fast-tier accounting off a response.
 *
 * Matched by shape (`anthropic-*` containing `fast`) rather than by exact
 * name. The observed names are `anthropic-fast-{input,output}-tokens-*`, but
 * naming is the one part of this contract we don't control, and a rename would
 * otherwise turn every verified "on" into a silent "off". Nothing that looks
 * like ordinary rate-limit accounting matches: the standard buckets are
 * `anthropic-ratelimit-*`, with no `fast` anywhere in the name.
 *
 * The response body carries the same fact a second time — `usage.speed:
 * "fast"`, absent on standard calls — but reading it would mean buffering or
 * teeing every streamed turn to inspect a field that arrives last. Headers say
 * the same thing before the first token does, for free.
 */
export function readFastTierEvidence(headers: IncomingHttpHeaders): FastTierEvidence {
  const names: string[] = [];
  const anthropicNames: string[] = [];
  let remaining: number | null = null;
  let reset: string | null = null;

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!name.startsWith("anthropic-")) continue;
    anthropicNames.push(name);
    if (!name.includes("fast")) continue;
    names.push(name);
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (value === undefined) continue;
    if (name.includes("remaining")) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        // Several token buckets may be reported (input/output). The pool that
        // runs out first is the one that decides whether fast tier is usable.
        remaining = remaining === null ? parsed : Math.min(remaining, parsed);
      }
    } else if (name.includes("reset") && reset === null) {
      reset = String(value);
    }
  }

  return {
    present: names.length > 0,
    remaining,
    reset,
    names: names.sort(),
    anthropicNames: anthropicNames.sort(),
  };
}

/**
 * Badge ground truth for one request.
 *
 *   - never injected              → "off"  (nothing was asked of the API)
 *   - injected, pool exhausted    → "cooldown"
 *   - injected, fast accounting   → "on"
 *   - injected, no fast accounting→ "off"  (silently served on standard tier)
 *
 * The last case is the one the old "the proxy is running, so we're fast"
 * assumption got wrong, and it's the case that matters: it's the difference
 * between believing you're paying 6x for speed and actually getting it.
 */
export function classifyFastTier(
  injected: boolean,
  evidence: FastTierEvidence,
): "on" | "off" | "cooldown" {
  if (!injected) return "off";
  if (!evidence.present) return "off";
  if (evidence.remaining !== null && evidence.remaining <= 0) return "cooldown";
  return "on";
}

/** Cap on the error body we buffer to decide whether upstream rejected the
 *  fast-mode bits. Error payloads are small JSON; anything larger isn't one. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Best-effort decompress so rejection detection still works when the client
 *  asked for gzip (pi-ai's fetch does). Returns "" if it can't be read. */
function decodeBody(buf: Buffer, encoding: string | string[] | undefined): string {
  const enc = (Array.isArray(encoding) ? encoding[0] : encoding)?.toLowerCase() ?? "";
  try {
    if (enc.includes("gzip")) return gunzipSync(buf).toString("utf8");
    if (enc.includes("br")) return brotliDecompressSync(buf).toString("utf8");
    if (enc.includes("deflate")) return inflateSync(buf).toString("utf8");
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Whether upstream rejected the request *because of* the bits we added, as
 * opposed to anything wrong with the caller's own request.
 *
 * Without the beta opt-in the middleman's validator answers 400 `speed: Extra
 * inputs are not permitted`; a model or route that isn't enabled for fast tier
 * can refuse the same way. Either way the caller's request was fine and it's
 * our injection that broke it — so the proxy retries it clean (see below)
 * rather than surfacing a failure the caller can't act on.
 */
export function looksLikeSpeedRejection(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  if (!body) return false;
  return /\bspeed\b/i.test(body) || /fast[-_ ]?mode/i.test(body) || /fast tier/i.test(body);
}

export async function startFastModeProxy(
  initialUpstreamBaseUrl: string,
  options: FastModeProxyOptions = {},
): Promise<FastModeProxyHandle> {
  let current = parseUpstream(initialUpstreamBaseUrl);

  const server: Server = createServer((clientReq, clientRes) => {
    // Snapshot upstream at request entry so a mid-request setUpstream doesn't
    // redirect in-flight calls.
    const upstream = current.url;
    const upstreamIsHttps = upstream.protocol === "https:";
    const upstreamRequestFn = upstreamIsHttps ? httpsRequest : httpRequest;
    const upstreamPort = upstream.port ? Number(upstream.port) : upstreamIsHttps ? 443 : 80;

    const chunks: Buffer[] = [];
    clientReq.on("data", (c: Buffer) => chunks.push(c));
    clientReq.on("end", () => {
      const reqBodyBuf = Buffer.concat(chunks);
      const marker = clientReq.headers[MARKER_HEADER];
      const hawkModelId = (Array.isArray(marker) ? marker[0] : marker)?.trim() || null;
      const wantsInject = marker !== undefined;
      const rawGeneration = clientReq.headers[GENERATION_HEADER];
      const generation = typeof rawGeneration === "string" && /^\d+$/.test(rawGeneration)
        ? Number(rawGeneration) : undefined;

      // Default: pass through unchanged.
      let outBody = reqBodyBuf;
      let injected = false;
      let bodyModel: string | null = null;

      if (wantsInject && reqBodyBuf.length > 0) {
        const ct = (clientReq.headers["content-type"] as string | undefined)?.toLowerCase() ?? "";
        if (ct.includes("application/json")) {
          try {
            const parsed = JSON.parse(reqBodyBuf.toString("utf8")) as Record<string, unknown>;
            if (typeof parsed.model === "string") bodyModel = parsed.model;
            if (shouldInject(parsed.model) && parsed.speed !== "fast") {
              parsed.speed = "fast";
              outBody = Buffer.from(JSON.stringify(parsed), "utf8");
              injected = true;
            }
          } catch {
            // Unparseable JSON — pass through unchanged rather than risk corrupting it.
          }
        }
      }

      /** Report what actually happened, once, to whoever paints the badge. */
      let reported = false;
      const report = (
        status: number,
        headers: IncomingHttpHeaders,
        didInject: boolean,
        rejectedStatus: number | null,
      ): void => {
        if (reported || !hawkModelId || !options.onOutcome) return;
        reported = true;
        const evidence = readFastTierEvidence(headers);
        try {
          options.onOutcome({
            hawkModelId,
            ...(generation !== undefined ? { generation } : {}),
            bodyModel,
            injected: didInject,
            tier: classifyFastTier(didInject, evidence),
            status,
            retriedWithoutFastMode: rejectedStatus !== null,
            rejectedStatus,
            evidence,
          });
        } catch {
          // A badge callback must never take down a request in flight.
        }
      };

      // Build outgoing headers.
      const baseHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(clientReq.headers)) {
        if (v === undefined) continue;
        const lower = k.toLowerCase();
        if (lower === "host" || lower === "connection" || lower === "content-length") continue;
        // Marker is internal — strip it so it doesn't reach upstream.
        if (lower === MARKER_HEADER || lower === GENERATION_HEADER) continue;
        baseHeaders[k] = v;
      }
      baseHeaders["host"] = upstream.host;

      /** `rejectedStatus` is the status of the attempt this one replaces, or
       *  null for a first attempt. */
      const send = (body: Buffer, withFastMode: boolean, rejectedStatus: number | null): void => {
        const outHeaders: Record<string, string | string[]> = { ...baseHeaders };
        if (body.length > 0) outHeaders["content-length"] = String(body.length);
        if (withFastMode) {
          // The middleman's strict validator rejects `speed` unless this beta
          // is in the opt-in list. See investigation in writeups / conversation
          // trace 2026-05-29.
          outHeaders["anthropic-beta"] = withFastModeBeta(outHeaders["anthropic-beta"]);
        }

        const upstreamReq = upstreamRequestFn(
          {
            method: clientReq.method,
            hostname: upstream.hostname,
            port: upstreamPort,
            // Preserve the full incoming path (already includes the upstream's
            // path prefix because pi-ai built its base URL from getBaseUrl()).
            path: clientReq.url,
            headers: outHeaders,
          },
          (upstreamRes) => {
            const status = upstreamRes.statusCode ?? 502;

            // A 4xx on an injected request *might* be upstream refusing the
            // bits we added rather than anything the caller did. Buffer the
            // (small, JSON) error body to find out before committing to it.
            // Everything else — including every successful stream — is piped
            // straight through, untouched and unbuffered.
            if (withFastMode && rejectedStatus === null && status >= 400 && status < 500) {
              const errChunks: Buffer[] = [];
              let errBytes = 0;
              let overflowed = false;
              upstreamRes.on("data", (c: Buffer) => {
                errBytes += c.length;
                if (errBytes > MAX_ERROR_BODY_BYTES) {
                  overflowed = true;
                  return;
                }
                errChunks.push(c);
              });
              upstreamRes.on("end", () => {
                const raw = Buffer.concat(errChunks);
                const text = overflowed
                  ? ""
                  : decodeBody(raw, upstreamRes.headers["content-encoding"]);
                if (looksLikeSpeedRejection(status, text)) {
                  // Our doing, and recoverable: replay the caller's original
                  // request verbatim so fast mode can never be the reason a
                  // turn fails. Worst case it runs on standard tier and the
                  // badge says so.
                  send(reqBodyBuf, false, status);
                  return;
                }
                report(status, upstreamRes.headers, withFastMode, rejectedStatus);
                clientRes.writeHead(status, upstreamRes.headers);
                clientRes.end(raw);
              });
              upstreamRes.on("error", () => {
                try {
                  clientRes.end();
                } catch {
                  // already closed
                }
              });
              return;
            }

            report(status, upstreamRes.headers, withFastMode, rejectedStatus);
            clientRes.writeHead(status, upstreamRes.headers);
            upstreamRes.pipe(clientRes);
            upstreamRes.on("error", () => {
              try {
                clientRes.end();
              } catch {
                // already closed
              }
            });
          },
        );

        upstreamReq.on("error", (err) => {
          if (!clientRes.headersSent) {
            clientRes.writeHead(502, { "content-type": "application/json" });
            clientRes.end(
              JSON.stringify({
                error: {
                  type: "fast_mode_proxy_error",
                  message: `fast-mode proxy upstream error: ${err.message}`,
                },
              }),
            );
          } else {
            try {
              clientRes.end();
            } catch {
              // already closed
            }
          }
        });

        if (body.length > 0) upstreamReq.write(body);
        upstreamReq.end();
      };

      send(outBody, injected, null);
    });

    clientReq.on("error", () => {
      // Best-effort: tear down upstream connection if client died mid-request.
      // Nothing useful to log here — caller already saw the error.
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("fast-mode proxy: failed to bind to ephemeral port");
  }
  const port = address.port;

  // Unref the listening socket so it never, by itself, keeps the Node event
  // loop alive. Without this, a headless `pi --mode json -p` run (e.g. the one
  // the subagent extension spawns) finishes the agent loop but the process
  // hangs forever, because this still-listening server is an open handle that
  // pins the loop open. Unref is safe: in-flight requests are kept alive by
  // their own ref'd client/upstream sockets, and interactive sessions are kept
  // alive by the TUI — so the proxy keeps serving normally and only stops
  // blocking exit once everything else is genuinely idle.
  server.unref();

  let closed = false;

  return {
    port,
    getBaseUrl(): string {
      // Mirror the upstream's path prefix so pi-ai's `${baseUrl}/v1/messages`
      // hits us at the same URL shape the real middleman expects.
      return `http://127.0.0.1:${port}${current.pathPrefix}`;
    },
    setUpstreamBaseUrl(url: string): void {
      current = parseUpstream(url);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
