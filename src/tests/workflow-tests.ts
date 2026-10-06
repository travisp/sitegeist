import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
	Type,
	toToolDeclaration,
} from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createStreamFn, SandboxIframe } from "@earendil-works/pi-web-ui";
import {
	ConversationCompaction,
	estimateConversationTokens,
	latestCompaction,
	prepareConversationCompaction,
	projectConversation,
} from "../messages/compaction.js";
import { browserMessageTransformer } from "../messages/message-transformer.js";
import { Session } from "../session.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import { SaveScheduler } from "../storage/save-scheduler.js";
import { snapshotSession } from "../storage/session-snapshot.js";
import type { Skill } from "../storage/stores/skills-store.js";
import { browserTarget } from "../tools/browser-target.js";
import { ExtractImageTool } from "../tools/extract-image.js";
import { NativeInputEventsRuntimeProvider } from "../tools/NativeInputEventsRuntimeProvider.js";
import { NavigateTool, parseNavigateAction } from "../tools/navigate.js";
import { createReplTool } from "../tools/repl/repl.js";
import { BrowserJsRuntimeProvider, NavigateRuntimeProvider } from "../tools/repl/runtime-providers.js";
import { SkillDisclosure } from "../utils/format-skills.js";
import { assert, type BrowserTest, equal } from "./test-utils.js";

export const workflowTests: BrowserTest[] = [];
const test = (name: string, run: () => Promise<void>) => workflowTests.push({ name, run });
const streamFn = createStreamFn(async () => undefined);
const schema = Type.Object({});
const tool: AgentTool<typeof schema, undefined> = {
	name: "inspect",
	label: "Inspect",
	description: "Read a page",
	parameters: schema,
	execute: async () => ({ content: [{ type: "text", text: "page" }], details: undefined }),
};

function history(): AgentMessage[] {
	return [
		{ role: "system", content: "Keep the user's browser safe", toolsAdded: [toToolDeclaration(tool)], timestamp: 1 },
		...Array.from({ length: 4 }, (_, i): AgentMessage[] => [
			{ role: "user", content: `Old request ${i}: ${"evidence ".repeat(1800)}`, timestamp: i + 2 },
			fauxAssistantMessage(`Completed old request ${i}`),
		]).flat(),
		{ role: "user", content: "Continue on tab 12; do not submit", timestamp: 10 },
		fauxAssistantMessage(fauxToolCall("inspect", {}, { id: "raw-evidence" }), { stopReason: "toolUse" }),
		{
			role: "navigation",
			title: "Invoice",
			url: "https://example.test/invoices",
			tabId: 12,
			skillsOutput: "invoice skill",
		},
		{
			role: "toolResult",
			toolCallId: "raw-evidence",
			toolName: "inspect",
			content: [{ type: "text", text: "preview" }],
			details: { rawOutput: "original complete evidence" },
			isError: false,
			timestamp: 11,
		},
	];
}

function assertToolPairs(messages: AgentMessage[]) {
	let callIds: string[] = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			callIds = message.content.filter((block) => block.type === "toolCall").map((block) => block.id);
		} else if (message.role === "toolResult") {
			assert(callIds.includes(message.toolCallId), "tool result retains its preceding assistant call");
		}
	}
}

test("compaction preparation is pure and preserves tool boundaries and evidence handles", async () => {
	const messages = history();
	messages.push({ role: "user", content: "Recent evidence ".repeat(1500), timestamp: 12 });
	messages.push(fauxAssistantMessage("Recent progress"));
	messages.push({ role: "user", content: "Continue", timestamp: 13 });
	const original = JSON.stringify(messages);
	const plan = prepareConversationCompaction(messages, 8192);
	assert(plan, "large history produces a plan without a provider call");
	equal(JSON.stringify(messages), original, "preparation does not mutate the transcript");
	equal(plan.through, messages.length, "plan captures the original transcript boundary");
	equal(plan.reserveTokens, 2048, "small context windows cap the summary budget");
	assertToolPairs(plan.retainedTail);
	assertToolPairs(plan.summaryMessages);
	assert(JSON.stringify(plan.summaryMessages).includes("raw-evidence"), "summary input retains evidence IDs");
	equal(prepareConversationCompaction([], 8192, true), undefined, "no prefix means no plan, even when forced");
	equal(
		prepareConversationCompaction([{ role: "user", content: "Hello", timestamp: 1 }], 8192),
		undefined,
		"small conversations do not need automatic compaction",
	);
});

