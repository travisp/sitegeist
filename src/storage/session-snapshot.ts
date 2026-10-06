import type { AgentState } from "@earendil-works/pi-agent-core";

export type SessionSnapshot = Pick<AgentState, "messages" | "model" | "thinkingLevel">;

/** Copy only persisted fields; never carry the live agent's tools or streaming state into storage. */
export function snapshotSession(state: AgentState): SessionSnapshot {
	const messages = state.messages.slice();
	const streaming = state.streamingMessage;
	if (streaming?.role === "assistant") {
		// Never restore an unfinished tool call as an instruction to execute it.
		const content = streaming.content.filter((block) => block.type !== "toolCall");
		if (content.length > 0) {
			messages.push({
				...streaming,
				content,
				stopReason: "aborted",
				errorMessage: "Response interrupted before completion.",
			});
		}
	}
	return JSON.parse(JSON.stringify({ messages, model: state.model, thinkingLevel: state.thinkingLevel }));
}
