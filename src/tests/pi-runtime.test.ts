import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Message,
	type SystemMessage,
	type TranscriptContext,
	Type,
} from "@earendil-works/pi-ai";
import { getModel, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { AgentInterface, createStreamFn, type MessageEditor, setAppStorage } from "@earendil-works/pi-web-ui";
import { LitElement } from "lit";
import { browserMessageTransformer } from "../messages/message-transformer.js";
import { Session } from "../session.js";
import { SitegeistAppStorage } from "../storage/app-storage.js";
import { browserTarget } from "../tools/browser-target.js";
import { DebuggerTool } from "../tools/debugger.js";
import { ResearchPageTool } from "../tools/research-page.js";
import { renderingTests } from "./rendering-tests.js";
import { sessionLockTests } from "./session-lock-tests.js";
import { assert, type BrowserTest, equal } from "./test-utils.js";
import { workflowTests } from "./workflow-tests.js";

const tests: BrowserTest[] = [];
function test(name: string, run: () => Promise<void>) {
	tests.push({ name, run });
}

const system: SystemMessage = { role: "system", content: "Browser test instructions", timestamp: 1 };
const storage = new SitegeistAppStorage();
setAppStorage(storage);
const streamFn = createStreamFn(async () => undefined);
const echoSchema = Type.Object({ text: Type.String() });
const echoTool: AgentTool<typeof echoSchema, { echoed: string }> = {
	name: "echo",
	label: "Echo",
	description: "Echo test input",
	parameters: echoSchema,
	async execute(_id, args) {
		return { content: [{ type: "text", text: args.text }], details: { echoed: args.text } };
	},
};

// These run only in the isolated test tab, never against extension storage or live providers.
test("system messages, tool declarations, attachments, and navigation reach the model", async () => {
	const input: AgentMessage[] = [
		{ ...system, toolsAdded: [echoTool] },
		{
			role: "user-with-attachments",
			content: "Read this",
			timestamp: 2,
			attachments: [
				{
					id: "doc",
					type: "document",
					fileName: "notes.txt",
					mimeType: "text/plain",
					size: 5,
					content: "",
					extractedText: "notes",
				},
				{ id: "image", type: "image", fileName: "image.png", mimeType: "image/png", size: 1, content: "AA==" },
			],
		},
		fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }, { id: "echo-call" }), { stopReason: "toolUse" }),
		{ role: "navigation", title: "Test page", url: "https://example.test", skillsOutput: "test skill" },
		{
			role: "toolResult",
			toolCallId: "echo-call",
			toolName: "echo",
			content: [{ type: "text", text: "hello" }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "system",
			content: "",
			sections: { rules: "Updated rules" },
			toolsRemoved: [{ name: "echo" }],
			timestamp: 4,
		},
	];
	const messages = await browserMessageTransformer(input);
	equal(
		messages.map((message) => message.role),
		["system", "user", "assistant", "toolResult", "user", "system"],
		"message order",
	);
	equal(getCurrentSystemPrompt(messages), "Browser test instructions\n\nUpdated rules", "replayed prompt");
	equal(getCurrentTools(messages), [], "tool removal");
	const user = messages[1];
	assert(user.role === "user" && Array.isArray(user.content), "converted attachment message");
	assert(
		user.content.some((block) => block.type === "text" && block.text.includes("[Document: notes.txt]\nnotes")),
		"document retained",
	);
	assert(
		user.content.some((block) => block.type === "image" && block.data === "AA=="),
		"image retained",
	);
	assert(JSON.stringify(messages[4]).includes("test skill"), "navigation context retained");
});