test("compaction keeps an entire multi-tool batch when its results exceed the recent budget", async () => {
	const messages: AgentMessage[] = [
		{ role: "user", content: "Older context ".repeat(3000), timestamp: 1 },
		fauxAssistantMessage("Earlier work"),
		fauxAssistantMessage(
			[fauxToolCall("inspect", {}, { id: "first" }), fauxToolCall("inspect", {}, { id: "second" })],
			{ stopReason: "toolUse" },
		),
		...["first", "second"].map(
			(toolCallId): AgentMessage => ({
				role: "toolResult",
				toolCallId,
				toolName: "inspect",
				content: [{ type: "text", text: "Evidence ".repeat(1000) }],
				isError: false,
				timestamp: 2,
			}),
		),
	];
	const plan = prepareConversationCompaction(messages, 8192, true);
	assert(plan, "older context can be summarized");
	assertToolPairs(plan.retainedTail);
	equal(plan.retainedTail, messages.slice(2), "both calls and both results stay together");
	equal(plan.summaryMessages, messages.slice(0, 2), "summary ends before the batch");
});

test("context estimation counts provider usage and excludes raw artifacts and image bytes", async () => {
	const messages = history();
	const before = estimateConversationTokens(messages);
	const result = messages.find((message) => message.role === "toolResult");
	assert(result?.role === "toolResult", "history has a raw result");
	result.details = { rawOutput: "raw evidence ".repeat(10000) };
	equal(estimateConversationTokens(messages), before, "raw details do not consume model context");
	const image: AgentMessage = {
		role: "user",
		content: [{ type: "image", mimeType: "image/png", data: "AA==" }],
		timestamp: 1,
	};
	const smallImage = estimateConversationTokens([image]);
	image.content = [{ type: "image", mimeType: "image/png", data: "AA==".repeat(10000) }];
	equal(estimateConversationTokens([image]), smallImage, "image estimate does not count base64 bytes");
	const response = fauxAssistantMessage("Done");
	response.usage = { ...response.usage, input: 100, output: 20, cacheRead: 30, cacheWrite: 40 };
	equal(estimateConversationTokens([...messages, response]), 190, "latest provider usage replaces text estimates");
});

test("session ownership binds persistence, titles, and cost accounting to one agent", async () => {
	const faux = registerFauxProvider();
	const storage = getSitegeistStorage();
	const recordCost = storage.costs.recordCost;
	const costs: number[] = [];
	const created: string[] = [];
	storage.costs.recordCost = async (_provider, _model, cost) => {
		costs.push(cost);
	};
	try {
		const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn, getApiKey: () => "test-key" });
		const session = new Session(agent, { storage, onCreated: (id) => created.push(id), onChange: () => {} });
		agent.subscribe((event) => {
			// Faux emits zero costs; attach paid usage at the actual completion boundary.
			if (event.type === "message_end" && event.message.role === "assistant") {
				event.message.usage.cost.total = 0.25;
			}
			return session.handleEvent(event);
		});
		const answer = fauxAssistantMessage("Completed");
		faux.setResponses([
			async () => {
				assert(session.id, "initial user message assigns an ID");
				const saved = await storage.sessions.loadSession(session.id);
				assert(
					saved?.messages.some((message) => message.role === "user"),
					"user message saved before provider response",
				);
				return answer;
			},
		]);
		await agent.prompt("First session. More detail");
		assert(session.id, "session identity assigned");
		equal(session.title, "First session.", "title generated from first sentence");
		equal(created, [session.id], "identity announced only once");
		const assistant = agent.state.messages.find((message) => message.role === "assistant");
		assert(assistant, "assistant retained");
		equal(costs, [0.25], "assistant cost recorded at completion");
		const loaded = await storage.sessions.loadSession(session.id);
		assert(loaded, "saved conversation exists");
		const reloaded = new Session(
			new Agent({ initialState: loaded, streamFn }),
			{
				storage,
				onCreated: () => {
					throw new Error("Loaded sessions already have an ID");
				},
				onChange: () => {},
			},
			{ id: session.id, title: session.title },
		);
		await reloaded.flush();
		equal(costs, [0.25], "loaded costs are not recorded again");

		const otherAgent = new Agent({ initialState: { model: faux.getModel() }, streamFn });
		const other = new Session(otherAgent, { storage, onCreated: (id) => created.push(id), onChange: () => {} });
		otherAgent.state.messages = [{ role: "user", content: "Second session", timestamp: 2 }];
		await other.handleEvent({ type: "message_end", message: otherAgent.state.messages[0] });
		session.title = "Renamed first session";
		await session.flush();
		equal((await storage.sessions.getMetadata(session.id))?.title, session.title, "rename saved to owning session");
		assert(other.id, "second session has its own ID");
		equal((await storage.sessions.getMetadata(other.id))?.title, "Second session", "other session is untouched");
	} finally {
		storage.costs.recordCost = recordCost;
		await Promise.all(created.map((id) => storage.sessions.delete(id)));
		faux.unregister();
	}
});

