/**
 * OpenAI Codex (ChatGPT) OAuth flow for browser extensions.
 *
 * Uses the same client ID and endpoints as the CLI,
 * but replaces the local HTTP callback server with tab URL watching.
 */

import { generatePKCE, generateState, postTokenRequest, waitForOAuthRedirect } from "./browser-oauth.js";
import type { OAuthCredentials } from "./types.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const REDIRECT_HOST = "localhost:1455";
const SCOPE = "openid profile email offline_access";

/**
 * Run the OpenAI Codex OAuth login flow in the browser.
 * Opens a tab for the user to authenticate, watches for the redirect.
 * Token endpoint has CORS enabled, so no proxy needed.
 */
export async function loginOpenAICodex(): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const state = generateState();

	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPE);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", "sitegeist");

	const redirectUrl = await waitForOAuthRedirect(url.toString(), REDIRECT_HOST);

	const code = redirectUrl.searchParams.get("code");
	const returnedState = redirectUrl.searchParams.get("state");

	if (!code) throw new Error("Missing authorization code in redirect");
	if (returnedState !== state) throw new Error("OAuth state mismatch");

	// Token endpoint has CORS enabled, no proxy needed
	const tokenData = await postTokenRequest(TOKEN_URL, {
		grant_type: "authorization_code",
		client_id: CLIENT_ID,
		code,
		code_verifier: verifier,
		redirect_uri: REDIRECT_URI,
	});

	const access = tokenData.access_token as string;
	const refresh = tokenData.refresh_token as string;
	const expiresIn = tokenData.expires_in as number;

	if (!access || !refresh || typeof expiresIn !== "number") {
		throw new Error("Token response missing required fields");
	}

	return {
		providerId: "openai-codex",
		access,
		refresh,
		expires: Date.now() + expiresIn * 1000,
	};
}

/**
 * Refresh an OpenAI Codex OAuth token. No proxy needed.
 */
export async function refreshOpenAICodex(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const tokenData = await postTokenRequest(TOKEN_URL, {
		grant_type: "refresh_token",
		refresh_token: credentials.refresh,
		client_id: CLIENT_ID,
	});

	const access = tokenData.access_token as string;
	const refresh = tokenData.refresh_token as string;
	const expiresIn = tokenData.expires_in as number;

	if (!access || !refresh || typeof expiresIn !== "number") {
		throw new Error("Token refresh response missing required fields");
	}

	return {
		providerId: "openai-codex",
		access,
		refresh,
		expires: Date.now() + expiresIn * 1000,
	};
}
