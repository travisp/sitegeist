/**
 * Browser OAuth integration for sitegeist.
 *
 * Credentials are stored as JSON strings in the provider keys store.
 * When getApiKey encounters a JSON string, it parses it as OAuthCredentials,
 * refreshes the token if expired, and returns the access token.
 */

import { loginAnthropic, refreshAnthropic } from "./anthropic.js";
import { loginGitHubCopilot, refreshGitHubCopilot } from "./github-copilot.js";
import { loginOpenAICodex, refreshOpenAICodex } from "./openai-codex.js";
import {
	type DeviceCodeCallback,
	isOAuthCredentials,
	type OAuthCredentials,
	type OAuthProviderId,
	parseOAuthCredentials,
	serializeOAuthCredentials,
} from "./types.js";

export {
	type DeviceCodeCallback,
	isOAuthCredentials,
	type OAuthCredentials,
	type OAuthProviderId,
	parseOAuthCredentials,
	serializeOAuthCredentials,
};

const OAUTH_PROVIDER_NAMES: Record<OAuthProviderId, string> = {
	anthropic: "Anthropic (Claude Pro/Max)",
	"openai-codex": "ChatGPT Plus/Pro",
	"github-copilot": "GitHub Copilot",
};

/**
 * Check if a provider supports OAuth login.
 */
export function isOAuthProvider(provider: string): provider is OAuthProviderId {
	return Object.hasOwn(OAUTH_PROVIDER_NAMES, provider);
}

/**
 * Get display name for an OAuth provider.
 */
export function getOAuthProviderName(provider: OAuthProviderId): string {
	return OAUTH_PROVIDER_NAMES[provider];
}

/**
 * Run the OAuth login flow for a provider.
 * Returns credentials to store.
 */
export async function oauthLogin(
	provider: OAuthProviderId,
	onDeviceCode: DeviceCodeCallback,
): Promise<OAuthCredentials> {
	switch (provider) {
		case "anthropic":
			return loginAnthropic();
		case "openai-codex":
			return loginOpenAICodex();
		case "github-copilot":
			return loginGitHubCopilot(onDeviceCode);
	}
}

/**
 * Refresh OAuth credentials for a provider.
 * Returns updated credentials to store.
 */
export async function oauthRefresh(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	switch (credentials.providerId) {
		case "anthropic":
			return refreshAnthropic(credentials);
		case "openai-codex":
			return refreshOpenAICodex(credentials);
		case "github-copilot":
			return refreshGitHubCopilot(credentials);
	}
}

/**
 * Resolve an API key from stored value.
 * If the value is a plain string, return it directly.
 * If it is JSON (OAuth credentials), refresh if expired and return the access token.
 * Updates storage with refreshed credentials.
 */
export async function resolveApiKey(
	storedValue: string,
	provider: string,
	storage: { set: (provider: string, value: string) => Promise<void> },
): Promise<string> {
	if (!isOAuthCredentials(storedValue)) {
		return storedValue;
	}

	let credentials = parseOAuthCredentials(storedValue);

	// Refresh if expired (or within 60s of expiry)
	if (Date.now() >= credentials.expires - 60_000) {
		credentials = await oauthRefresh(credentials);
		await storage.set(provider, serializeOAuthCredentials(credentials));
	}

	return credentials.access;
}
