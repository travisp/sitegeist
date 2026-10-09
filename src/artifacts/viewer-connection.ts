import type { ArtifactViewer } from "./ArtifactViewer.js";
import { type ArtifactSnapshot, type ArtifactViewerMessage, artifactChannelName } from "./protocol.js";

/** A live reply wins over a delayed IndexedDB baseline, including a reply deleting a file. */
export class ArtifactViewerConnection {
	private readonly channel: BroadcastChannel;
	private liveReceived = false;
	private closed = false;

	constructor(viewer: ArtifactViewer, sessionId: string, loadSaved: () => Promise<ArtifactSnapshot | null>) {
		this.channel = new BroadcastChannel(artifactChannelName(sessionId));
		this.channel.onmessage = (event: MessageEvent<ArtifactViewerMessage>) => {
			if (event.data.type !== "snapshot") return;
			this.liveReceived = true;
			viewer.applySnapshot(event.data.snapshot);
		};
		this.channel.postMessage({ type: "request" } satisfies ArtifactViewerMessage);
		void loadSaved().then(
			(snapshot) => {
				if (this.closed || this.liveReceived) return;
				if (snapshot) viewer.applySnapshot(snapshot);
				else
					viewer.showError(
						"No saved artifact is available. Open its conversation in Sitegeist to view live output.",
					);
			},
			(error: unknown) => {
				if (this.closed || this.liveReceived) return;
				viewer.showError(`Could not load this artifact: ${error instanceof Error ? error.message : String(error)}`);
			},
		);
	}

	close(): void {
		this.closed = true;
		this.channel.close();
	}
}
