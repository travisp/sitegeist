import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, UserMessage } from "@earendil-works/pi-ai";
import { isUserMessageWithAttachments, type UserMessageWithAttachments } from "@earendil-works/pi-web-ui";
import { ConversationCompaction, projectConversation } from "./messages/compaction.js";
import type { SitegeistAppStorage } from "./storage/app-storage.js";
import { SaveScheduler } from "./storage/save-scheduler.js";
import { snapshotSession } from "./storage/session-snapshot.js";
import { SkillDisclosure } from "./utils/format-skills.js";

type UserLikeMessage = UserMessage | UserMessageWithAttachments;

export const isUserMessage = (message: AgentMessage): message is UserLikeMessage =>
	message.role === "user" || isUserMessageWithAttachments(message);

function getMessageText(message: UserLikeMessage | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function generateTitle(messages: AgentMessage[]): string {
	const text = getMessageText(messages.find(isUserMessage)).trim();
	if (!text) return "Untitled session";
	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) return text.substring(0, sentenceEnd + 1);
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
}

export interface SessionOptions {
	id?: string;
	title?: string;
	/** Tutorial playback uses an agent without writing sessions or costs. */
	persist?: boolean;
}

type SessionServices = {
	storage: SitegeistAppStorage;
	onCreated: (id: string) => void;
	onChange: () => void;
};

/** Owns transcript checkpoints, costs, and persistence for exactly one agent. */
export class Session {
	id: string | undefined;
	title: string;
	readonly compaction: ConversationCompaction;
	private readonly saves: SaveScheduler;
	readonly skills = new SkillDisclosure();
	private readonly persist: boolean;
	private compacting = false;
	private manualCompactionAbort?: AbortController;

	constructor(
		readonly agent: Agent,
		private readonly services: SessionServices,
		options: SessionOptions = {},
	) {
		this.id = options.id;
		this.title = options.title ?? "";
		this.persist = options.persist !== false;
		this.saves = new SaveScheduler(() => this.save());
		this.compaction = new ConversationCompaction({
			getMessages: () => agent.state.messages,
			getModel: () => agent.state.model,
			streamFn: agent.streamFunction,
			getApiKey: async (provider) => agent.getApiKey?.(provider),
			onBusy: (busy) => {
				this.compacting = busy;
				services.onChange();
			},
			onCompacted: async (message) => {
				agent.state.messages = [...agent.state.messages, message];
				this.skills.clear();
				if (this.persist) {
					await this.recordCost(message.provider, message.modelId, message.usage.cost.total);
					await this.flush();
				}
				services.onChange();
			},
		});
		agent.transformContext = async (_messages, signal) => {
			await this.compaction.compact(false, signal);
			return projectConversation(agent.state.messages);
		};
	}

	get isCompacting(): boolean {
		return this.compacting;
	}

	async compact(): Promise<boolean> {
		this.manualCompactionAbort = new AbortController();
		try {
			return await this.compaction.compact(true, this.manualCompactionAbort.signal);
		} finally {
			this.manualCompactionAbort = undefined;
		}
	}

	cancelCompaction(): void {
		this.manualCompactionAbort?.abort();
	}

	flush(): Promise<void> {
		return this.saves.flush();
	}

	async handleEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_end") {
			// The runtime clears streaming state only after every event listener settles.
			// Schedule the final UI notification without making this listener wait for itself.
			void this.agent.waitForIdle().then(() => this.services.onChange());
		}
		if (!this.persist) return;
		const { messages } = this.agent.state;
		if (event.type === "message_end" && event.message.role === "assistant" && event.message.usage.cost.total > 0) {
			await this.recordCost(event.message.provider, event.message.model, event.message.usage.cost.total);
		}
		if (messages.some(isUserMessage)) {
			if (!this.title) this.title = generateTitle(messages);
			if (!this.id) {
				this.id = crypto.randomUUID();
				this.services.onCreated(this.id);
			}
		}
		if (this.id) {
			if (event.type === "message_update") this.saves.checkpoint();
			else if (event.type === "message_end" || event.type === "agent_end") await this.flush();
		}
		this.services.onChange();
	}

	private async recordCost(provider: string, model: string, cost: number): Promise<void> {
		try {
			await this.services.storage.costs.recordCost(provider, model, cost);
		} catch (error) {
			console.error("Failed to record cost:", error);
		}
	}

	private async save(): Promise<void> {
		if (!this.persist || !this.id || !this.title || !this.agent.state.messages.some(isUserMessage)) return;
		const { id, title } = this;
		const { storage } = this.services;
		try {
			// Freeze the write before yielding; streaming can continue while IndexedDB is busy.
			const state = snapshotSession(this.agent.state);
			const usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			for (const message of state.messages) {
				if (message.role !== "assistant" && message.role !== "conversation-compaction") continue;
				usage.input += message.usage.input;
				usage.output += message.usage.output;
				usage.cacheRead += message.usage.cacheRead;
				usage.cacheWrite += message.usage.cacheWrite;
				usage.totalTokens +=
					message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
				usage.cost.input += message.usage.cost.input;
				usage.cost.output += message.usage.cost.output;
				usage.cost.cacheRead += message.usage.cost.cacheRead;
				usage.cost.cacheWrite += message.usage.cost.cacheWrite;
				usage.cost.total += message.usage.cost.total;
			}
			let preview = "";
			for (const message of state.messages) {
				if (preview.length >= 2048) break;
				if (isUserMessage(message)) {
					preview += `${getMessageText(message)}\n`;
				} else if (message.role === "assistant") {
					const text = message.content
						.filter((block) => block.type === "text" || block.type === "thinking")
						.map((block) => (block.type === "text" ? block.text : block.thinking))
						.join("\n");
					preview += `${text}\n`;
				}
			}
			const existingMetadata = await storage.sessions.getMetadata(id);
			const createdAt = existingMetadata?.createdAt || new Date().toISOString();
			const metadata = {
				id,
				title,
				createdAt,
				lastModified: new Date().toISOString(),
				messageCount: state.messages.length,
				usage,
				modelId: state.model.id,
				thinkingLevel: state.thinkingLevel,
				preview: preview.substring(0, 2048),
			};
			await storage.sessions.save({ ...state, id, title, createdAt, lastModified: metadata.lastModified }, metadata);
		} catch (error) {
			console.error("Failed to save session:", error);
		}
	}
}
