import { artifactViewerUrl } from "./protocol.js";

/** Find viewers across all windows, including tabs the user has dragged out of the working window. */
export async function openArtifactViewer(sessionId: string, filename: string, windowId: number): Promise<void> {
	const url = artifactViewerUrl(sessionId, filename);
	const tabs = await chrome.tabs.query({ url: `${chrome.runtime.getURL("artifact.html")}*` });
	const existing = tabs.find((tab) => tab.url?.split("#")[0] === url);
	if (existing?.id !== undefined) {
		await chrome.tabs.update(existing.id, { active: true });
		await chrome.windows.update(existing.windowId, { focused: true });
	} else {
		await chrome.tabs.create({ url, windowId, active: true });
	}
}