test("agent executes tools sequentially through the pinned web UI stream adapter", async () => {
	const faux = registerFauxProvider();
	try {
		const contexts: TranscriptContext[] = [];
		let active = 0;
		let maxActive = 0;
		const tool: AgentTool<typeof echoSchema, { echoed: string }> = {
			...echoTool,
			async execute(id, args) {
				maxActive = Math.max(maxActive, ++active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active--;
				return echoTool.execute(id, args);
			},
		};
		faux.setResponses([
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage(
					[fauxToolCall("echo", { text: "one" }), fauxToolCall("echo", { text: "two" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("Finished both tools");
			},
		]);
		const agent = new Agent({
			initialState: { systemPrompt: system.content as string, model: faux.getModel(), tools: [tool] },
			convertToLlm: browserMessageTransformer,
			toolExecution: "sequential",
			streamFn,
			getApiKey: () => "test-key",
		});
		await agent.prompt("Run both tools");
		equal(faux.state.callCount, 2, "provider turns");
		equal(maxActive, 1, "sequential tool execution");
		equal(getCurrentSystemPrompt(contexts[0].messages), system.content, "system prompt dispatched");
		equal(
			getCurrentTools(contexts[0].messages).map((tool) => tool.name),
			["echo"],
			"tools dispatched",
		);
		equal(
			contexts[1].messages.filter((message) => message.role === "toolResult").map((message) => message.details),
			[{ echoed: "one" }, { echoed: "two" }],
			"tool results dispatched",
		);
		assert(!agent.state.isStreaming && agent.state.pendingToolCalls.size === 0, "agent settled");
	} finally {
		faux.unregister();
	}
});

test("Anthropic, OpenAI, and Gemini adapters receive transcript prompts and tools", async () => {
	const originalFetch = globalThis.fetch;
	const requests: string[] = [];
	globalThis.fetch = async (input) => {
		requests.push(input instanceof Request ? input.url : String(input));
		return new Response(JSON.stringify({ error: { message: "Intentional test rejection" } }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	};
	try {
		const proxyStream = createStreamFn(async () => "https://proxy.example.test");
		const models = [
			getModel("anthropic", "claude-sonnet-4-6"),
			getModel("openai", "gpt-5.3-codex"),
			getModel("google", "gemini-2.5-pro"),
		];
		for (const model of models) {
			let payload: unknown;
			const response = await proxyStream(
				model,
				{
					messages: [
						{ ...system, toolsAdded: [echoTool] },
						{ role: "user", content: "Echo hello", timestamp: 2 },
					],
				},
				{
					apiKey: model.provider === "anthropic" ? "sk-ant-oat-test" : "test-key",
					maxRetries: 0,
					onPayload: (value) => {
						payload = value;
					},
				},
			);
			const result = await response.result();
			const serialized = JSON.stringify(payload);
			assert(serialized?.includes("Browser test instructions"), `${model.provider} system prompt`);
			assert(serialized.includes("Echo test input"), `${model.provider} tool declaration`);
			equal(result.stopReason, "error", "mock HTTP error surfaced normally");
		}
		equal(requests.length, 3, "one intercepted request per provider");
		assert(requests[0].startsWith("https://proxy.example.test/"), "Anthropic OAuth uses the configured proxy");
		assert(requests[1].startsWith("https://api.openai.com/"), "OpenAI remains direct");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("agent cancellation during streaming settles the run", async () => {
	const faux = registerFauxProvider({ tokensPerSecond: 1000 });
	try {
		faux.setResponses([fauxAssistantMessage("A long response that should be interrupted before it finishes.")]);
		const agent = new Agent({ initialState: { model: faux.getModel(), systemPrompt: "Test" }, streamFn });
		agent.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") agent.abort();
		});
		await agent.prompt("Start");
		const last = agent.state.messages.at(-1);
		assert(last?.role === "assistant" && last.stopReason === "aborted", "aborted response retained");
		assert(!agent.state.isStreaming, "cancelled agent settled");
	} finally {
		faux.unregister();
	}
});

test("session completion refreshes the editor after slow final listeners settle", async () => {
	for (const persist of [true, false]) {
		const faux = registerFauxProvider();
		const view = new AgentInterface();
		const save = storage.sessions.save;
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waiting = new Promise<void>((resolve) => {
			started = resolve;
		});
		let ending = false;
		let id: string | undefined;
		const agent = new Agent({ initialState: { model: faux.getModel() }, streamFn, getApiKey: () => "test-key" });
		const session = new Session(
			agent,
			{
				storage,
				onCreated: (created) => {
					id = created;
				},
				onChange: () => view.requestUpdate(),
			},
			{ persist },
		);
		storage.sessions.save = async (data, metadata) => {
			if (ending) {
				started();
				await gate;
			}
			return save.call(storage.sessions, data, metadata);
		};
		agent.subscribe(async (event) => {
			if (event.type === "agent_end") ending = true;
			await session.handleEvent(event);
			if (ending && !persist) {
				started();
				await gate;
			}
		});
		view.session = agent;
		document.body.append(view);
		let running: Promise<void> | undefined;
		try {
			await view.updateComplete;
			const editor = view.querySelector<MessageEditor>("message-editor");
			assert(editor, "message editor rendered");
			faux.setResponses([fauxAssistantMessage("Finished")]);
			running = agent.prompt("Complete the request");
			await waiting;
			// Let a timer-based refresh run while the final listener is still waiting.
			await new Promise((resolve) => setTimeout(resolve, 0));
			await view.updateComplete;
			await editor.updateComplete;
			assert(agent.state.isStreaming && editor.isStreaming, "run and editor remain active during final listener");
			release();
			await running;
			await view.updateComplete;
			await editor.updateComplete;
			assert(!agent.state.isStreaming, "agent is idle");
			assert(!editor.isStreaming, "editor leaves Stop mode without another event or manual refresh");
			equal(editor.value, "", "editor remains usable after completion");
		} finally {
			release();
			await running?.catch(() => {});
			storage.sessions.save = save;
			view.remove();
			if (id) await storage.sessions.delete(id);
			faux.unregister();
		}
	}
});

test("session storage and the pinned UI preserve a restored system transcript", async () => {
	const faux = registerFauxProvider();
	const id = crypto.randomUUID();
	const view = new AgentInterface();
	try {
		const messages: Message[] = [
			{ ...system, toolsAdded: [echoTool] },
			{ role: "user", content: "Earlier question", timestamp: 2 },
			fauxAssistantMessage("Earlier answer"),
			{ role: "system", content: "Keep these session instructions", timestamp: 3 },
		];
		// Tool declarations in persisted messages contain data, never executable functions.
		const persisted = JSON.parse(JSON.stringify(messages)) as Message[];
		const source = new Agent({
			initialState: { model: faux.getModel(), messages: persisted, thinkingLevel: "off" },
			streamFn,
		});
		await storage.sessions.saveSession(id, source.state, undefined);
		const restored = await storage.sessions.loadSession(id);
		assert(restored, "session loaded");
		equal(restored.messages, persisted, "persisted transcript");
		const agent = new Agent({
			initialState: { ...restored, systemPrompt: "Unused seed", tools: [echoTool] },
			convertToLlm: browserMessageTransformer,
			streamFn,
			getApiKey: () => "test-key",
		});
		let sentPrompt = "";
		faux.setResponses([
			(context) => {
				sentPrompt = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage("Restored answer");
			},
		]);
		// Match the sidebar's immutable-list notification for completed messages.
		agent.subscribe((event) => {
			if (event.type === "message_end") agent.state.messages = agent.state.messages.slice();
		});
		view.session = agent;
		view.enableModelSelector = false;
		view.enableThinkingSelector = false;
		document.body.append(view);
		await view.updateComplete;
		await agent.prompt("Continue");
		view.requestUpdate();
		await view.updateComplete;
		for (const element of view.querySelectorAll("*")) {
			if (element instanceof LitElement) await element.updateComplete;
		}
		equal(
			sentPrompt,
			"Browser test instructions\n\nKeep these session instructions",
			"restored prompt wins over constructor seed",
		);
		assert(view.textContent?.includes("Restored answer"), "completed answer rendered");
		assert(!view.textContent?.includes("Keep these session instructions"), "system instructions hidden from chat");
		equal(view.querySelectorAll("assistant-message").length, 2, "no duplicate streaming answer");
		assert(!agent.state.isStreaming, "restored agent settled");
	} finally {
		view.remove();
		await storage.sessions.delete(id);
		faux.unregister();
	}
});

test("research preserves its prompt, inspection cap, turn cap, and final tool-free answer", async () => {
	const originalChrome = globalThis.chrome;
	let inspections = 0;
	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: {
			tabs: {
				get: async () => ({ id: 1, windowId: 10, url: "https://example.test" }),
				query: async () => [{ id: 1, windowId: 10, url: "https://example.test" }],
			},
			scripting: {
				executeScript: async () => {
					inspections++;
					return [
						{
							result: {
								url: "https://example.test",
								title: "Test page",
								visibleText: "Save",
								dialogs: [],
								controls: [],
							},
						},
					];
				},
			},
		},
	});
	const faux = registerFauxProvider();
	try {
		await browserTarget.capture(10);
		const contexts: TranscriptContext[] = [];
		faux.setResponses([
			...Array.from({ length: 8 }, () => (context: TranscriptContext) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage(fauxToolCall("inspect_page", {}), { stopReason: "toolUse" });
			}),
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("Use the Save button; verify the confirmation.");
			},
		]);
		const tool = new ResearchPageTool(
			() => faux.getModel(),
			async () => "test-key",
			streamFn,
		);
		const result = await tool.execute("research", { question: "How do I save?" });
		equal(inspections, 5, "inspection limit");
		equal(faux.state.callCount, 9, "eight research turns and one final answer");
		assert(
			contexts.every((context) =>
				getCurrentSystemPrompt(context.messages).includes("temporary page-research agent"),
			),
			"research prompt retained on every turn",
		);
		equal(
			getCurrentTools(contexts[0].messages).map((tool) => tool.name),
			["inspect_page"],
			"inspection tool declared",
		);
		equal(getCurrentTools(contexts[8].messages), [], "final answer has no tools");
		equal(
			contexts[8].messages.filter((message) => message.role === "toolResult" && message.isError).length,
			3,
			"extra inspections blocked",
		);
		assert(JSON.stringify(result.content).includes("Use the Save button"), "final answer returned");
		const transcript = JSON.parse(result.details.rawOutput) as AgentMessage[];
		assert(transcript[0].role === "system", "system transcript retained in details");
		equal(transcript.filter((message) => message.role === "toolResult").length, 8, "research evidence retained");
		assert(JSON.stringify(transcript.at(-1)).includes("Use the Save button"), "final answer retained in transcript");
	} finally {
		Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
		faux.unregister();
	}
});

test("research cancellation does not inspect the page or contact a provider", async () => {
	const faux = registerFauxProvider();
	try {
		const tool = new ResearchPageTool(
			() => faux.getModel(),
			async () => "test-key",
			streamFn,
		);
		let error: unknown;
		try {
			await tool.execute("research", { question: "Inspect" }, AbortSignal.abort());
		} catch (caught) {
			error = caught;
		}
		assert(error instanceof Error && error.message.includes("aborted"), "abort reported");
		equal(faux.state.callCount, 0, "no provider calls");
	} finally {
		faux.unregister();
	}
});

test("debugger results retain JSON details for eval and cookies", async () => {
	const originalChrome = globalThis.chrome;
	const value = { result: { type: "object", value: { answer: 42 } } };
	const cookies = [{ name: "test-cookie", value: "test-value", domain: "example.test" }];
	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: {
			tabs: {
				get: async () => ({ id: 1, windowId: 10, url: "https://example.test" }),
				query: async () => [{ id: 1, windowId: 10, url: "https://example.test" }],
			},
			debugger: { attach: async () => {}, sendCommand: async () => value },
			cookies: { getAll: async () => cookies },
		},
	});
	try {
		await browserTarget.capture(10);
		const tool = new DebuggerTool();
		equal(
			(await tool.execute("eval", { action: "eval", code: "({ answer: 42 })" })).details.value,
			value,
			"CDP response retained",
		);
		equal((await tool.execute("cookies", { action: "cookies" })).details.value, cookies, "cookies retained");
	} finally {
		Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
	}
});

Object.assign(globalThis, {
	piRuntimeTests: (async () => {
		const results: { name: string; error?: string }[] = [];
		for (const { name, run } of [...tests, ...sessionLockTests, ...workflowTests, ...renderingTests]) {
			try {
				await run();
				results.push({ name });
			} catch (error) {
				results.push({ name, error: error instanceof Error ? error.stack : String(error) });
			}
		}
		return results;
	})(),
});
