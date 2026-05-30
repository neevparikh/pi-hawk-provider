import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	getModels,
	type Model,
	type SimpleStreamOptions,
	streamSimpleAnthropic,
	streamSimpleOpenAICompletions,
	streamSimpleOpenAIResponses,
	type ThinkingLevelMap,
} from "@mariozechner/pi-ai";
import { type FastModeProxyHandle, MARKER_HEADER as FAST_MODE_MARKER_HEADER, startFastModeProxy } from "./fast-mode-proxy.js";
import { loadState, saveState, statePath } from "./state.js";

const DEFAULT_ISSUER = "https://metr.okta.com/oauth2/aus1ww3m0x41jKp3L1d8/";
const DEFAULT_CLIENT_ID = "0oa1wxy3qxaHOoGxG1d8";
const DEFAULT_AUDIENCE = "https://model-poking-3";
const DEFAULT_SCOPES = "openid profile email offline_access";
const DEFAULT_DEVICE_CODE_PATH = "v1/device/authorize";
const DEFAULT_TOKEN_PATH = "v1/token";
const DEFAULT_MIDDLEMAN_BASE_URL = "https://middleman.prd.metr.org";
const DEFAULT_OPENAI_ROUTE = "openai/v1";
const DEFAULT_ANTHROPIC_ROUTE = "anthropic";
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const HAWK_PROVIDER_DEBUG = process.env.HAWK_PROVIDER_DEBUG === "1" || process.env.HAWK_PROVIDER_DEBUG === "true";

const SERVICE_PREFIXES = new Set(["azure", "bedrock", "vertex"]);

function debugLog(message: string, details?: unknown): void {
	if (!HAWK_PROVIDER_DEBUG) return;
	if (details !== undefined) {
		console.error(`[pi-hawk-provider] ${message}`, details);
		return;
	}
	console.error(`[pi-hawk-provider] ${message}`);
}

type HawkBackend = "openai" | "anthropic";

interface OAuthCredentials {
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
}

interface OAuthLoginCallbacks {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

interface ProviderModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

interface ProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	models?: ProviderModelConfig[];
	oauth?: {
		name: string;
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
		refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
		getApiKey(credentials: OAuthCredentials): string;
	};
	streamSimple?: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
}

/** Minimal slash-command context we need (mirrors pi-coding-agent's ExtensionCommandContext). */
interface SlashCommandContext {
	ui: {
		notify(text: string, kind?: "info" | "warning" | "error"): void;
	};
}

interface ExtensionAPI {
	registerProvider(name: string, config: ProviderConfig): void;
	/**
	 * Pi's shared event bus. Other extensions emit/listen on string channels.
	 * We use it to expose Hawk's access token to pi-cas-provider's relay
	 * contract (see `pi-cas:relay-request` handler at the bottom of this file).
	 */
	events: {
		emit(channel: string, data: unknown): void;
		on(channel: string, handler: (data: unknown) => void): () => void;
	};
	/**
	 * Register a slash command. The full pi-coding-agent type accepts
	 * `getArgumentCompletions` etc.; we only need name + description + handler
	 * for `/fast`, so the shape is reduced.
	 */
	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: (
				prefix: string,
			) => Array<{ value: string; label: string }> | null;
			handler: (args: string, ctx: SlashCommandContext) => Promise<void> | void;
		},
	): void;
}

interface HawkModelConfig {
	id: string;
	name: string;
	backend: HawkBackend;
	upstreamModel: string;
	openaiApi?: "openai-completions" | "openai-responses";
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	compat?: { forceAdaptiveThinking?: boolean };
}

const runtimeModels: HawkModelConfig[] = [];
const providerModels: ProviderModelConfig[] = [];

/**
 * Handle for the in-extension fast-mode injection proxy. Set during
 * extension load (best-effort); read by `streamHawk` to decide whether
 * to route Anthropic traffic via the proxy and whether to flip the
 * marker header. `undefined` means the proxy isn't running — fast-tier
 * models silently downgrade to standard tier in that case.
 */
let fastModeProxy: FastModeProxyHandle | undefined;

/**
 * Reference to the live `pi` API, captured at extension load so non-default
 * functions (like `streamHawk`) can publish events. Cleared if we ever wire
 * up shutdown.
 */
let piRef: ExtensionAPI | undefined;

/**
 * Global fast-mode toggle. When true, `streamHawk` sets the marker header
 * on requests for fast-mode-capable Anthropic models (Opus 4.6 / 4.7 / 4.8)
 * and the in-extension proxy injects `body.speed = "fast"` plus the
 * `fast-mode-2026-02-01` beta. Always emits as standard tier on any other
 * model regardless of this flag — the user picks the model via the model
 * picker; this flag chooses tier per-call when the model supports it.
 *
 * Initial value resolves with precedence:
 *   1. `HAWK_FAST_MODE` env var ("1"/"true" → on, "0"/"false" → off)
 *   2. Persisted preference in `~/.pi/agent/hawk-state.json` (set via `/fast on|off`)
 *   3. false
 *
 * Env wins over persisted on purpose: per-launch override without rewriting
 * the saved value. Same convention as pi-cas-provider's `PI_CAS_FAST_MODE`.
 */
