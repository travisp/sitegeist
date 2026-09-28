import {
	type AgentContext,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentTool,
	type AgentToolResult,
	runAgentLoop,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Model,
	type Static,
	type ToolResultMessage,
	Type,
} from "@earendil-works/pi-ai";
import {
	registerToolRenderer,
	renderCollapsibleHeader,
	renderHeader,
	type ToolRenderer,
	type ToolRenderResult,
} from "@earendil-works/pi-web-ui";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { SearchCode } from "lucide";

const RESEARCH_MAX_TURNS = 8;
const RESEARCH_MAX_INSPECTIONS = 5;
const RESEARCH_MAX_TOKENS = 1800;

const PAGE_RESEARCH_DESCRIPTION = `Research how the current page works.

Use this for page mechanics: controls, forms, selectors, labels, verification steps, and risky actions.
Do not use it to extract exact business data such as task lists, contact details, table rows, or records; use the REPL for exact data extraction.

Ask a specific question about what you need to understand on the current page.`;

const PAGE_RESEARCH_SYSTEM_PROMPT = `You are a temporary page-research agent. Your only job is to answer the user's question about how the current web page works.

You may call inspect_page to inspect visible text, controls, dialogs, and focused searches of the current page. Use a few focused inspections instead of guessing. Do not click, type, navigate, submit forms, or mutate page state.

Rules:
- This is page mechanics research, not business-data extraction.
- Only include facts supported by inspect_page results.
- Preserve exact selectors, labels, aria labels, placeholders, button text, and visible text when useful.
- Distinguish confirmed facts from uncertainty.
- Include verification steps the main agent can perform before acting.
- Identify destructive, irreversible, submit, send, delete, purchase, publish, or navigation actions to avoid unless explicitly requested.
- If inspection is insufficient, say what narrow REPL query or browser check should be run next.
- Do not include personal/contact/business records unless directly needed to explain a control.

Return concise markdown with these sections:
- Answer
- Useful selectors/text
- How to verify
- Do not click
- Uncertain / needs narrow check`;

const pageResearchSchema = Type.Object({
	question: Type.String({
		description:
			"Specific question about page mechanics, e.g. 'How do I select recipients and apply the SUBSCRIBED template? Include verification steps and what not to click.'",
	}),
});

const inspectPageSchema = Type.Object({
	query: Type.Optional(
		Type.String({
			description:
				"Optional text to focus the inspection around, such as a button label, field label, or dialog title.",
		}),
	),
});

export type PageResearchParams = Static<typeof pageResearchSchema>;
type InspectPageParams = Static<typeof inspectPageSchema>;

export type PageResearchDetails = {
	rawOutput: string;
};

type PageControl = {
	tag: string;
	selector: string;
	text?: string;
	type?: string;
	role?: string;
	id?: string;
	name?: string;
	ariaLabel?: string;
	placeholder?: string;
	title?: string;
	checked?: boolean;
	disabled?: boolean;
	nearbyText?: string;
};

type PageSnapshot = {
	url: string;
	title: string;
	query?: string;
	visibleText: string;
	dialogs: PageControl[];
	controls: PageControl[];
};

// Page snapshot collection

