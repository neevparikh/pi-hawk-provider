# pi-hawk-provider

Pi extension that adds a `hawk` provider with:

- OAuth2 device-code login (Hawk/Okta flow)
- automatic access-token refresh using refresh token
- automatic model discovery from Hawk (`/permitted_models`) for all accessible OpenAI/Anthropic-compatible models
- model routing to Hawk middleman for:
  - OpenAI-compatible requests
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

- `HAWK_ISSUER` (default: `https://metr.okta.com/oauth2/aus1ww3m0x41jKp3L1d8/`)
- `HAWK_CLIENT_ID` (default: `0oa1wxy3qxaHOoGxG1d8`)
- `HAWK_AUDIENCE` (default: `https://model-poking-3`)
- `HAWK_SCOPES` (default: `openid profile email offline_access`)
- `HAWK_DEVICE_CODE_PATH` (default: `v1/device/authorize`)
- `HAWK_TOKEN_PATH` (default: `v1/token`)
- `HAWK_MIDDLEMAN_BASE_URL` (default: `https://middleman.internal.metr.org`)
- `HAWK_OPENAI_BASE_URL` (default: `${HAWK_MIDDLEMAN_BASE_URL}/openai/v1`)
- `HAWK_ANTHROPIC_BASE_URL` (default: `${HAWK_MIDDLEMAN_BASE_URL}/anthropic`)

## Model discovery

When a valid Hawk access token is available, the extension discovers models by POSTing to:

- `${HAWK_MIDDLEMAN_BASE_URL}/permitted_models`

and builds the provider list from permitted OpenAI/Anthropic-compatible models.

Discovery runs:

- on extension startup (if `HAWK_ACCESS_TOKEN` is set)
- after `/login hawk`
- after OAuth refresh

There is no static fallback model list. If discovery fails, no `hawk` models are registered in that process.

Run `/login hawk` again (or restart pi with a valid `HAWK_ACCESS_TOKEN`) to retry discovery.

## Troubleshooting package install

If `hawk` does not show up in `/login` after installing, force a reinstall:

```bash
pi remove git:github.com/neevparikh/pi-hawk-provider
pi install git:github.com/neevparikh/pi-hawk-provider
```

Then restart pi and run `/login`.

## Development check

```bash
npm run check
```
