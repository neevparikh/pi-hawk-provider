import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Take access tokens from a command instead of this extension's own OAuth
 * login. Set `HAWK_TOKEN_COMMAND` to a shell command that prints a valid
 * access token on stdout, e.g. `hawk auth access-token`. When neither it nor
 * `HAWK_ACCESS_TOKEN` is set and the `hawk` CLI is on PATH,
 * `hawk auth access-token` is used; set it to an empty string to use the
 * extension's own OAuth login instead.
 *
 * The command owns the login: the extension never starts a device-code flow
 * or uses a refresh token while it is set, so it holds nothing longer-lived
 * than the token the command printed.
 */

/** Stored in the `refresh` slot of pi's credentials; never sent anywhere. */
export const TOKEN_COMMAND_REFRESH_SENTINEL = "token-command";

const COMMAND_TIMEOUT_MS = 30_000;
/** Refresh this long before the token's own expiry. */
const EXPIRY_BUFFER_MS = 60_000;
/** Lifetime assumed for a token whose expiry can't be read. */
const OPAQUE_TOKEN_LIFETIME_MS = 5 * 60_000;

export type TokenCommandCredentials = {
	refresh: string;
	access: string;
	expires: number;
};

export const DEFAULT_TOKEN_COMMAND = "hawk auth access-token";

export function isOnPath(name: string, pathVar: string | undefined): boolean {
	return (pathVar ?? "")
		.split(delimiter)
		.filter((dir) => dir.length > 0)
		.some((dir) => {
			const candidate = join(dir, name);
			try {
				accessSync(candidate, constants.X_OK);
				return statSync(candidate).isFile();
			} catch {
				return false;
			}
		});
}

export function getTokenCommand(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.HAWK_TOKEN_COMMAND === undefined) {
		const useDefault = !env.HAWK_ACCESS_TOKEN?.trim() && isOnPath("hawk", env.PATH);
		return useDefault ? DEFAULT_TOKEN_COMMAND : undefined;
	}
	const command = env.HAWK_TOKEN_COMMAND.trim();
	return command ? command : undefined;
}

/** Run the command and return the token it printed (last non-empty line). */
export function runTokenCommand(command: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"/bin/sh",
			["-c", command],
			{ timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					const detail = stderr.trim() || error.message;
					reject(new Error(`HAWK_TOKEN_COMMAND failed: ${detail}`));
					return;
				}
				const token = stdout
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line.length > 0)
					.pop();
				if (!token) {
					reject(new Error("HAWK_TOKEN_COMMAND printed no token"));
					return;
				}
				resolve(token);
			},
		);
	});
}

/** Expiry (ms since epoch) from a JWT's `exp` claim, if the token has one. */
export function jwtExpiryMs(token: string): number | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as { exp?: unknown };
		return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined;
	} catch {
		return undefined;
	}
}

export function credentialsFromToken(token: string, now: number = Date.now()): TokenCommandCredentials {
	const expiry = jwtExpiryMs(token) ?? now + OPAQUE_TOKEN_LIFETIME_MS + EXPIRY_BUFFER_MS;
	return {
		refresh: TOKEN_COMMAND_REFRESH_SENTINEL,
		access: token,
		expires: expiry - EXPIRY_BUFFER_MS,
	};
}

export async function credentialsFromTokenCommand(command: string): Promise<TokenCommandCredentials> {
	return credentialsFromToken(await runTokenCommand(command));
}
