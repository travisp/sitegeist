import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ArtifactsParams, Attachment } from "@earendil-works/pi-web-ui";

export interface ArtifactSnapshot {
	artifacts: Record<string, string>;
	attachments: Attachment[];
}

export type ArtifactViewerMessage = { type: "request" } | { type: "snapshot"; snapshot: ArtifactSnapshot };

/** Extension pages share this channel even when their tabs move to another window. */
export function artifactChannelName(sessionId: string): string {
	return `sitegeist-artifacts:${sessionId}`;
}

export function artifactViewerUrl(sessionId: string, filename: string): string {
	const url = new URL(chrome.runtime.getURL("artifact.html"));
	url.searchParams.set("session", sessionId);
	url.searchParams.set("file", filename);
	return url.href;
}

export function isArtifactViewerUrl(url: string | undefined): boolean {
	return (
		url?.startsWith("chrome-extension://") === true &&
		url.split(/[?#]/, 1)[0] === chrome.runtime.getURL("artifact.html")
	);
}

/** Reconstruct saved files without mounting renderers or executing generated HTML. */
export function snapshotFromMessages(messages: AgentMessage[]): ArtifactSnapshot {
	const artifacts: Record<string, string> = Object.create(null);
	const attachments: Attachment[] = [];
	const calls = new Map<string, ArtifactsParams>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall" && block.name === "artifacts") {
					calls.set(block.id, block.arguments as ArtifactsParams);
				}
			}
		}
		if (message.role === "user-with-attachments") attachments.push(...(message.attachments ?? []));
		if (message.role === "artifact") {
			if (message.action === "delete") delete artifacts[message.filename];
			else if (message.content !== undefined) artifacts[message.filename] = message.content;
		} else if (message.role === "toolResult" && message.toolName === "artifacts" && !message.isError) {
			const op = calls.get(message.toolCallId);
			if (!op || message.content.some((block) => block.type === "text" && block.text.startsWith("Error:"))) continue;
			switch (op.command) {
				case "create":
				case "rewrite":
					if (op.content !== undefined) artifacts[op.filename] = op.content;
					break;
				case "update":
					if (artifacts[op.filename] !== undefined && op.old_str !== undefined && op.new_str !== undefined) {
						artifacts[op.filename] = artifacts[op.filename].replace(op.old_str, op.new_str);
					}
					break;
				case "delete":
					delete artifacts[op.filename];
					break;
			}
		}
	}
	return { artifacts, attachments };
}