function collectPageSnapshot(query?: string): PageSnapshot {
	const maxVisibleTextChars = 12_000;
	const maxControls = 300;
	const maxDialogs = 20;
	const maxFieldChars = 180;
	const maxNearbyTextChars = 260;

	function clean(value: string | null | undefined, maxChars = maxFieldChars): string | undefined {
		const cleaned = value?.replace(/\s+/g, " ").trim();
		if (!cleaned) return undefined;
		return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}...` : cleaned;
	}

	function isVisible(element: Element): boolean {
		const rect = element.getBoundingClientRect();
		const style = window.getComputedStyle(element);
		return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
	}

	function selectorFor(element: Element): string {
		if (element.id) return `#${CSS.escape(element.id)}`;

		const parts: string[] = [];
		let current: Element | null = element;
		while (current && current !== document.body && parts.length < 4) {
			let part = current.tagName.toLowerCase();
			const name = current.getAttribute("name");
			const ariaLabel = current.getAttribute("aria-label");
			const type = current.getAttribute("type");

			if (name) {
				part += `[name="${name.replace(/"/g, '\\"')}"]`;
			} else if (ariaLabel) {
				part += `[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
			} else if (type) {
				part += `[type="${type.replace(/"/g, '\\"')}"]`;
			} else {
				const classes = Array.from(current.classList).slice(0, 2);
				if (classes.length > 0) part += classes.map((className) => `.${CSS.escape(className)}`).join("");
			}

			const tagName = current.tagName;
			const parent: Element | null = current.parentElement;
			if (parent) {
				const siblings = Array.from(parent.children).filter((child): child is Element => child.tagName === tagName);
				if (siblings.length > 1 && !part.includes("[")) {
					part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
				}
			}

			parts.unshift(part);
			current = parent;
		}

		return parts.join(" > ");
	}

	function nearbyTextFor(element: Element): string | undefined {
		const labelledBy = element.getAttribute("aria-labelledby");
		if (labelledBy) {
			const text = labelledBy
				.split(/\s+/)
				.map((id) => document.getElementById(id)?.textContent)
				.filter((text): text is string => Boolean(text))
				.join(" ");
			const cleaned = clean(text, maxNearbyTextChars);
			if (cleaned) return cleaned;
		}

		if (element.id) {
			const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
			const labelText = clean(label?.textContent, maxNearbyTextChars);
			if (labelText) return labelText;
		}

		return clean(element.parentElement?.textContent, maxNearbyTextChars);
	}

	function elementMatchesQuery(element: Element, normalizedQuery: string): boolean {
		const ownText = Array.from(element.childNodes)
			.filter((node) => node.nodeType === Node.TEXT_NODE)
			.map((node) => node.textContent)
			.join(" ");
		return [
			ownText,
			element.getAttribute("aria-label"),
			element.getAttribute("placeholder"),
			element.getAttribute("title"),
			element.getAttribute("name"),
		]
			.filter((value): value is string => Boolean(value))
			.some((value) => value.toLowerCase().includes(normalizedQuery));
	}

	function controlFor(element: Element): PageControl {
		const input = element instanceof HTMLInputElement ? element : undefined;
		const textarea = element instanceof HTMLTextAreaElement ? element : undefined;
		const select = element instanceof HTMLSelectElement ? element : undefined;

		return {
			tag: element.tagName.toLowerCase(),
			selector: selectorFor(element),
			text: clean(element.textContent),
			type: clean(element.getAttribute("type")),
			role: clean(element.getAttribute("role")),
			id: clean(element.id),
			name: clean(element.getAttribute("name")),
			ariaLabel: clean(element.getAttribute("aria-label")),
			placeholder: clean(element.getAttribute("placeholder")),
			title: clean(element.getAttribute("title")),
			checked: input?.checked,
			disabled: input?.disabled ?? textarea?.disabled ?? select?.disabled,
			nearbyText: nearbyTextFor(element),
		};
	}

	const normalizedQuery = query?.trim().toLowerCase();
	const pageText = document.body?.innerText ?? "";
	const visibleText = normalizedQuery
		? pageText
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.toLowerCase().includes(normalizedQuery))
				.slice(0, 80)
				.join("\n")
		: (clean(pageText, maxVisibleTextChars) ?? "");
	const controlSelector = [
		"input",
		"textarea",
		"select",
		"button",
		"a[href]",
		"[role='button']",
		"[role='menuitem']",
		"[role='option']",
		"[role='combobox']",
		"[contenteditable='true']",
		"[aria-label]",
		"[placeholder]",
	].join(",");
	const dialogSelector = "dialog,[role='dialog'],[aria-modal='true']";

	let controlElements = Array.from(document.querySelectorAll(controlSelector)).filter(isVisible);
	if (normalizedQuery) {
		const textMatches = Array.from(document.querySelectorAll("*"))
			.filter((element) => !element.matches(controlSelector))
			.filter(isVisible)
			.filter((element) => elementMatchesQuery(element, normalizedQuery));
		controlElements = [
			...controlElements.filter(
				(element) =>
					elementMatchesQuery(element, normalizedQuery) ||
					nearbyTextFor(element)?.toLowerCase().includes(normalizedQuery),
			),
			...textMatches,
		];
	}
	const controls = controlElements.slice(0, maxControls).map(controlFor);
	const dialogs = Array.from(document.querySelectorAll(dialogSelector))
		.filter(isVisible)
		.slice(0, maxDialogs)
		.map(controlFor);

	return {
		url: location.href,
		title: document.title,
		query: query?.trim() || undefined,
		visibleText,
		dialogs,
		controls,
	};
}

