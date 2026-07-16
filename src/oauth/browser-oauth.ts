/**
 * Browser-based OAuth flows for Chrome extensions.
 *
 * Instead of spawning a local HTTP server, we:
 * 1. Open the auth URL in a new tab
 * 2. Watch for the tab to redirect to localhost (which fails to load)
 * 3. Extract code/state from the URL
 * 4. Exchange the code for tokens via fetch
 */

/**
 * Open an auth URL in a new tab and wait for the redirect to a localhost URL.
 * Returns the redirect URL with code/state params.
 */
export async function waitForOAuthRedirect(authUrl: string, redirectHost: string): Promise<URL> {
	const tab = await chrome.tabs.create({ url: authUrl, active: true });
	const tabId = tab.id;
	if (!tabId) throw new Error("Failed to create auth tab");

	return new Promise<URL>((resolve, reject) => {
		const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => {
			if (updatedTabId !== tabId || !changeInfo.url) return;

			let url: URL;
			try {
				url = new URL(changeInfo.url);
			} catch {
				return;
			}

			if (url.host !== redirectHost) return;

			cleanup();
			chrome.tabs.remove(tabId).catch(() => {});
			resolve(url);
		};

		const onRemoved = (removedTabId: number) => {
			if (removedTabId !== tabId) return;
			cleanup();
			reject(new Error("Auth tab was closed before completing login"));
		};

		const cleanup = () => {
			chrome.tabs.onUpdated.removeListener(onUpdated);
			chrome.tabs.onRemoved.removeListener(onRemoved);
		};

		chrome.tabs.onUpdated.addListener(onUpdated);
		chrome.tabs.onRemoved.addListener(onRemoved);
	});
}

/**
 * Generate PKCE code verifier and challenge using Web Crypto API.
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64urlEncode(verifierBytes);

	const data = new TextEncoder().encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const challenge = base64urlEncode(new Uint8Array(hashBuffer));

	return { verifier, challenge };
}

/**
 * Generate a random state string.
 */
export function generateState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return base64urlEncode(bytes);
}

function base64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Post a JSON token request.
 */
export async function postTokenRequest(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		throw new Error(`Token request failed: ${response.status} ${await response.text()}`);
	}

	return response.json();
}