let fastModeEnabled: boolean = resolveInitialFastMode();

function resolveInitialFastMode(): boolean {
	const env = process.env.HAWK_FAST_MODE;
	if (env === "1" || env === "true") return true;
	if (env === "0" || env === "false") return false;
	return loadState().fastMode === true;
}

/**
 * Channel + payload shape consumed by pi-vim's fast-mode glyph (and by any
 * other UI that wants the same indicator). Originally defined by
 * pi-cas-provider; pi-vim explicitly treats it as publisher-agnostic. We
 * mirror the payload shape here so the badge "just works" for hawk's
 * `*-fast` model variants too.
 *   { intent: boolean, actual?: "on"|"off"|"cooldown", model?: string }
 */
const FAST_MODE_BADGE_CHANNEL = "pi:fast-mode" as const;
function publishFastModeBadge(payload: {
	intent: boolean;
	actual?: "on" | "off" | "cooldown";
	model?: string;
}): void {
	const pi = piRef;
	if (!pi || typeof pi.events?.emit !== "function") return;
	pi.events.emit(FAST_MODE_BADGE_CHANNEL, payload);
}

function loadBuiltInModels(provider: string): Map<string, Model<Api>> {
	try {
		const models = getModels(provider as any) as Model<Api>[];
		return new Map(models.map((model) => [model.id, model]));
	} catch {
		return new Map();
	}
}

const builtInOpenAIModels = loadBuiltInModels("openai");
const builtInAnthropicModels = loadBuiltInModels("anthropic");

interface HawkConfig {
	issuer: string;
	clientId: string;
	audience: string;
	scopes: string;
	deviceCodePath: string;
	tokenPath: string;
	middlemanBaseUrl: string;
	openaiBaseUrl: string;
	anthropicBaseUrl: string;
	headers?: Record<string, string>;
}

interface HawkProviderOverride {
	baseUrl?: string;
	headers?: Record<string, string>;
}

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	expires_in: number;
	interval?: number;
}

interface OAuthTokenSuccess {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
}

interface OAuthTokenError {
	error: string;
	error_description?: string;
}

interface PermittedModelsResponseObject {
	models?: unknown;
}


function env(name: string, fallback: string): string {
	const value = process.env[name];
	return value && value.trim().length > 0 ? value.trim() : fallback;
}

function getAgentDirPath(): string {
	const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;
	return typeof configuredAgentDir === "string" && configuredAgentDir.trim().length > 0
		? configuredAgentDir.trim()
		: join(homedir(), ".pi", "agent");
}

function getAuthFilePath(): string {
	return join(getAgentDirPath(), "auth.json");
}

function getModelsFilePath(): string {
	return join(getAgentDirPath(), "models.json");
}

function readHawkProviderOverride(): HawkProviderOverride {
	try {
		const modelsPath = getModelsFilePath();
		if (!existsSync(modelsPath)) {
			return {};
		}

		const raw = readFileSync(modelsPath, "utf-8");
		const parsed = parseJson<unknown>(raw);
		if (!parsed || typeof parsed !== "object") {
			return {};
		}

		const providers = (parsed as Record<string, unknown>).providers;
		if (!providers || typeof providers !== "object") {
			return {};
		}

		const hawkEntry = (providers as Record<string, unknown>).hawk;
		if (!hawkEntry || typeof hawkEntry !== "object") {
			return {};
		}

		const entry = hawkEntry as Record<string, unknown>;
		const headers = entry.headers;
		const resolvedHeaders: Record<string, string> = {};
		if (headers && typeof headers === "object") {
			for (const [key, value] of Object.entries(headers)) {
				if (typeof value === "string") {
					resolvedHeaders[key] = value;
				}
			}
		}

		return {
			baseUrl: typeof entry.baseUrl === "string" && entry.baseUrl.trim().length > 0 ? entry.baseUrl.trim() : undefined,
			headers: Object.keys(resolvedHeaders).length > 0 ? resolvedHeaders : undefined,
		};
	} catch (error) {
		debugLog("Failed to read Hawk override from models.json", error);
		return {};
	}
}

