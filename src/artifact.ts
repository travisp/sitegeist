import { setAppStorage } from "@earendil-works/pi-web-ui";
import { ArtifactViewer } from "./artifacts/ArtifactViewer.js";
import { snapshotFromMessages } from "./artifacts/protocol.js";
import { ArtifactViewerConnection } from "./artifacts/viewer-connection.js";
import { SitegeistAppStorage } from "./storage/app-storage.js";
import "./utils/i18n-extension.js";
import "./utils/live-reload.js";

const params = new URL(window.location.href).searchParams;
const sessionId = params.get("session");
const filename = params.get("file");
const storage = new SitegeistAppStorage();
setAppStorage(storage);

const viewer = new ArtifactViewer();
viewer.filename = filename ?? "";
viewer.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");
viewer.style.display = "block";
viewer.style.height = "100%";
document.body.append(viewer);
document.title = filename ? `${filename} — Sitegeist` : "Artifact — Sitegeist";

if (!sessionId || !filename) {
	viewer.showError("This artifact link is incomplete. Open the artifact from its conversation.");
} else {
	const connection = new ArtifactViewerConnection(viewer, sessionId, async () => {
		const saved = await storage.sessions.loadSession(sessionId);
		return saved ? snapshotFromMessages(saved.messages) : null;
	});
	window.addEventListener("pagehide", () => connection.close(), { once: true });
}