test("session compaction commits to its owning agent and tutorial sessions stay transient", async () => {
	const faux = registerFauxProvider();
	const storage = getSitegeistStorage();
	const id = crypto.randomUUID();
	const recordCost = storage.costs.recordCost;
	const costs: number[] = [];
	storage.costs.recordCost = async (_provider, _model, cost) => {
		costs.push(cost);
	};
	try {
		const agent = new Agent({
			initialState: { model: { ...faux.getModel(), contextWindow: 8192 }, messages: history() },
			streamFn,
			getApiKey: () => "test-key",
		});
		const owner = new Session(agent, { storage, onCreated: () => {}, onChange: () => {} }, { id, title: "Owner" });
		const other = new Session(
			new Agent({ initialState: { model: faux.getModel() }, streamFn }),
			{
				storage,
				onCreated: () => {
					throw new Error("Tutorial must not create a saved session");
				},
				onChange: () => {},
			},
			{ persist: false },
		);
		const skill: Skill = {
			name: "Invoices",
			domainPatterns: ["example.test"],
			shortDescription: "Read invoices",
			description: "Full invoice instructions",
			examples: "",
			library: "",
			createdAt: "2026-01-01",
			lastUpdated: "2026-01-01",
		};
		equal(owner.skills.format([]), "none found", "empty skill list is explicit");
		assert(owner.skills.format([skill]).includes("Full invoice instructions"), "owner sees full skill initially");
		assert(
			other.skills.format([skill]).includes("Full invoice instructions"),
			"other session has independent tracking",
		);
		equal(
			owner.skills.format([skill]),
			"Previously Seen Skills:\n- Invoices: Read invoices",
			"owner sees only a reference next time",
		);
		const updatedSkill = { ...skill, lastUpdated: "2026-01-02" };
		assert(
			owner.skills.format([updatedSkill]).includes("Full invoice instructions"),
			"updated skill is disclosed again",
		);
		faux.setResponses([
			() => {
				assert(owner.isCompacting, "owner exposes compaction state");
				assert(!other.isCompacting, "other session stays idle");
				return fauxAssistantMessage("Summary for owner only");
			},
		]);
		assert(await owner.compact(), "manual compaction succeeds");
		assert(
			owner.skills.format([updatedSkill]).includes("Full invoice instructions"),
			"compaction resets owner's tracking",
		);
		assert(
			!other.skills.format([skill]).includes("Full invoice instructions"),
			"compaction leaves other tracking untouched",
		);
		assert(!owner.isCompacting, "busy state cleared");
		assert(latestCompaction(agent.state.messages), "checkpoint committed to owner");
		assert(!latestCompaction(other.agent.state.messages), "other agent unchanged");
		const saved = await storage.sessions.loadSession(id);
		assert(saved && latestCompaction(saved.messages), "checkpoint persisted with original history");
		equal(costs, [0], "summary's faux-provider cost recorded");
		const metadata = await storage.sessions.getMetadata(id);
		const checkpoint = latestCompaction(agent.state.messages);
		assert(checkpoint && checkpoint.usage.totalTokens > 0, "summary has token usage");
		equal(metadata?.usage.totalTokens, checkpoint.usage.totalTokens, "summary included in session totals");
		other.agent.state.messages = history();
		other.agent.state.model = agent.state.model;
		faux.setResponses([() => fauxAssistantMessage("Transient summary")]);
		assert(await other.compact(), "tutorial compaction still works");
		await other.handleEvent({ type: "agent_end", messages: other.agent.state.messages });
		await other.flush();
		equal(other.id, undefined, "tutorial does not acquire persistent identity");
		equal(costs, [0], "tutorial compaction does not write costs");

		agent.state.messages = history();
		const beforeCancellation = JSON.stringify(agent.state.messages);
		faux.setResponses([
			() => {
				owner.cancelCompaction();
				return fauxAssistantMessage("Cancelled summary");
			},
		]);
		let cancelled = false;
		try {
			await owner.compact();
		} catch {
			cancelled = true;
		}
		assert(cancelled, "manual cancellation reaches the summary request");
		assert(!owner.isCompacting, "cancellation clears the busy state");
		equal(JSON.stringify(agent.state.messages), beforeCancellation, "cancelled summary is not committed");
	} finally {
		storage.costs.recordCost = recordCost;
		await storage.sessions.delete(id);
		faux.unregister();
	}
});

