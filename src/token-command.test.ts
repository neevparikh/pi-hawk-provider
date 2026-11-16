import assert from "node:assert/strict";
import { test } from "node:test";
import {
	credentialsFromToken,
	credentialsFromTokenCommand,
	getTokenCommand,
	jwtExpiryMs,
	runTokenCommand,
	TOKEN_COMMAND_REFRESH_SENTINEL,
} from "./token-command.js";

function jwt(payload: object): string {
	const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "none" })}.${part(payload)}.sig`;
}

test("getTokenCommand reads HAWK_TOKEN_COMMAND and ignores blanks", () => {
	assert.equal(getTokenCommand({ HAWK_TOKEN_COMMAND: " hawk auth access-token " }), "hawk auth access-token");
	assert.equal(getTokenCommand({ HAWK_TOKEN_COMMAND: "  " }), undefined);
	assert.equal(getTokenCommand({}), undefined);
});

test("runTokenCommand returns the last non-empty line of stdout", async () => {
	assert.equal(await runTokenCommand("echo warning; echo tok-123; echo"), "tok-123");
});

test("runTokenCommand reports stderr when the command fails", async () => {
	await assert.rejects(runTokenCommand("echo 'run hawk login' >&2; exit 1"), /HAWK_TOKEN_COMMAND failed: run hawk login/);
});

test("runTokenCommand rejects empty output", async () => {
	await assert.rejects(runTokenCommand("true"), /printed no token/);
});

test("jwtExpiryMs reads exp and tolerates non-JWTs", () => {
	assert.equal(jwtExpiryMs(jwt({ exp: 2_000 })), 2_000_000);
	assert.equal(jwtExpiryMs(jwt({ sub: "x" })), undefined);
	assert.equal(jwtExpiryMs("opaque-token"), undefined);
	assert.equal(jwtExpiryMs("a.!!!.c"), undefined);
});

test("credentialsFromToken expires a minute before the JWT does and holds no refresh token", () => {
	const creds = credentialsFromToken(jwt({ exp: 10_000 }), 0);
	assert.deepEqual(creds, {
		refresh: TOKEN_COMMAND_REFRESH_SENTINEL,
		access: jwt({ exp: 10_000 }),
		expires: 10_000_000 - 60_000,
	});
});

test("credentialsFromToken gives an opaque token five minutes", () => {
	assert.equal(credentialsFromToken("opaque", 1_000).expires, 1_000 + 5 * 60_000);
});

test("credentialsFromTokenCommand runs the command", async () => {
	const token = jwt({ exp: 5_000 });
	const creds = await credentialsFromTokenCommand(`echo ${token}`);
	assert.equal(creds.access, token);
	assert.equal(creds.expires, 5_000_000 - 60_000);
});
