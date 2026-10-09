import { type ArtifactSnapshot, type ArtifactViewerMessage, artifactChannelName } from "./protocol.js";

/** Publishes from the session owner; viewers never acquire a session lock or run an agent. */
export class ArtifactPublisher {
	private channel?: BroadcastChannel;

	constructor(private readonly getSnapshot: () => ArtifactSnapshot) {}

	connect(sessionId: string): void {
		this.close();
		this.channel = new BroadcastChannel(artifactChannelName(sessionId));
		this.channel.onmessage = (event: MessageEvent<ArtifactViewerMessage>) => {
			if (event.data.type === "request") this.publish();
		};
		this.publish();
	}

	publish(): void {
		this.channel?.postMessage({ type: "snapshot", snapshot: this.getSnapshot() } satisfies ArtifactViewerMessage);
	}

	close(): void {
		this.channel?.close();
		this.channel = undefined;
	}
}
