import { createOverlayScript, removeOverlayScript } from "./overlay-content.js";

const OVERLAY_WORLD_ID = "sitegeist-repl-overlay";
const overlayRuns = new Map<number, string>();

export function ownsOverlayRun(runId: unknown): boolean {
	return typeof runId === "string" && [...overlayRuns.values()].includes(runId);
}

/**
 * Inject the REPL overlay into a specific tab.
 * @param tabId - ID of the tab to inject into
 * @param taskName - Name of the task being executed (shown in overlay)
 */
export async function injectOverlay(tabId: number, taskName: string): Promise<void> {
	try {
		// Check if tab is a restricted URL
		const tab = await chrome.tabs.get(tabId);
		if (
			tab.url?.startsWith("chrome://") ||
			tab.url?.startsWith("chrome-extension://") ||
			tab.url?.startsWith("moz-extension://") ||
			tab.url?.startsWith("about:")
		) {
			// Can't inject into system pages - skip overlay
			console.warn("[Overlay] Cannot inject overlay into system page:", tab.url);
			return;
		}

		if (!chrome.userScripts) {
			console.warn("[Overlay] userScripts permission is not enabled");
			return;
		}
		await chrome.userScripts.configureWorld({
			worldId: OVERLAY_WORLD_ID,
			messaging: true,
			csp: "script-src 'unsafe-eval' 'unsafe-inline'; style-src 'unsafe-inline'; default-src 'none';",
		});

		// Route Stop back to this sidebar even if navigation changes its working tab.
		const runId = crypto.randomUUID();
		overlayRuns.set(tabId, runId);
		await chrome.userScripts.execute({
			js: [{ code: createOverlayScript(taskName, runId) }],
			target: { tabId, allFrames: false },
			world: "USER_SCRIPT",
			worldId: OVERLAY_WORLD_ID,
			injectImmediately: true,
		});
		console.log("[Overlay] Injected overlay into tab", tabId);
	} catch (error) {
		overlayRuns.delete(tabId);
		// The overlay is cosmetic; page execution reports its own permission errors.
		console.warn("[Overlay] Failed to inject overlay:", error);
	}
}

/**
 * Remove the REPL overlay from the tab where it was injected.
 * @param tabId - ID of the tab to remove overlay from
 */
export async function removeOverlay(tabId: number): Promise<void> {
	overlayRuns.delete(tabId);
	try {
		if (chrome.userScripts) {
			await chrome.userScripts.execute({
				js: [{ code: removeOverlayScript() }],
				target: { tabId, allFrames: false },
				world: "USER_SCRIPT",
				worldId: OVERLAY_WORLD_ID,
				injectImmediately: true,
			});

			console.log("[Overlay] Removed overlay from tab", tabId);
		}
	} catch (error) {
		// Don't fail the REPL if overlay removal fails (tab might be closed)
		console.warn("[Overlay] Failed to remove overlay:", error);
	}
}
