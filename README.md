# pi-hawk-provider

Pi extension that adds a `hawk` provider with:

- OAuth2 device-code login (Hawk/Okta flow)
- automatic access-token refresh using refresh token
- automatic model discovery from Hawk (`/permitted_models`) for all accessible OpenAI/Anthropic-compatible models
- model routing to Hawk middleman for:
  - OpenAI-compatible requests (chat-completions or responses, based on model)
  - Anthropic requests

## Status

MVP extension intended for local use and iteration.

## Install (local)

```bash
cd ~/repos/pi-hawk-provider
npm install
```

Run pi with the extension:

```bash
pi -e ~/repos/pi-hawk-provider/src/index.ts
```

Or install as a pi package from GitHub:

```bash
pi install git:github.com/neevparikh/pi-hawk-provider
```

## Authenticate

In pi:

```text
/login
# select: hawk
```

Credentials are stored in `~/.pi/agent/auth.json` by pi.

## Optional non-interactive auth

You can also provide a current access token directly:

```bash
export HAWK_ACCESS_TOKEN="..."
pi -e ~/repos/pi-hawk-provider/src/index.ts
```

If both OAuth and env token are available, pi credential priority rules apply.

## Configuration

All settings are optional.

The extension also reads provider-level `hawk` overrides from `~/.pi/agent/models.json` and honors:

- `baseUrl`
- `headers`

Example:

```json
{
  "providers": {
    "hawk": {
      "headers": {
        "x-middleman-priority": "high"
      }
    }
  }
}
```

- `HAWK_ISSUER` (default: `https://metr.okta.com/oauth2/aus1ww3m0x41jKp3L1d8/`)
- `HAWK_CLIENT_ID` (default: `0oa1wxy3qxaHOoGxG1d8`)
- `HAWK_AUDIENCE` (default: `https://model-poking-3`)
- `HAWK_SCOPES` (default: `openid profile email offline_access`)
- `HAWK_DEVICE_CODE_PATH` (default: `v1/device/authorize`)
- `HAWK_TOKEN_PATH` (default: `v1/token`)
- `HAWK_MIDDLEMAN_BASE_URL` (default: `https://middleman.prd.metr.org`)
- `HAWK_OPENAI_BASE_URL` (default: `${HAWK_MIDDLEMAN_BASE_URL}/openai/v1`)
- `HAWK_ANTHROPIC_BASE_URL` (default: `${HAWK_MIDDLEMAN_BASE_URL}/anthropic`)
- `HAWK_PROVIDER_DEBUG` (`1` or `true` to print discovery/routing debug logs to stderr)

## Model discovery

When a valid Hawk access token is available, the extension discovers models by POSTing to:

- `${HAWK_MIDDLEMAN_BASE_URL}/permitted_models`

and builds the provider list from permitted OpenAI/Anthropic-compatible models.

Only models that name-match pi's built-in `openai`/`anthropic` model IDs are registered. The extension reuses built-in defaults (API type, reasoning capability, input types, context window, max tokens, and cost fields).

Discovery runs:

- on extension startup (if `HAWK_ACCESS_TOKEN` is set, or an existing Hawk OAuth access token is present in `~/.pi/agent/auth.json`)
- after `/login hawk`
- after OAuth refresh

There is no static fallback model list. If discovery fails, no `hawk` models are registered in that process.

Run `/login hawk` again (or restart pi with a valid `HAWK_ACCESS_TOKEN`) to retry discovery.

## Fast mode

Use `/fast on`, `/fast off`, and `/fast status`. This is a **provider-wide preference**, shared by all agents using the same Hawk provider instance, not a per-chat setting. It is saved to `~/.pi/agent/hawk-state.json`. At startup, `HAWK_FAST_MODE=1` / `true` or `0` / `false` overrides the saved preference without rewriting it.

Supported models (including known `-data-retention` routing variants):

- **OpenAI Responses:** `gpt-6-astra`. On sends `service_tier: "fast"`; off explicitly sends `"default"` so an upstream project default cannot keep premium on. Measured fast responses cost **2× applicable standard rates**, including cache rates. Standard fallbacks are not doubled; pi's existing `priority` and `flex` pricing is left intact.
- **Anthropic:** `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5`. The loopback proxy adds `speed: "fast"` and the `fast-mode-2026-02-01` beta header. If upstream rejects the injected fields, the proxy retries without them. Responses measured as fast tier are priced at Anthropic's published fast-mode rates — **2× standard** for Opus 5.5, Opus 5 and Opus 4.8, including cache rates. Standard fallbacks and silent downgrades keep standard pricing. Models without a published fast rate (including explicit opt-ins below) are reported at standard rates, with a one-time warning.
- All other models pass through unchanged unless explicitly opted in below.

For an **Anthropic model whose endpoint you have verified supports fast tier**, add its exact upstream ID to `providers.hawk.fastModeModels` in `~/.pi/agent/models.json`. This additive allowlist does not register models or turn the provider-wide toggle on; the model must already be available and `/fast on` must be enabled. Example configuration (the shown ID is already built in):

```json
{
  "providers": {
    "hawk": {
      "baseUrl": "https://middleman.prd.metr.org",
      "fastModeModels": ["claude-opus-5"]
    }
  }
}
```

Keep your existing `baseUrl` (or another standard pi provider override) in the entry: pi does not accept an entry containing only extension-specific fields.

IDs are matched exactly after case/whitespace and known routing-suffix normalization, not as globs or prefixes. Both request gates read this setting on subsequent requests; `/fast status` includes configured IDs. Invalid entries are ignored. Only opt in verified models: fast-tier pricing is model-dependent, and opted-in models without a known fast rate are reported at standard rates. The existing response verification and retry-without-fast-mode behavior still apply. OpenAI routing is unaffected.

For supported OpenAI models, the toggle owns `samplingParams.service_tier`, overriding both model and request sampling settings. Other parameters retain pi's model-then-request precedence. Explicit `onPayload` hooks still run last and can replace the payload; badge intent reflects that final payload. Remove old hard-coded fast-tier model overrides when migrating to the toggle.

**The `↯` badge distinguishes intent from measurement.** OpenAI starts each request muted/unconfirmed. Only the terminal Responses `service_tier` confirms fast (`fast` / `priority`, yellow) or standard (`default` / `flex`, dim). Missing, malformed or oversized (>2 Mi characters) terminal events remain unconfirmed, with no provider-added premium cost estimate. Observation is request-local, bounded, byte-transparent and streaming; it neither patches global fetch nor clones the response. Failed/aborted requests do not confirm a tier. Successful length-limited responses can still report their billed tier. Measurements are independent per model, and toggling invalidates in-flight badge reports without changing their cost accounting.

Anthropic measurement still uses its response headers: the fast accounting bucket confirms fast, zero remaining shows cooldown, and absent fast accounting means standard. `/fast status` reports measurements since the last toggle.

`HAWK_FAST_MODE_DISABLE=1` skips only the Anthropic proxy; OpenAI fast mode is unaffected. `HAWK_PROVIDER_DEBUG=1` enables routing diagnostics.

## Troubleshooting package install

If `hawk` does not show up in `/login` after installing, force a reinstall:

```bash
pi remove git:github.com/neevparikh/pi-hawk-provider
pi install git:github.com/neevparikh/pi-hawk-provider
```

Then restart pi and run `/login`.

## Development check

```bash
npm run check   # tsc --noEmit
npm test        # node:test; loopback proxy + offline pi SDK integration tests
```