test("navigation arguments normalize to a single explicit action", async () => {
	equal(parseNavigateAction({ listTabs: true }), { kind: "list" }, "list action");
	equal(parseNavigateAction({ switchToTab: 12 }), { kind: "select", tabId: 12 }, "working tab selection");
	equal(
		parseNavigateAction({ url: "https://example.test", newTab: true }),
		{ kind: "navigate", url: "https://example.test", newTab: true },
		"background navigation",
	);
	for (const args of [
		{},
		{ listTabs: true, url: "https://example.test" },
		{ listTabs: true, switchToTab: 12 },
		{ switchToTab: 12, newTab: true },
		{ switchToTab: 12, url: "https://example.test" },
	]) {
		let rejected = false;
		try {
			await new NavigateTool(new SkillDisclosure()).execute("invalid", args);
		} catch (error) {
			rejected = /cannot be combined|Provide a URL/.test(String(error));
		}
		assert(rejected, `invalid action rejected before browser access: ${JSON.stringify(args)}`);
	}
});

test("compaction summarizes browser context, preserves evidence and instructions, and survives repeated saves", async () => {
	const faux = registerFauxProvider();
	const storage = getSitegeistStorage();
	const id = crypto.randomUUID();
	try {
		let messages = history();
		const original = messages.slice();
		const model = { ...faux.getModel(), contextWindow: 8192 };
		const contexts: TranscriptContext[] = [];
		const busy: boolean[] = [];
		faux.setResponses([
			(context) => {
				contexts.push(structuredClone(context));
				messages.push({ role: "user", content: "Input arriving during summarization", timestamp: 12 });
				return fauxAssistantMessage("Summary one: do not submit; inspect tab 12.");
			},
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("Summary two: previous constraints and new progress.");
			},
		]);
		const compaction = new ConversationCompaction({
			getMessages: () => messages,
			getModel: () => model,
			streamFn,
			getApiKey: async () => "test-key",
			onBusy: (value) => busy.push(value),
			onCompacted: async (message) => {
				messages = [...messages, message];
			},
		});
		assert(await compaction.compact(), "automatic threshold triggers");
		equal(messages.slice(0, original.length), original, "original transcript unchanged");
		const projected = browserMessageTransformer(projectConversation(messages));
		assert(getCurrentSystemPrompt(projected).includes("Keep the user's browser safe"), "system retained");
		equal(
			getCurrentTools(projected).map((item) => item.name),
			["inspect"],
			"tools retained",
		);
		assert(JSON.stringify(projected).includes("Summary one"), "summary in model context");
		assert(
			JSON.stringify(projected).includes("Input arriving during summarization"),
			"concurrent input retained after checkpoint",
		);
		assert(!JSON.stringify(projected).includes("Old request 0"), "old messages omitted only from model context");
		assert(JSON.stringify(projected).includes("invoice skill"), "navigation and skills retained");
		assertToolPairs(projected);
		assert(estimateConversationTokens(messages) < 6144, "post-compaction estimate uses reduced context");
		assert(!(await compaction.compact()), "no immediate repeated compaction");
		assert(
			getCurrentSystemPrompt(contexts[0].messages).includes("context summarization assistant"),
			"browser summary prompt used",
		);

		const agent = new Agent({ initialState: { model, messages }, streamFn });
		await storage.sessions.saveSession(id, agent.state, undefined, "Compaction test");
		const loaded = await storage.sessions.loadSession(id);
		assert(loaded, "saved session restored");
		messages = loaded.messages;
		equal(browserMessageTransformer(projectConversation(messages)), projected, "restored model context identical");
		assert(JSON.stringify(messages).includes("original complete evidence"), "raw results survive save and reload");
		messages.push({ role: "system", content: "Additional rule", toolsRemoved: [{ name: "inspect" }], timestamp: 12 });
		messages.push({ role: "user", content: "new evidence ".repeat(3000), timestamp: 13 });
		messages.push(fauxAssistantMessage("New progress"));
		messages.push({ role: "user", content: "Continue", timestamp: 14 });
		assert(await compaction.compact(true), "second compaction succeeds");
		assert(JSON.stringify(contexts[1]).includes("Summary one"), "previous summary included in update");
		assert(
			JSON.stringify(contexts[1]).includes("Tool call ID: raw-evidence"),
			"summary request preserves evidence handles",
		);
		equal(getCurrentTools(contexts[1].messages), [], "summary request exposes no executable tools");
		assert(
			!JSON.stringify(contexts[1]).includes("original complete evidence"),
			"raw artifacts stay out of the summary request",
		);
		const second = browserMessageTransformer(projectConversation(messages));
		assert(getCurrentSystemPrompt(second).includes("Additional rule"), "system updates preserved");
		equal(getCurrentTools(second), [], "tool removals preserved");
		assert(JSON.stringify(second).includes("Summary two"), "updated summary used");
		equal(busy, [true, false, true, false], "busy state settles");
	} finally {
		await storage.sessions.delete(id);
		faux.unregister();
	}
});

