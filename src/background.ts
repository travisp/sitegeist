import { SessionLocks } from "./background/session-locks.js";
import type { SidepanelRequest } from "./utils/sidepanel-protocol.js";

// Called when Sitegeist icon is clicked - opens sidepanel for current tab
chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
	const tabId = tab?.id;
	if (tabId && chrome.sidePanel.open) {
		chrome.sidePanel.open({ tabId });
	}
});

// Listen for messages from userScripts (overlay in page)
console.log("[Background] onUserScriptMessage available:", !!chrome.runtime.onUserScriptMessage);
if (chrome.runtime.onUserScriptMessage) {
	chrome.runtime.onUserScriptMessage.addListener((message, sender, sendResponse) => {
		console.log("[Background] Received userScript message:", message, "from:", sender);
		if (message.type === "abort-repl") {
			// Only the sidebar owning this overlay run will handle the abort.
			console.log("[Background] Relaying abort-repl to sidepanels");
			chrome.runtime.sendMessage(message);
			sendResponse({ success: true });
			return true;
		}
	});
	console.log("[Background] onUserScriptMessage listener registered");
} else {
	console.error("[Background] onUserScriptMessage NOT available!");
}

const SIDEPANEL_OPEN_KEY = "sidepanel_open_windows";
const SESSION_LOCKS_KEY = "session_locks";
const sessions = new SessionLocks({
	load: async () => {
		const data = await chrome.storage.session.get([SESSION_LOCKS_KEY, SIDEPANEL_OPEN_KEY]);
		return {
			locks: (data[SESSION_LOCKS_KEY] as Record<string, number> | undefined) ?? {},
			openWindows: (data[SIDEPANEL_OPEN_KEY] as number[] | undefined) ?? [],
		};
	},
	save: async (state) => {
		await chrome.storage.session.set({
			[SESSION_LOCKS_KEY]: state.locks,
			[SIDEPANEL_OPEN_KEY]: state.openWindows,
		});
	},
});
const reportError = (error: unknown) => console.error("[Background] Session ownership failed:", error);
void sessions.ready.catch(reportError);

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
	const match = /^sidepanel:(\d+)$/.exec(port.name);
	if (!match) return;

	void sessions.connect(port, Number(match[1])).catch(reportError);
	port.onMessage.addListener((message: SidepanelRequest) => {
		void sessions
			.handleRequest(port, message)
			.then((response) => port.postMessage(response))
			.catch(reportError);
	});
	port.onDisconnect.addListener(() => {
		void sessions.disconnect(port).catch(reportError);
	});
});

chrome.windows.onRemoved.addListener((windowId: number) => {
	void sessions.closeWindow(windowId).catch(reportError);
});

// The open-window cache is synchronous so opening preserves the keyboard gesture.
chrome.commands.onCommand.addListener((command: string, sender?: chrome.tabs.Tab) => {
	if (command !== "toggle-sidepanel") return;
	const windowId = sender?.windowId;
	if (windowId === undefined) {
		console.log("[Background] Cannot toggle sidepanel: sender windowId not available");
		return;
	}
	if (sessions.isOpen(windowId)) {
		void chrome.sidePanel.close({ windowId }).catch(reportError);
		void sessions.closeWindow(windowId).catch(reportError);
	} else {
		void chrome.sidePanel.open({ windowId });
	}
});