function readStoredHawkCredentials(): OAuthCredentials | undefined {
	try {
		const authPath = getAuthFilePath();
		if (!existsSync(authPath)) {
			return undefined;
		}

		const raw = readFileSync(authPath, "utf-8");
		const parsed = parseJson<unknown>(raw);
		if (!parsed || typeof parsed !== "object") {
			return undefined;
		}

		const hawkEntry = (parsed as Record<string, unknown>).hawk;
		if (!hawkEntry || typeof hawkEntry !== "object") {
			return undefined;
		}

		const entry = hawkEntry as Record<string, unknown>;
		const type = entry.type;
		const access = entry.access;
		const refresh = entry.refresh;
		const expires = entry.expires;
		if (
			type !== "oauth" ||
			typeof access !== "string" ||
			access.length === 0 ||
			typeof expires !== "number" ||
			!Number.isFinite(expires)
		) {
			return undefined;
		}

		return {
			refresh: typeof refresh === "string" ? refresh : "",
			access,
			expires,
		};
	} catch {
		return undefined;
	}
}

function getConfig(): HawkConfig {
	const providerOverride = readHawkProviderOverride();
	const middlemanBaseUrl = env("HAWK_MIDDLEMAN_BASE_URL", providerOverride.baseUrl ?? DEFAULT_MIDDLEMAN_BASE_URL).replace(
		/\/+$/,
		"",
	);
	const openaiBaseUrl = env("HAWK_OPENAI_BASE_URL", `${middlemanBaseUrl}/${DEFAULT_OPENAI_ROUTE}`);
	const anthropicBaseUrl = env("HAWK_ANTHROPIC_BASE_URL", `${middlemanBaseUrl}/${DEFAULT_ANTHROPIC_ROUTE}`);

	return {
		issuer: env("HAWK_ISSUER", DEFAULT_ISSUER),
		clientId: env("HAWK_CLIENT_ID", DEFAULT_CLIENT_ID),
		audience: env("HAWK_AUDIENCE", DEFAULT_AUDIENCE),
		scopes: env("HAWK_SCOPES", DEFAULT_SCOPES),
		deviceCodePath: env("HAWK_DEVICE_CODE_PATH", DEFAULT_DEVICE_CODE_PATH),
		tokenPath: env("HAWK_TOKEN_PATH", DEFAULT_TOKEN_PATH),
		middlemanBaseUrl,
		openaiBaseUrl,
		anthropicBaseUrl,
		headers: providerOverride.headers,
	};
}

function issuerUrl(issuer: string, subpath: string): string {
	return new URL(subpath, `${issuer.replace(/\/+$/, "")}/`).toString();
}

function parseJson<T>(text: string): T {
	return JSON.parse(text) as T;
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		throw new Error("Login cancelled");
	}

	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Login cancelled"));
			},
			{ once: true },
		);
	});
}