test("compaction runs inside the agent request boundary and keeps new messages", async () => {
	const faux = registerFauxProvider();
	try {
		const model = { ...faux.getModel(), contextWindow: 8192 };
		let agent: Agent;
		let finalContext: TranscriptContext | undefined;
		faux.setResponses([
			() => fauxAssistantMessage("A compact checkpoint"),
			(context) => {
				finalContext = context;
				return fauxAssistantMessage("Continued successfully");
			},
		]);
		const compaction = new ConversationCompaction({
			getMessages: () => agent.state.messages,
			getModel: () => model,
			streamFn,
			getApiKey: async () => "test-key",
			onBusy: () => {},
			onCompacted: async (message) => {
				agent.state.messages = [...agent.state.messages, message];
			},
		});
		agent = new Agent({
			initialState: { model, messages: history(), tools: [tool] },
			streamFn,
			getApiKey: () => "test-key",
			convertToLlm: browserMessageTransformer,
			transformContext: async (_messages, signal) => {
				await compaction.compact(false, signal);
				return projectConversation(agent.state.messages);
			},
		});
		await agent.prompt("Latest user instruction");
		assert(finalContext, "normal request sent after summary");
		assert(JSON.stringify(finalContext).includes("Latest user instruction"), "latest user input retained");
		assert(JSON.stringify(finalContext).includes("A compact checkpoint"), "checkpoint used");
		equal(faux.state.callCount, 2, "one summary and one normal request");
		assert(latestCompaction(agent.state.messages), "checkpoint remains in raw agent transcript");
		assert(!agent.state.isStreaming, "agent settles");
	} finally {
		faux.unregister();
	}
});

test("failed and cancelled compaction leave the transcript untouched", async () => {
	const faux = registerFauxProvider();
	try {
		const messages = history();
		const original = JSON.stringify(messages);
		let commits = 0;
		const model = { ...faux.getModel(), contextWindow: 8192 };
		const compaction = new ConversationCompaction({
			getMessages: () => messages,
			getModel: () => model,
			streamFn,
			getApiKey: async () => "test-key",
			onBusy: () => {},
			onCompacted: async () => {
				commits++;
			},
		});
		const failures = [
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Summary failure" }),
			fauxAssistantMessage("Truncated summary", { stopReason: "length" }),
			fauxAssistantMessage("   "),
		];
		faux.setResponses(failures);
		for (const response of failures) {
			let failed = false;
			try {
				await compaction.compact(true);
			} catch {
				failed = true;
			}
			assert(failed, `unusable summary rejected: ${response.stopReason}`);
		}
		let failed = false;
		try {
			await compaction.compact(true, AbortSignal.abort());
		} catch {
			failed = true;
		}
		assert(failed, "abort reported");
		equal(commits, 0, "no checkpoint committed");
		equal(JSON.stringify(messages), original, "history unchanged");
		equal(faux.state.callCount, failures.length, "aborted request never sent");
	} finally {
		faux.unregister();
	}
});

test("save scheduler coalesces checkpoints and serializes boundary writes", async () => {
	let writes = 0;
	let active = 0;
	let maxActive = 0;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const scheduler = new SaveScheduler(async () => {
		writes++;
		maxActive = Math.max(maxActive, ++active);
		if (writes === 1) await gate;
		active--;
	}, 10);
	for (let i = 0; i < 100; i++) scheduler.checkpoint();
	equal(writes, 0, "streaming does not write immediately");
	const first = scheduler.flush();
	await Promise.resolve(); // First write is now waiting on the gate.
	const second = scheduler.flush();
	const third = scheduler.flush();
	release?.();
	await Promise.all([first, second, third]);
	await new Promise((resolve) => setTimeout(resolve, 20));
	equal(writes, 2, "pending boundary writes coalesced and timer cleared");
	equal(maxActive, 1, "writes never overlap");
	for (let i = 0; i < 100; i++) scheduler.checkpoint();
	await new Promise((resolve) => setTimeout(resolve, 20));
	equal(writes, 3, "one timed checkpoint for streaming burst");
});