function buildPrompt(question: string): string {
	return `Research this current page question for the main agent:
${question}

Use inspect_page as needed. Return the final page mechanics answer when you have enough evidence.`;
}

function textFromAssistant(message: AssistantMessage): string {
	return message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

function standardMessages(messages: AgentMessage[]) {
	return messages.filter(
		(message) =>
			message.role === "system" ||
			message.role === "user" ||
			message.role === "assistant" ||
			message.role === "toolResult",
	);
}

function lastAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") return textFromAssistant(message as AssistantMessage);
	}
	return "";
}

async function captureSnapshot(query?: string): Promise<PageSnapshot> {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) throw new Error("No active tab");
	if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
		throw new Error("Cannot research this page");
	}

	const results = await chrome.scripting.executeScript<[string | undefined], PageSnapshot>({
		target: { tabId: tab.id, allFrames: false },
		func: collectPageSnapshot,
		args: [query],
	});
	const snapshot = results[0]?.result;
	if (!snapshot) throw new Error("Failed to capture page snapshot");
	return snapshot;
}

// Internal inspection tool

class InspectPageTool implements AgentTool<typeof inspectPageSchema, undefined> {
	label = "Inspect Page";
	name = "inspect_page";
	description = `Inspect the current page for research. This is read-only.

Call without a query for a broad overview of visible text, dialogs, and controls.
Call with a query to focus around a label, button text, field name, dialog title, or other visible text.`;
	parameters = inspectPageSchema;

	async execute(_toolCallId: string, params: unknown, signal?: AbortSignal): Promise<AgentToolResult<undefined>> {
		if (signal?.aborted) throw new Error("Page inspection aborted");

		const args = params as InspectPageParams;
		const snapshot = await captureSnapshot(args.query);
		return {
			content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
			details: undefined,
		};
	}
}

// Internal research runner

type PageResearchRunOptions = {
	question: string;
	model: Model<Api>;
	getApiKey: (provider: string) => Promise<string | undefined>;
	streamFn: StreamFn;
	signal?: AbortSignal;
};

type PageResearchRunResult = {
	answer: string;
	transcript: string;
};

function hasToolCall(message: AgentMessage | undefined): boolean {
	return message?.role === "assistant" && message.content.some((content) => content.type === "toolCall");
}

function createResearchConfig(options: PageResearchRunOptions): AgentLoopConfig {
	let turnCount = 0;
	let inspectionCount = 0;

	return {
		model: options.model,
		reasoning: "minimal",
		maxTokens: RESEARCH_MAX_TOKENS,
		convertToLlm: standardMessages,
		getApiKey: options.getApiKey,
		beforeToolCall: async ({ toolCall }) => {
			if (toolCall.name !== "inspect_page") return undefined;
			if (inspectionCount >= RESEARCH_MAX_INSPECTIONS) {
				return {
					block: true,
					reason: "Inspection limit reached. Provide the final answer from the evidence already gathered.",
				};
			}
			inspectionCount++;
			return undefined;
		},
		finishTurn: ({ message }) => {
			if (message.stopReason === "error" || message.stopReason === "aborted") return;
			return ++turnCount >= RESEARCH_MAX_TURNS ? { action: "end" } : undefined;
		},
		toolExecution: "sequential",
	};
}