function toProviderModelConfig(model: HawkModelConfig): ProviderModelConfig {
	return {
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

function replaceRuntimeModels(models: HawkModelConfig[]): void {
	runtimeModels.splice(0, runtimeModels.length, ...models);
	providerModels.splice(0, providerModels.length, ...models.map(toProviderModelConfig));
}

function extractUpstreamModel(name: string): { backend: HawkBackend; upstreamModel: string } | null {
	const parts = name.split("/").filter((part) => part.length > 0);
	if (parts.length === 0) {
		return null;
	}

	if (parts.length === 1) {
		const modelId = parts[0] ?? "";
		const lower = modelId.toLowerCase();
		if (lower.startsWith("claude") || lower.includes("anthropic")) {
			return { backend: "anthropic", upstreamModel: modelId };
		}
		if (
			lower.startsWith("gpt") ||
			lower.startsWith("o1") ||
			lower.startsWith("o3") ||
			lower.startsWith("o4") ||
			lower.includes("openai")
		) {
			return { backend: "openai", upstreamModel: modelId };
		}
	}

	if (parts[0] === "anthropic") {
		let rest = parts.slice(1);
		if (rest.length === 0) {
			return null;
		}
		if (rest.length > 1 && SERVICE_PREFIXES.has(rest[0] ?? "")) {
			rest = rest.slice(1);
		}
		return { backend: "anthropic", upstreamModel: rest.join("/") };
	}

	if (parts[0] === "openai") {
		let rest = parts.slice(1);
		if (rest.length === 0) {
			return null;
		}
		if (rest.length > 1 && SERVICE_PREFIXES.has(rest[0] ?? "")) {
			rest = rest.slice(1);
		}
		return { backend: "openai", upstreamModel: rest.join("/") };
	}

	if (parts[0] === "openai-api" || parts[0] === "openrouter" || parts[0] === "together" || parts[0] === "hf") {
		if (parts.length < 3) {
			return null;
		}
		// Keep full model identifier for OpenAI-compatible routing providers.
		return { backend: "openai", upstreamModel: name };
	}

	return null;
}

function findBuiltInModel(backend: HawkBackend, upstreamModel: string): Model<Api> | undefined {
	const map = backend === "openai" ? builtInOpenAIModels : builtInAnthropicModels;
	const exact = map.get(upstreamModel);
	if (exact) return exact;

	const leaf = upstreamModel.split("/").at(-1);
	if (!leaf) return undefined;
	return map.get(leaf);
}

function resolvedOpenAIApiFromBuiltIn(model: Model<Api>): "openai-completions" | "openai-responses" | undefined {
	if (model.api === "openai-responses") return "openai-responses";
	if (model.api === "openai-completions") return "openai-completions";
	return undefined;
}

/**
 * Models on which Anthropic's fast tier is available. Used as the per-turn
 * gate inside `streamHawk`: even when the global `fastModeEnabled` toggle is
 * on, we only flip the marker header on requests for these models. Anything
 * else (Sonnet, Haiku, OpenAI) silently passes through standard tier so the
 * toggle is a no-op for them.
 *
 * Kept in sync with `FAST_MODEL_PREFIXES` in `src/fast-mode-proxy.ts` —
 * those are the prefixes the proxy will inject for.
 */
function isFastModeCapableModel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return (
		id === "claude-opus-4-6" ||
		id === "claude-opus-4-7" ||
		id === "claude-opus-4-8"
	);
}

function extractPermittedModelNames(payload: unknown): string[] {
	if (Array.isArray(payload)) {
		return payload.filter((value): value is string => typeof value === "string");
	}

	if (payload && typeof payload === "object") {
		const maybeObject = payload as PermittedModelsResponseObject;
		if (Array.isArray(maybeObject.models)) {
			return maybeObject.models.filter((value): value is string => typeof value === "string");
		}
	}

	return [];
}

function buildDiscoveredModels(permittedModelNames: string[]): HawkModelConfig[] {
	const normalized = new Map<string, { backend: HawkBackend; upstreamModel: string }>();

	for (const name of permittedModelNames) {
		const parsed = extractUpstreamModel(name);
		if (!parsed) {
			continue;
		}

		const key = `${parsed.backend}:${parsed.upstreamModel}`;
		if (!normalized.has(key)) {
			normalized.set(key, {
				backend: parsed.backend,
				upstreamModel: parsed.upstreamModel,
			});
		}
	}

	const models: HawkModelConfig[] = [];

	for (const entry of normalized.values()) {
		const upstreamModel = entry.upstreamModel;
		const backend = entry.backend;
		const builtIn = findBuiltInModel(backend, upstreamModel);
		if (!builtIn) {
			debugLog("Skipping discovered model with no built-in metadata match", {
				backend,
				upstreamModel,
			});
			continue;
		}

		const openaiApi = backend === "openai" ? resolvedOpenAIApiFromBuiltIn(builtIn) : undefined;
		if (backend === "openai" && !openaiApi) {
			debugLog("Skipping discovered OpenAI model with unsupported built-in api", {
				upstreamModel,
				builtInApi: builtIn.api,
			});
			continue;
		}

		const shared = {
			backend,
			upstreamModel,
			openaiApi,
			reasoning: builtIn.reasoning,
			thinkingLevelMap: builtIn.thinkingLevelMap,
			input: builtIn.input,
			contextWindow: builtIn.contextWindow,
			maxTokens: builtIn.maxTokens,
			cost: builtIn.cost,
			// pi-ai >=0.76 gates adaptive-thinking on `compat.forceAdaptiveThinking`
			// (no longer auto-detected from id). Carry it through so streamHawk can
			// pass it to streamSimpleAnthropic; without it, Opus 4.7 rejects the
			// request with `thinking.type.enabled is not supported for this model`.
			...(builtIn.compat ? { compat: builtIn.compat } : {}),
		} satisfies Omit<HawkModelConfig, "id" | "name">;

		models.push({
			id: upstreamModel,
			name: `${builtIn.name} (Hawk)`,
			...shared,
		});

		// Fast-mode used to be exposed as a parallel `${upstreamModel}-fast`
		// model variant; replaced by the global `/fast on|off` toggle.
		// Capability check is now per-turn in `streamHawk` via
		// `isFastModeCapableModel`. Cost is reported as standard tier in the
		// picker — the `/fast on` handler warns about the ~6× multiplier.
	}

	models.sort((a, b) => {
		if (a.backend !== b.backend) {
			return a.backend.localeCompare(b.backend);
		}
		return a.id.localeCompare(b.id);
	});

	return models;
}

async function fetchPermittedModelNames(accessToken: string, config: HawkConfig): Promise<string[]> {
	const url = `${config.middlemanBaseUrl}/permitted_models`;
	debugLog("Fetching permitted Hawk models", { url });
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			...(config.headers ?? {}),
		},
		body: JSON.stringify({
			api_key: accessToken,
			only_available_models: true,
		}),
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Model discovery failed: ${response.status} ${text}`);
	}

	const payload = parseJson<unknown>(text);
	const names = extractPermittedModelNames(payload);
	debugLog("Received permitted model names", {
		count: names.length,
		sample: names.slice(0, 20),
	});
	return names;
}

async function tryDiscoverModels(accessToken: string, config: HawkConfig, onProgress?: (message: string) => void): Promise<void> {
	onProgress?.("Discovering Hawk models...");
	const names = await fetchPermittedModelNames(accessToken, config);
	const discoveredModels = buildDiscoveredModels(names);
	debugLog("Built discovered Hawk models", {
		count: discoveredModels.length,
		sample: discoveredModels.slice(0, 20).map((model) => ({
			id: model.id,
			backend: model.backend,
			upstreamModel: model.upstreamModel,
			openaiApi: model.openaiApi,
		})),
	});
	if (discoveredModels.length === 0) {
		throw new Error("No OpenAI/Anthropic-compatible models found in Hawk permitted model list");
	}
	replaceRuntimeModels(discoveredModels);
	onProgress?.(`Discovered ${discoveredModels.length} Hawk models`);
}

async function startDeviceCodeFlow(config: HawkConfig): Promise<DeviceCodeResponse> {
	const body = new URLSearchParams({
		client_id: config.clientId,
		scope: config.scopes,
	});
	if (config.audience) {
		body.set("audience", config.audience);
	}

	const response = await fetch(issuerUrl(config.issuer, config.deviceCodePath), {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: body.toString(),
	});
	const text = await response.text();

	if (!response.ok) {
		throw new Error(`Device code request failed: ${response.status} ${text}`);
	}

	const data = parseJson<DeviceCodeResponse>(text);
	if (!data.device_code || !data.user_code || !data.verification_uri || !data.expires_in) {
		throw new Error("Invalid device code response from Hawk OAuth server");
	}

	return data;
}

async function pollDeviceToken(
	config: HawkConfig,
	deviceCode: DeviceCodeResponse,
	signal?: AbortSignal,
): Promise<OAuthTokenSuccess> {
	const deadline = Date.now() + deviceCode.expires_in * 1000;
	let intervalMs = Math.max(DEFAULT_POLL_INTERVAL_MS, Math.floor((deviceCode.interval ?? 2) * 1000));

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const response = await fetch(issuerUrl(config.issuer, config.tokenPath), {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: deviceCode.device_code,
				client_id: config.clientId,
			}).toString(),
		});
		const text = await response.text();

		if (response.ok) {
			const success = parseJson<OAuthTokenSuccess>(text);
			if (!success.access_token || !success.expires_in) {
				throw new Error("Token response missing access_token or expires_in");
			}
			return success;
		}

		let error: OAuthTokenError | null = null;
		try {
			error = parseJson<OAuthTokenError>(text);
		} catch {
			error = null;
		}

		switch (error?.error) {
			case "authorization_pending":
				await abortableSleep(intervalMs, signal);
				continue;
			case "slow_down":
				intervalMs += 5000;
				await abortableSleep(intervalMs, signal);
				continue;
			case "expired_token":
				throw new Error("Device code expired. Please run /login again.");
			case "access_denied":
				throw new Error("Login denied.");
			default:
				throw new Error(`Token polling failed: ${response.status} ${error?.error_description ?? text}`);
		}
	}

	throw new Error("Login timed out before authorization completed");
}

async function loginHawk(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const config = getConfig();
	const deviceCode = await startDeviceCodeFlow(config);

	callbacks.onAuth({
		url: deviceCode.verification_uri_complete ?? deviceCode.verification_uri,
		instructions: deviceCode.verification_uri_complete
			? undefined
			: `Enter code: ${deviceCode.user_code}`,
	});
	callbacks.onProgress?.("Waiting for authorization...");

	const token = await pollDeviceToken(config, deviceCode, callbacks.signal);
	if (!token.refresh_token) {
		throw new Error("Token response did not include refresh_token");
	}

	await tryDiscoverModels(token.access_token, config, callbacks.onProgress);

	return {
		refresh: token.refresh_token,
		access: token.access_token,
		expires: Date.now() + token.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS,
	};
}

async function refreshAccessToken(config: HawkConfig, refreshToken: string): Promise<OAuthTokenSuccess> {
	if (!refreshToken) {
		throw new Error("Missing refresh token");
	}

	const response = await fetch(issuerUrl(config.issuer, config.tokenPath), {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: config.clientId,
		}).toString(),
	});
	const text = await response.text();

	if (!response.ok) {
		throw new Error(`Token refresh failed: ${response.status} ${text}`);
	}

	const token = parseJson<OAuthTokenSuccess>(text);
	if (!token.access_token || !token.expires_in) {
		throw new Error("Refresh response missing access_token or expires_in");
	}

	return token;
}

async function refreshHawkToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const config = getConfig();
	const token = await refreshAccessToken(config, credentials.refresh);

	try {
		await tryDiscoverModels(token.access_token, config);
	} catch {
		// Keep existing models if discovery fails.
	}

	return {
		refresh: token.refresh_token ?? credentials.refresh,
		access: token.access_token,
		expires: Date.now() + token.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS,
	};
}

async function getStartupAccessToken(config: HawkConfig): Promise<string | undefined> {
	const envAccessToken = process.env.HAWK_ACCESS_TOKEN?.trim();
	if (envAccessToken) {
		return envAccessToken;
	}

	const storedCredentials = readStoredHawkCredentials();
	if (!storedCredentials) {
		return undefined;
	}

	if (Date.now() < storedCredentials.expires) {
		return storedCredentials.access;
	}

	if (!storedCredentials.refresh) {
		debugLog("Stored Hawk credentials are expired and missing a refresh token");
		return undefined;
	}

	debugLog("Stored Hawk access token expired; refreshing before model discovery");
	const refreshed = await refreshAccessToken(config, storedCredentials.refresh);
	return refreshed.access_token;
}

export function streamHawk(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const config = getConfig();
	const modelConfig = runtimeModels.find((candidate) => candidate.id === model.id);
	if (!modelConfig) {
		throw new Error(`Unknown Hawk model: ${model.id}. discovered=${runtimeModels.length}`);
	}

	const accessToken = options?.apiKey ?? process.env.HAWK_ACCESS_TOKEN ?? readStoredHawkCredentials()?.access;
	if (!accessToken) {
		throw new Error("No Hawk access token. Run /login hawk or set HAWK_ACCESS_TOKEN.");
	}

	if (modelConfig.backend === "openai") {
		const openaiApi = modelConfig.openaiApi;
		if (!openaiApi) {
			throw new Error(`No built-in OpenAI api mapping for model: ${model.id}`);
		}
		// Clear the fast-mode badge: OpenAI models never participate in
		// Anthropic's fast-tier service. If a prior turn lit the glyph, this
		// turn extinguishes it.
		publishFastModeBadge({ intent: false, model: modelConfig.id });
		debugLog("Routing Hawk OpenAI request", {
			model: model.id,
			upstreamModel: modelConfig.upstreamModel,
			api: openaiApi,
			baseUrl: config.openaiBaseUrl,
		});

		if (openaiApi === "openai-responses") {
			const openaiModel: Model<"openai-responses"> = {
				...model,
				id: modelConfig.upstreamModel,
				api: "openai-responses",
				baseUrl: config.openaiBaseUrl,
			};
			return streamSimpleOpenAIResponses(openaiModel, context, {
				...(options ?? {}),
				apiKey: accessToken,
			});
		}

		const openaiModel: Model<"openai-completions"> = {
			...model,
			id: modelConfig.upstreamModel,
			api: "openai-completions",
			baseUrl: config.openaiBaseUrl,
		};
		return streamSimpleOpenAICompletions(openaiModel, context, {
			...(options ?? {}),
			apiKey: accessToken,
		});
	}

	// Route Anthropic traffic via the local fast-mode proxy when it's running.
	// The proxy injects `body.speed = "fast"` + the `fast-mode-2026-02-01`
	// beta header on requests that bear the marker header below. Non-marker
	// requests pass through unchanged, so this is also safe for non-fast
	// models. If the proxy failed to start at extension load, fall back to
	// the direct middleman URL — fast-tier models then silently downgrade to
	// standard tier (matches pre-proxy behavior).
	const modelSupportsFast = isFastModeCapableModel(modelConfig.upstreamModel);
	const useFastMode = fastModeEnabled && modelSupportsFast;

	// When the user has fast mode enabled but picked a model that doesn't
	// support it, surface a per-request warning so it's obvious why fast
	// tier isn't kicking in. Don't suppress on repeats — they may have
	// just switched models and want immediate feedback.
	if (fastModeEnabled && !modelSupportsFast) {
		console.warn(
			`[pi-hawk-provider] /fast is ON but ${modelConfig.upstreamModel} doesn't support ` +
				`Anthropic fast tier — running this turn as standard. ` +
				`Pick claude-opus-4-6, -4-7, or -4-8 to use fast mode.`,
		);
	}

	// Publish badge state for pi-vim (and any other consumer of
	// `pi:fast-mode`). When useFastMode is false we still emit so the
	// badge clears on every non-fast turn — otherwise a stale "on" from a
	// previous turn (or from pi-cas-provider in the same session) would
	// linger. When useFastMode is true we report "on" if the proxy is up
	// (injection will happen) or "off" if it isn't (silent downgrade).
	publishFastModeBadge({
		intent: useFastMode,
		actual: useFastMode ? (fastModeProxy ? "on" : "off") : undefined,
		model: modelConfig.id,
	});

	const upstreamBaseUrl = fastModeProxy?.getBaseUrl() ?? config.anthropicBaseUrl;
	if (fastModeProxy) {
		// Keep the proxy in sync if the middleman URL was rotated since startup.
		fastModeProxy.setUpstreamBaseUrl(config.anthropicBaseUrl);
	}

	debugLog("Routing Hawk Anthropic request", {
		model: model.id,
		upstreamModel: modelConfig.upstreamModel,
		fastModeEnabled,
		modelSupportsFast,
		thinkingLevelMap: modelConfig.thinkingLevelMap,
		baseUrl: upstreamBaseUrl,
		viaFastModeProxy: fastModeProxy ? true : false,
		fastModeWillBeInjected: useFastMode && !!fastModeProxy,
	});

	const anthropicModel: Model<"anthropic-messages"> = {
		...model,
		id: modelConfig.upstreamModel,
		api: "anthropic-messages",
		baseUrl: upstreamBaseUrl,
		...(modelConfig.thinkingLevelMap ? { thinkingLevelMap: modelConfig.thinkingLevelMap } : {}),
		// Required by pi-ai >=0.76 to route Opus 4.6/4.7 through adaptive thinking
		// instead of the legacy `thinking.type=enabled` shape (which Opus 4.7 rejects).
		...(modelConfig.compat ? { compat: modelConfig.compat } : {}),
	};
	return streamSimpleAnthropic(anthropicModel, context, {
		...(options ?? {}),
		apiKey: accessToken,
		// We pass `speed` through in case a future pi-ai version honors it
		// directly — harmless if dropped (current behavior). The actual
		// fast-mode activation happens in the proxy via the marker header.
		...(useFastMode ? { speed: "fast" as const } : {}),
		headers: {
			...(options?.headers ?? {}),
			Authorization: `Bearer ${accessToken}`,
			...(useFastMode && fastModeProxy ? { [FAST_MODE_MARKER_HEADER]: "1" } : {}),
		},
	});
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const config = getConfig();
	let initialAccessToken: string | undefined;
	try {
		initialAccessToken = await getStartupAccessToken(config);
	} catch (error) {
		debugLog("Failed to get startup Hawk token", error);
	}

	if (initialAccessToken) {
		try {
			await tryDiscoverModels(initialAccessToken, config);
		} catch (error) {
			debugLog("Startup model discovery failed", error);
			// Leave model list empty on startup if discovery fails.
		}
	} else {
		debugLog("No startup Hawk token found; model discovery deferred until /login");
	}

	// Capture pi reference so streamHawk can publish fast-mode badge events.
	piRef = pi;

	// Start the in-extension fast-mode injection proxy. Required for
	// `*-fast` Anthropic model variants to actually get fast tier (pi-ai
	// doesn't expose `speed: "fast"` itself). Best-effort: on failure we
	// log and continue — fast variants will silently downgrade to standard
	// tier rather than blocking the whole extension.
	const fastModeDisabled =
		process.env.HAWK_FAST_MODE_DISABLE === "1" || process.env.HAWK_FAST_MODE_DISABLE === "true";
	if (!fastModeDisabled) {
		try {
			fastModeProxy = await startFastModeProxy(config.anthropicBaseUrl);
			debugLog("Fast-mode proxy started", {
				port: fastModeProxy.port,
				baseUrl: fastModeProxy.getBaseUrl(),
				forwardingTo: config.anthropicBaseUrl,
			});
		} catch (error) {
			console.error(
				`[pi-hawk-provider] failed to start fast-mode proxy: ${
					error instanceof Error ? error.message : String(error)
				} — fast-tier models will run as standard tier`,
			);
			fastModeProxy = undefined;
		}
	} else {
		debugLog("Fast-mode proxy disabled via HAWK_FAST_MODE_DISABLE");
	}

	pi.registerProvider("hawk", {
		baseUrl: config.middlemanBaseUrl,
		apiKey: "$HAWK_ACCESS_TOKEN",
		api: "hawk",
		headers: config.headers,
		models: providerModels,
		oauth: {
			name: "Hawk",
			login: loginHawk,
			refreshToken: refreshHawkToken,
			getApiKey: (credentials: OAuthCredentials) => credentials.access,
		},
		streamSimple: streamHawk,
	});

	registerRelayListener(pi);
	registerFastModeCommand(pi);

	// Initialize the badge so any stale state from a previous publisher
	// (e.g. pi-cas-provider in the same session) gets cleared. If fast
	// mode is already enabled at launch (from env or persisted state),
	// show "muted" intent until the next request lights it as "on".
	publishFastModeBadge({ intent: fastModeEnabled });

	if (fastModeEnabled) {
		const source =
			process.env.HAWK_FAST_MODE === "1" || process.env.HAWK_FAST_MODE === "true"
				? "HAWK_FAST_MODE env"
				: "persisted preference";
		debugLog(`fast mode enabled at startup — source: ${source}`);
	}
}

function registerFastModeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("fast", {
		description: "Toggle Anthropic fast mode for hawk-routed Opus turns (on/off/status)",
		getArgumentCompletions: (prefix: string) => {
			const opts = ["on", "off", "status"];
			const matches = opts.filter((o) => o.startsWith(prefix.toLowerCase()));
			return matches.length ? matches.map((o) => ({ value: o, label: o })) : null;
		},
		handler: async (args: string, ctx: SlashCommandContext) => {
			const arg = args.trim().toLowerCase();
			let changed = false;
			if (arg === "on") {
				fastModeEnabled = true;
				changed = true;
			} else if (arg === "off") {
				fastModeEnabled = false;
				changed = true;
			}
			if (changed) {
				saveState({ fastMode: fastModeEnabled });
				publishFastModeBadge({ intent: fastModeEnabled });
			}

			const heading = changed
				? `hawk fast mode → ${fastModeEnabled ? "ON" : "off"} (saved)`
				: `hawk fast mode: ${fastModeEnabled ? "ON" : "off"}`;

			const lines: string[] = [heading];
			lines.push("  Active on claude-opus-4-6 / -4-7 / -4-8 only (other models pass through).");
			lines.push("  ~6× standard Opus pricing when billed against fast tier.");
			lines.push(`  Preference persisted to ${statePath()}.`);

			if (!fastModeProxy) {
				lines.push(
					"  ⚠︎  Fast-mode proxy not running — toggle is set but injection won't happen.",
				);
				lines.push("      (See HAWK_FAST_MODE_DISABLE env or startup log for cause.)");
			}

			if (process.env.HAWK_FAST_MODE !== undefined) {
				lines.push(
					`  Note: HAWK_FAST_MODE=${process.env.HAWK_FAST_MODE} is set; ` +
						"it overrides the saved value on next launch.",
				);
			}

			ctx.ui.notify(lines.join("\n"), changed ? "info" : "info");
		},
	});
}