test("session snapshots retain partial text without unfinished tool calls or mutable references", async () => {
	const faux = registerFauxProvider();
	const storage = getSitegeistStorage();
	const id = crypto.randomUUID();
	try {
		const agent = new Agent({
			initialState: { model: faux.getModel(), messages: [{ role: "user", content: "Start", timestamp: 1 }] },
			streamFn,
		});
		const streamingMessage = fauxAssistantMessage([
			{ type: "text", text: "Partial answer" },
			fauxToolCall("inspect", {}, { id: "unfinished" }),
		]);
		const snapshot = snapshotSession({ ...agent.state, streamingMessage });
		agent.state.messages.push({ role: "user", content: "Later input", timestamp: 2 });
		await storage.sessions.saveSession(id, { ...agent.state, ...snapshot }, undefined, "Snapshot test");
		const loaded = await storage.sessions.loadSession(id);
		assert(loaded, "snapshot persisted");
		equal(loaded.messages.length, 2, "snapshot not mutated by later events");
		const partial = loaded.messages[1];
		assert(partial.role === "assistant", "partial assistant preserved");
		equal(partial.stopReason, "aborted", "interruption explicit on restore");
		equal(partial.content, [{ type: "text", text: "Partial answer" }], "unfinished tool call omitted");
		assert(
			streamingMessage.content.some((block) => block.type === "toolCall"),
			"live streaming state untouched",
		);
	} finally {
		await storage.sessions.delete(id);
		faux.unregister();
	}
});

test("compaction can run between tool turns without splitting calls from results", async () => {
	const faux = registerFauxProvider();
	try {
		const model = { ...faux.getModel(), contextWindow: 8192 };
		const largeTool = {
			...tool,
			execute: async () => ({
				content: [{ type: "text" as const, text: "large result ".repeat(500) }],
				details: undefined,
			}),
		};
		let agent: Agent;
		let finalContext: TranscriptContext | undefined;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("inspect", {}, { id: "large-call" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Preserved the user's request and inspected page."),
			(context) => {
				finalContext = context;
				return fauxAssistantMessage("Finished");
			},
		]);
		const compaction = new ConversationCompaction({
			getMessages: () => agent.state.messages,
			getModel: () => model,
			streamFn,
			getApiKey: async () => "test-key",
			onBusy: () => {},
			onCompacted: async (message) => {
				agent.state.messages = [...agent.state.messages, message];
			},
		});
		agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Inspect safely",
				tools: [largeTool],
				messages: [
					{ role: "user", content: "older context ".repeat(800), timestamp: 1 },
					fauxAssistantMessage("Earlier work one"),
					{ role: "user", content: "older context ".repeat(800), timestamp: 2 },
					fauxAssistantMessage("Earlier work two"),
				],
			},
			streamFn,
			getApiKey: () => "test-key",
			convertToLlm: browserMessageTransformer,
			transformContext: async (_messages, signal) => {
				await compaction.compact(false, signal);
				return projectConversation(agent.state.messages);
			},
		});
		await agent.prompt("Inspect this page");
		assert(
			finalContext,
			`final response requested: ${JSON.stringify({ calls: faux.state.callCount, error: agent.state.errorMessage, roles: agent.state.messages.map((m) => m.role) })}`,
		);
		assertToolPairs(finalContext.messages);
		assert(latestCompaction(agent.state.messages), "compacted after tool result");
		assert(estimateConversationTokens(agent.state.messages) < 6144, "context reduced below threshold");
		equal(faux.state.callCount, 3, "tool response, summary, final response");
		assert(
			agent.state.messages.some((message) => message.role === "toolResult" && message.toolCallId === "large-call"),
			"original tool result retained",
		);
	} finally {
		faux.unregister();
	}
});

test("REPL preserves files and raw output and cleans up after success or failure", async () => {
	const originalExecute = SandboxIframe.prototype.execute;
	const initialSandboxes = document.querySelectorAll("sandbox-iframe").length;
	const binary = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256);
	const text = "Résumé 日本語";
	const output = "Page evidence ".repeat(2000);
	let fail = false;
	SandboxIframe.prototype.execute = async function () {
		assert(this.isConnected, "sandbox attached during execution");
		if (fail) throw new Error("Sandbox execution failed");
		return {
			success: true,
			console: [{ type: "log", text: output }],
			files: [
				{ fileName: "notes.txt", mimeType: "text/plain", content: text },
				{ fileName: "data.bin", mimeType: "application/octet-stream", content: binary },
			],
		};
	};
	try {
		const repl = createReplTool();
		const result = await repl.execute("files", { title: "Export files", code: "return 1;" });
		const files = result.details.files;
		assert(files?.length === 2, "both files returned");
		const textBytes = Uint8Array.from(atob(files[0].contentBase64), (char) => char.charCodeAt(0));
		equal(new TextDecoder().decode(textBytes), text, "Unicode text encoded as UTF-8");
		equal(files[0].size, new TextEncoder().encode(text).length, "text size measured in bytes");
		const decodedBinary = atob(files[1].contentBase64);
		equal(decodedBinary.length, binary.length, "large binary size preserved");
		assert(
			binary.every((byte, index) => decodedBinary.charCodeAt(index) === byte),
			"all binary bytes preserved",
		);
		assert(result.details.rawOutput?.includes(output), "full REPL output preserved");
		assert(
			JSON.stringify(result.content).includes("Large REPL output compacted"),
			"model receives a compact preview",
		);
		equal(document.querySelectorAll("sandbox-iframe").length, initialSandboxes, "sandbox removed after success");
		fail = true;
		let error: unknown;
		try {
			await repl.execute("failure", { title: "Fail", code: "throw new Error();" });
		} catch (caught) {
			error = caught;
		}
		assert(error instanceof Error && error.message === "Sandbox execution failed", "execution error reported");
		equal(document.querySelectorAll("sandbox-iframe").length, initialSandboxes, "sandbox removed after failure");
	} finally {
		SandboxIframe.prototype.execute = originalExecute;
	}
});