async function runFinalResearchAnswer(context: AgentContext, options: PageResearchRunOptions): Promise<string> {
	const finalPrompt: AgentMessage = {
		role: "user",
		content: "Stop researching. Answer now using only the evidence collected so far.",
		timestamp: Date.now(),
	};
	const finalConfig: AgentLoopConfig = {
		model: options.model,
		reasoning: "minimal",
		maxTokens: RESEARCH_MAX_TOKENS,
		convertToLlm: standardMessages,
		getApiKey: options.getApiKey,
		toolExecution: "sequential",
	};

	context.tools = [];
	const finalMessages = await runAgentLoop(
		[finalPrompt],
		context,
		finalConfig,
		() => {},
		options.signal,
		options.streamFn,
	);
	context.messages.push(...finalMessages);
	return lastAssistantText(finalMessages);
}

async function runPageResearch(options: PageResearchRunOptions): Promise<PageResearchRunResult> {
	const prompt: AgentMessage = {
		role: "user",
		content: buildPrompt(options.question),
		timestamp: Date.now(),
	};
	const context: AgentContext = {
		messages: [{ role: "system", content: PAGE_RESEARCH_SYSTEM_PROMPT, timestamp: Date.now() }],
		tools: [new InspectPageTool()],
	};
	const config = createResearchConfig(options);

	const messages = await runAgentLoop([prompt], context, config, () => {}, options.signal, options.streamFn);
	// The low-level loop returns new messages without appending them to the supplied context.
	context.messages.push(...messages);
	const lastMessage = messages[messages.length - 1];
	const answer = lastAssistantText(messages);
	const needsFinalAnswer = lastMessage?.role !== "assistant" || hasToolCall(lastMessage) || !answer;
	const finalAnswer = needsFinalAnswer ? await runFinalResearchAnswer(context, options) : answer;
	if (!finalAnswer) throw new Error("Page research returned no answer");

	return {
		answer: finalAnswer,
		transcript: JSON.stringify(context.messages, null, 2),
	};
}

// Public tool

export class ResearchPageTool implements AgentTool<typeof pageResearchSchema, PageResearchDetails> {
	label = "Research Page";
	name = "research_page";
	description = PAGE_RESEARCH_DESCRIPTION;
	parameters = pageResearchSchema;
	executionMode = "sequential" as const;

	constructor(
		private readonly getModel: () => Model<Api>,
		private readonly getApiKey: (provider: string) => Promise<string | undefined>,
		private readonly streamFn: StreamFn,
	) {}

	async execute(
		_toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<AgentToolResult<PageResearchDetails>> {
		if (signal?.aborted) throw new Error("Page research aborted");

		const args = params as PageResearchParams;
		const research = await runPageResearch({
			question: args.question,
			model: this.getModel(),
			getApiKey: this.getApiKey,
			streamFn: this.streamFn,
			signal,
		});

		return {
			content: [
				{
					type: "text",
					text: `Page research result\n\nQuestion: ${args.question}\n\n${research.answer}\n\nInternal research transcript is preserved in tool details.`,
				},
			],
			details: { rawOutput: research.transcript },
		};
	}
}

// Renderer

export const researchPageRenderer: ToolRenderer<PageResearchParams, PageResearchDetails> = {
	render(
		params: PageResearchParams | undefined,
		result: ToolResultMessage<PageResearchDetails> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		const title = params?.question ? `Research page: ${params.question}` : "Research page";

		if (result) {
			const output = result.content.find((content) => content.type === "text")?.text || "";
			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, SearchCode, title, contentRef, chevronRef, false)}
						<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300 space-y-3">
							${output ? html`<console-block .content=${output} .variant=${result.isError ? "error" : "default"}></console-block>` : ""}
							${
								result.details?.rawOutput
									? html`<div class="text-xs text-muted-foreground">
									Internal research transcript preserved for UI/debug (${result.details.rawOutput.length} chars).
								  </div>`
									: ""
							}
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		if (params) {
			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, SearchCode, title, contentRef, chevronRef, false)}
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, SearchCode, "Preparing page research..."), isCustom: false };
	},
};

registerToolRenderer("research_page", researchPageRenderer);