/**
 * Listen for `pi-cas:relay-request` and answer with our access token +
 * Anthropic relay base URL.
 *
 * Contract is defined in pi-cas-provider/src/relay.ts. Summary:
 *   - We receive `{ requestId, preferredProvider? }` on `pi-cas:relay-request`.
 *   - If `preferredProvider` is set and isn't "hawk", we stay silent (don't
 *     even respond with ok:false — the requester is pinning a specific peer
 *     and we don't want to race with bid wars).
 *   - Otherwise we refresh the access token if needed and emit
 *     `pi-cas:relay-response` with `{ requestId, ok, provider: "hawk",
 *     baseUrl, accessToken }` or `{ ok: false, error }` on failure.
 *
 * The handler is fire-and-forget: pi.events.emit doesn't await, and the
 * requester has its own timeout, so a long refresh just means a timeout
 * on their end rather than a hung promise here.
 */
function registerRelayListener(pi: ExtensionAPI): void {
	const REQUEST_CHANNEL = "pi-cas:relay-request";
	const RESPONSE_CHANNEL = "pi-cas:relay-response";
	const PROVIDER_NAME = "hawk";

	pi.events.on(REQUEST_CHANNEL, (raw) => {
		if (!raw || typeof raw !== "object") return;
		const req = raw as { requestId?: unknown; preferredProvider?: unknown };
		if (typeof req.requestId !== "string") return;
		if (typeof req.preferredProvider === "string" && req.preferredProvider !== PROVIDER_NAME) {
			// Pinned to someone else; stay quiet.
			return;
		}
		const requestId = req.requestId;

		// Fire-and-forget the refresh + emit.
		(async () => {
			let token: string | undefined;
			let error: string | undefined;
			try {
				const config = getConfig();
				token = await getStartupAccessToken(config);
				if (!token) {
					error =
						"No Hawk access token available. Run `/login hawk` (or set HAWK_ACCESS_TOKEN).";
				}
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}

			if (!token) {
				debugLog(`Relay request ${requestId} — responding ok:false: ${error}`);
				pi.events.emit(RESPONSE_CHANNEL, {
					requestId,
					ok: false,
					provider: PROVIDER_NAME,
					error: error ?? "unknown error",
				});
				return;
			}

			// `getConfig()` is cheap; re-read so the URL reflects any env changes.
			const { anthropicBaseUrl } = getConfig();
			debugLog(`Relay request ${requestId} — responding with ${anthropicBaseUrl}`);
			pi.events.emit(RESPONSE_CHANNEL, {
				requestId,
				ok: true,
				provider: PROVIDER_NAME,
				baseUrl: anthropicBaseUrl,
				accessToken: token,
			});
		})();
	});

	debugLog("Registered pi-cas:relay-request listener");
}