test("browser tools stay on their target across tab and window switches", async () => {
	const originalChrome = globalThis.chrome;
	const tabs = new Map<number, chrome.tabs.Tab>();
	const makeTab = (id: number, windowId: number, active: boolean): chrome.tabs.Tab => ({
		id,
		windowId,
		active,
		url: "https://example.test/same-url",
		title: `Tab ${id}`,
		index: 0,
		pinned: false,
		highlighted: false,
		incognito: false,
		selected: active,
		discarded: false,
		autoDiscardable: true,
		groupId: -1,
		frozen: false,
		splitViewId: -1,
		lastAccessed: 0,
	});
	tabs.set(1, makeTab(1, 10, true));
	tabs.set(2, makeTab(2, 10, false));
	tabs.set(3, makeTab(3, 20, true));
	let delayedRead: Promise<chrome.tabs.Tab> | undefined;
	let activeId = 1;
	let focusedWindow = 10;
	let createdWith: chrome.tabs.CreateProperties | undefined;
	const scriptTargets: number[] = [];
	const nativeTargets: number[] = [];
	const listeners = new Set<(event: { tabId: number; frameId: number; url: string }) => void>();
	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: {
			runtime: {},
			tabs: {
				onRemoved: { addListener: () => {}, removeListener: () => {} },
				query: async (query: chrome.tabs.QueryInfo) => {
					if (query.active) {
						equal(query.windowId, 10, "capture uses sidebar window");
						return [tabs.get(activeId)];
					}
					return [...tabs.values()].filter((tab) => tab.windowId === query.windowId);
				},
				get: async (id: number) => {
					if (id === 1 && delayedRead) return delayedRead;
					const tab = tabs.get(id);
					if (!tab) throw new Error("No tab");
					return tab;
				},
				create: async (options: chrome.tabs.CreateProperties) => {
					createdWith = options;
					const tab = makeTab(4, options.windowId!, options.active!);
					tabs.set(4, tab);
					return tab;
				},
				update: async (id: number, changes: chrome.tabs.UpdateProperties) => {
					const tab = tabs.get(id)!;
					if (changes.active) {
						activeId = id;
						for (const item of tabs.values()) if (item.windowId === tab.windowId) item.active = item.id === id;
					}
					if (changes.url) {
						tab.url = changes.url;
						queueMicrotask(() => {
							for (const listener of listeners) listener({ tabId: id, frameId: 0, url: changes.url! });
						});
					}
					return tab;
				},
			},
			windows: {
				get: async (id: number) => ({ id, focused: focusedWindow === id }),
				update: async (id: number) => {
					focusedWindow = id;
				},
			},
			webNavigation: {
				onErrorOccurred: { addListener: () => {}, removeListener: () => {} },
				onDOMContentLoaded: {
					addListener: (listener: typeof listeners extends Set<infer T> ? T : never) => listeners.add(listener),
					removeListener: (listener: typeof listeners extends Set<infer T> ? T : never) =>
						listeners.delete(listener),
				},
			},
			userScripts: {
				configureWorld: async () => {},
				execute: async (config: { target: { tabId: number } }) => {
					scriptTargets.push(config.target.tabId);
					return [{ result: { success: true, lastValue: "done" } }];
				},
			},
			debugger: {
				attach: (_target: unknown, _version: string, done: () => void) => done(),
				sendCommand: async (target: { tabId: number }) => {
					nativeTargets.push(target.tabId);
					return {};
				},
				detach: async () => {},
			},
		},
	});
	try {
		await browserTarget.capture(10);
		activeId = 2;
		tabs.get(1)!.active = false;
		tabs.get(2)!.active = true;
		focusedWindow = 20;
		equal((await browserTarget.get()).id, 1, "target unchanged by browsing elsewhere");
		tabs.get(1)!.active = true;
		equal(
			(await browserTarget.requireSelected()).id,
			1,
			"screenshots can target a selected tab in an unfocused window",
		);
		tabs.get(1)!.active = false;
		const browserJs = new BrowserJsRuntimeProvider([]);
		let response: unknown;
		await browserJs.handleMessage({ type: "browser-js", code: "() => document.title" }, (value) => {
			response = value;
		});
		assert(JSON.stringify(response).includes("done"), "page script completed");
		equal(scriptTargets, [1], "page script uses target");
		await new NativeInputEventsRuntimeProvider().handleMessage(
			{ type: "native-input", action: "press", key: "Enter" },
			() => {},
		);
		equal(nativeTargets, [1, 1], "native key events use target");
		let error: unknown;
		try {
			await new ExtractImageTool().execute("shot", { mode: "screenshot" });
		} catch (caught) {
			error = caught;
		}
		assert(String(error).includes("Select target tab 1"), "screenshot refuses wrong visible tab");

		await browserTarget.select();
		equal(activeId, 1, "reselection restores the working tab");
		equal(focusedWindow, 20, "reselection leaves the user's window focused");

		const navigate = new NavigateTool(new SkillDisclosure());
		const opened = await navigate.execute("open", { url: "https://example.test/same-url", newTab: true });
		assert(opened.details.kind === "navigation", "navigation result has a tab rather than a tab list");
		equal(opened.details.tabId, 4, "uses newly created ID even when another tab has same URL");
		equal(createdWith?.active, false, "new tab stays in background");
		equal(createdWith?.windowId, 10, "new tab stays in working window");
		equal(activeId, 4, "new working tab selected");
		equal(focusedWindow, 20, "user window unchanged");
		await navigate.execute("switch", { switchToTab: 1 });
		equal(browserTarget.tabId, 1, "explicit selection changes target");
		equal(activeId, 1, "working tab selected within its window");
		equal(focusedWindow, 20, "selection does not focus the working window");
		const runtime = new NavigateRuntimeProvider(navigate);
		await runtime.handleMessage({ type: "navigate", args: { switchToTab: 4 } }, (value) => {
			response = value;
		});
		assert(JSON.stringify(response).includes('"tabId":4'), "REPL navigation returns tab IDs");
		await navigate.execute("select", { switchToTab: 1 });
		await browserTarget.show();
		equal(activeId, 1, "explicit activation shows tab");
		equal(focusedWindow, 10, "explicit activation focuses window");
		equal((await browserTarget.requireFocused()).id, 1, "interactive selection uses the focused target");
		// A read started before selection changes must not relabel or overwrite the new target.
		let releaseRead!: (tab: chrome.tabs.Tab) => void;
		delayedRead = new Promise((resolve) => {
			releaseRead = resolve;
		});
		const reading = browserTarget.get();
		await browserTarget.select(2);
		releaseRead({ ...tabs.get(1)! });
		const oldTab = await reading;
		equal(oldTab.id, 1, "read returns the requested tab's identity");
		equal([browserTarget.tabId, browserTarget.windowId], [2, 10], "stale read cannot overwrite selection");
		delayedRead = undefined;
		await browserTarget.select(1);
		tabs.get(1)!.windowId = 30;
		try {
			await browserTarget.get();
			throw new Error("Expected moved target rejection");
		} catch (caught) {
			assert(String(caught).includes("outside the working window"), "moved target rejected");
		}
		equal(browserTarget.windowId, 10, "moving a target cannot change the working window");
		try {
			await navigate.execute("outside", { switchToTab: 3 });
			throw new Error("Expected cross-window rejection");
		} catch (caught) {
			assert(String(caught).includes("outside the working window"), "cross-window selection rejected");
		}
		equal(activeId, 1, "cross-window rejection has no activation side effect");
		const listed = await navigate.execute("list", { listTabs: true });
		assert(listed.details.kind === "tabs", "tab-list results have their own shape");
		equal(
			listed.details.tabs.map((tab) => tab.id),
			[2, 4],
			"only working-window tabs returned",
		);
		tabs.delete(1);
		error = undefined;
		try {
			await browserTarget.get();
		} catch (caught) {
			error = caught;
		}
		assert(String(error).includes("no longer available"), "closed target reported instead of changing tabs");
		browserJs.cleanupAll();
	} finally {
		Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
	}
});
