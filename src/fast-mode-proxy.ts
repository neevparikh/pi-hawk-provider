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
 * Modeled on pi-cas-provider/src/http-log-proxy.ts (proven pattern for a
 * local mutating proxy in this ecosystem), minus the logging and auth-
 * rewriting paths we don't need here.
 */

import { createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";

/** Beta opt-in token Anthropic requires alongside `body.speed = "fast"`. */
const FAST_MODE_BETA = "fast-mode-2026-02-01";

/** Marker header callers set on requests they want mutated. Stripped before forwarding. */
export const MARKER_HEADER = "x-hawk-fast-mode" as const;

/** Only inject `speed` for these model id prefixes (case-insensitive). */
const FAST_MODEL_PREFIXES = ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"];

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

function shouldInject(bodyModel: unknown): boolean {
  if (typeof bodyModel !== "string") return false;
  const lower = bodyModel.toLowerCase();
  return FAST_MODEL_PREFIXES.some((p) => lower.startsWith(p));
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

export async function startFastModeProxy(initialUpstreamBaseUrl: string): Promise<FastModeProxyHandle> {
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
      const wantsInject = clientReq.headers[MARKER_HEADER] !== undefined;

      // Default: pass through unchanged.
      let outBody = reqBodyBuf;
      let injected = false;

      if (wantsInject && reqBodyBuf.length > 0) {
        const ct = (clientReq.headers["content-type"] as string | undefined)?.toLowerCase() ?? "";
        if (ct.includes("application/json")) {
          try {
            const parsed = JSON.parse(reqBodyBuf.toString("utf8")) as Record<string, unknown>;
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

      // Build outgoing headers.
      const outHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(clientReq.headers)) {
        if (v === undefined) continue;
        const lower = k.toLowerCase();
        if (lower === "host" || lower === "connection" || lower === "content-length") continue;
        // Marker is internal — strip it so it doesn't reach upstream.
        if (lower === MARKER_HEADER) continue;
        outHeaders[k] = v;
      }
      outHeaders["host"] = upstream.host;
      if (outBody.length > 0) outHeaders["content-length"] = String(outBody.length);

      if (injected) {
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
          clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
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

      if (outBody.length > 0) upstreamReq.write(outBody);
      upstreamReq.end();
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
