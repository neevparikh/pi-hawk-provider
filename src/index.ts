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
} from "@mariozechner/pi-ai";

const DEFAULT_ISSUER = "https://metr.okta.com/oauth2/aus1ww3m0x41jKp3L1d8/";
const DEFAULT_CLIENT_ID = "0oa1wxy3qxaHOoGxG1d8";
const DEFAULT_AUDIENCE = "https://model-poking-3";
const DEFAULT_SCOPES = "openid profile email offline_access";
const DEFAULT_DEVICE_CODE_PATH = "v1/device/authorize";
const DEFAULT_TOKEN_PATH = "v1/token";
const DEFAULT_MIDDLEMAN_BASE_URL = "https://middleman.internal.metr.org";
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
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

interface ProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
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

interface ExtensionAPI {
	registerProvider(name: string, config: ProviderConfig): void;
}

interface HawkModelConfig {
	id: string;
	name: string;
	backend: HawkBackend;
	upstreamModel: string;
	openaiApi?: "openai-completions" | "openai-responses";
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const runtimeModels: HawkModelConfig[] = [];
const providerModels: ProviderModelConfig[] = [];

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

function getAuthFilePath(): string {
	const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir =
		typeof configuredAgentDir === "string" && configuredAgentDir.trim().length > 0
			? configuredAgentDir.trim()
			: join(homedir(), ".pi", "agent");
	return join(agentDir, "auth.json");
}

function readStoredHawkAccessToken(): string | undefined {
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
		if (type !== "oauth" || typeof access !== "string" || access.length === 0) {
			return undefined;
		}

		return access;
	} catch {
		return undefined;
	}
}

function getConfig(): HawkConfig {
	const middlemanBaseUrl = env("HAWK_MIDDLEMAN_BASE_URL", DEFAULT_MIDDLEMAN_BASE_URL).replace(/\/+$/, "");
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

function dedupeStrings(values: string[]): string[] {
	return Array.from(new Set(values));
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

function buildDiscoveredModels(permittedModelNames: string[]): HawkModelConfig[] {
	const normalized = dedupeStrings(permittedModelNames)
		.map((name) => ({ name, parsed: extractUpstreamModel(name) }))
		.filter((entry): entry is { name: string; parsed: { backend: HawkBackend; upstreamModel: string } } =>
			entry.parsed !== null,
		);

	const seen = new Set<string>();
	const models: HawkModelConfig[] = [];

	for (const entry of normalized) {
		const key = `${entry.parsed.backend}:${entry.parsed.upstreamModel}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);

		const upstreamModel = entry.parsed.upstreamModel;
		const backend = entry.parsed.backend;
		const id = upstreamModel;
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

		models.push({
			id,
			name: `${builtIn.name} (Hawk)`,
			backend,
			upstreamModel,
			openaiApi,
			reasoning: builtIn.reasoning,
			input: builtIn.input,
			contextWindow: builtIn.contextWindow,
			maxTokens: builtIn.maxTokens,
			cost: builtIn.cost,
		});
	}

	models.sort((a, b) => {
		if (a.backend !== b.backend) {
			return a.backend.localeCompare(b.backend);
		}
		return a.id.localeCompare(b.id);
	});

	return models;
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

async function fetchPermittedModelNames(accessToken: string, config: HawkConfig): Promise<string[]> {
	const url = `${config.middlemanBaseUrl}/permitted_models`;
	debugLog("Fetching permitted Hawk models", { url });
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
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

async function refreshHawkToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const config = getConfig();
	if (!credentials.refresh) {
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
			refresh_token: credentials.refresh,
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

	const accessToken = options?.apiKey ?? process.env.HAWK_ACCESS_TOKEN ?? readStoredHawkAccessToken();
	if (!accessToken) {
		throw new Error("No Hawk access token. Run /login hawk or set HAWK_ACCESS_TOKEN.");
	}

	if (modelConfig.backend === "openai") {
		const openaiApi = modelConfig.openaiApi;
		if (!openaiApi) {
			throw new Error(`No built-in OpenAI api mapping for model: ${model.id}`);
		}
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

	debugLog("Routing Hawk Anthropic request", {
		model: model.id,
		upstreamModel: modelConfig.upstreamModel,
		baseUrl: config.anthropicBaseUrl,
	});
	const anthropicModel: Model<"anthropic-messages"> = {
		...model,
		id: modelConfig.upstreamModel,
		api: "anthropic-messages",
		baseUrl: config.anthropicBaseUrl,
	};
	return streamSimpleAnthropic(anthropicModel, context, {
		...(options ?? {}),
		apiKey: accessToken,
		headers: {
			...(options?.headers ?? {}),
			Authorization: `Bearer ${accessToken}`,
		},
	});
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const config = getConfig();
	const initialAccessToken = process.env.HAWK_ACCESS_TOKEN ?? readStoredHawkAccessToken();
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

	pi.registerProvider("hawk", {
		baseUrl: config.middlemanBaseUrl,
		apiKey: "HAWK_ACCESS_TOKEN",
		api: "hawk",
		models: providerModels,
		oauth: {
			name: "Hawk",
			login: loginHawk,
			refreshToken: refreshHawkToken,
			getApiKey: (credentials: OAuthCredentials) => credentials.access,
		},
		streamSimple: streamHawk,
	});
}
