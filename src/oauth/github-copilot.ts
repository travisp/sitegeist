/**
 * GitHub Copilot OAuth flow for browser extensions.
 *
 * Uses the device code flow (same as the CLI).
 * CORS restrictions on github.com are handled by
 * declarativeNetRequest rules in the manifest.
 */

import type { DeviceCodeCallback, OAuthCredentials } from "./types.js";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
}

async function postJson(url: string, body: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		method: "POST",
		headers,
		body,
	});
	if (!response.ok) {
		throw new Error(`${response.status}: ${await response.text()}`);
	}
	return response.json() as Promise<Record<string, unknown>>;
}

async function startDeviceFlow(): Promise<DeviceCodeResponse> {
	const data = await postJson(
		DEVICE_CODE_URL,
		new URLSearchParams({
			client_id: CLIENT_ID,
			scope: "read:user",
		}).toString(),
		{
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": "GitHubCopilotChat/0.35.0",
		},
	);

	if (
		typeof data.device_code !== "string" ||
		typeof data.user_code !== "string" ||
		typeof data.verification_uri !== "string" ||
		typeof data.interval !== "number" ||
		typeof data.expires_in !== "number"
	) {
		throw new Error("Invalid device code response");
	}

	return {
		device_code: data.device_code,
		user_code: data.user_code,
		verification_uri: data.verification_uri,
		interval: data.interval,
		expires_in: data.expires_in,
	};
}

async function pollForGitHubAccessToken(
	deviceCode: string,
	intervalSeconds: number,
	expiresIn: number,
): Promise<string> {
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(1000, intervalSeconds * 1000);

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, intervalMs));

		const data = await postJson(
			ACCESS_TOKEN_URL,
			new URLSearchParams({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}).toString(),
			{
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent": "GitHubCopilotChat/0.35.0",
			},
		);

		if (typeof data.access_token === "string") {
			return data.access_token;
		}

		if (data.error === "authorization_pending") {
			continue;
		}

		if (data.error === "slow_down") {
			intervalMs = typeof data.interval === "number" && data.interval > 0 ? data.interval * 1000 : intervalMs + 5000;
			continue;
		}

		if (data.error) {
			throw new Error(
				`Device flow failed: ${data.error}${data.error_description ? `: ${data.error_description}` : ""}`,
			);
		}
	}

	throw new Error("Device flow timed out");
}

async function fetchCopilotToken(githubAccessToken: string): Promise<OAuthCredentials> {
	// api.github.com has CORS enabled, no proxy needed
	const response = await fetch(COPILOT_TOKEN_URL, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${githubAccessToken}`,
			...COPILOT_HEADERS,
		},
	});

	if (!response.ok) {
		throw new Error(`Copilot token request failed: ${response.status} ${await response.text()}`);
	}

	const data = (await response.json()) as Record<string, unknown>;

	if (typeof data.token !== "string" || typeof data.expires_at !== "number") {
		throw new Error("Invalid Copilot token response");
	}

	return {
		providerId: "github-copilot",
		// Store the GitHub access token as refresh (used to get new Copilot tokens)
		refresh: githubAccessToken,
		access: data.token,
		expires: data.expires_at * 1000 - 5 * 60 * 1000,
	};
}

/**
 * Run the GitHub Copilot device code login flow.
 * Returns a callback with the user code and verification URL.
 * The caller should display these to the user and open the verification URL.
 */
export async function loginGitHubCopilot(onDeviceCode: DeviceCodeCallback): Promise<OAuthCredentials> {
	const device = await startDeviceFlow();

	onDeviceCode({
		userCode: device.user_code,
		verificationUri: device.verification_uri,
	});

	// Open the verification URL in a new tab
	chrome.tabs.create({ url: device.verification_uri, active: true });

	const githubAccessToken = await pollForGitHubAccessToken(device.device_code, device.interval, device.expires_in);

	return fetchCopilotToken(githubAccessToken);
}

/**
 * Refresh a GitHub Copilot token.
 * The "refresh" token is the GitHub access token, used to fetch new Copilot tokens.
 * api.github.com has CORS enabled, no proxy needed.
 */
export async function refreshGitHubCopilot(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	return fetchCopilotToken(credentials.refresh);
}
