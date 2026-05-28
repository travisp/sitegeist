import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, type ToolResultMessage, Type } from "@earendil-works/pi-ai";
import {
	registerToolRenderer,
	renderCollapsibleHeader,
	renderHeader,
	type ToolRenderer,
	type ToolRenderResult,
} from "@earendil-works/pi-web-ui";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Search } from "lucide";

const DEFAULT_LIMIT_CHARS = 10_000;
const MAX_LIMIT_CHARS = 20_000;
const SEARCH_SNIPPET_RADIUS_CHARS = 500;
const RAW_OUTPUT_TOOL_NAMES = new Set(["repl", "research_page"]);

const readRawToolResultSchema = Type.Object({
	toolCallId: Type.Optional(
		Type.String({
			description: "Tool call id to read. If omitted, reads the most recent raw tool output.",
		}),
	),
	query: Type.Optional(
		Type.String({
			description:
				"Optional case-insensitive literal search query. If omitted, returns a slice by offset and limit.",
		}),
	),
	offset: Type.Optional(
		Type.Number({
			description: "Character offset for slice mode, or starting offset for search mode. Defaults to 0.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum characters to return. Defaults to 10000 and is capped at 20000.",
		}),
	),
});

export type ReadRawToolResultParams = Static<typeof readRawToolResultSchema>;

type RawOutputDetails = {
	rawOutput?: string;
};

type RawOutputCandidate = {
	toolCallId: string;
	toolName: string;
	rawOutput: string;
};

export type ReadRawToolResultDetails = {
	sourceToolCallId: string;
	sourceToolName: string;
	mode: "slice" | "search";
};

function getRawOutputCandidate(message: AgentMessage): RawOutputCandidate | undefined {
	if (message.role !== "toolResult") return undefined;
	if (!RAW_OUTPUT_TOOL_NAMES.has(message.toolName)) return undefined;

	const toolResult = message as ToolResultMessage<RawOutputDetails>;
	const rawOutput = toolResult.details?.rawOutput;
	if (!rawOutput) return undefined;

	return {
		toolCallId: toolResult.toolCallId,
		toolName: toolResult.toolName,
		rawOutput,
	};
}

function findRawOutput(messages: AgentMessage[], toolCallId: string | undefined): RawOutputCandidate | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const candidate = getRawOutputCandidate(messages[i]);
		if (candidate && (!toolCallId || candidate.toolCallId === toolCallId)) {
			return candidate;
		}
	}
	return undefined;
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT_CHARS;
	return Math.max(1, Math.min(Math.floor(limit), MAX_LIMIT_CHARS));
}

function clampOffset(offset: number | undefined, max: number): number {
	if (offset === undefined || !Number.isFinite(offset)) return 0;
	return Math.max(0, Math.min(Math.floor(offset), max));
}

function outputHeader(candidate: RawOutputCandidate, mode: "slice" | "search"): string {
	return `Raw tool result ${mode}
Source toolCallId: ${candidate.toolCallId}
Source tool: ${candidate.toolName}
Raw size: ${candidate.rawOutput.length} chars`;
}

function buildSliceOutput(candidate: RawOutputCandidate, offset: number, limit: number): string {
	const start = clampOffset(offset, candidate.rawOutput.length);
	const end = Math.min(start + limit, candidate.rawOutput.length);

	return `${outputHeader(candidate, "slice")}
Showing chars: ${start}-${end}

${candidate.rawOutput.slice(start, end)}`;
}

function buildSearchOutput(candidate: RawOutputCandidate, query: string, offset: number, limit: number): string {
	const raw = candidate.rawOutput;
	const lowerRaw = raw.toLowerCase();
	const lowerQuery = query.toLowerCase();
	let position = lowerRaw.indexOf(lowerQuery, clampOffset(offset, raw.length));
	let returnedChars = 0;
	const snippets: string[] = [];

	while (position !== -1 && returnedChars < limit) {
		const start = Math.max(0, position - SEARCH_SNIPPET_RADIUS_CHARS);
		const end = Math.min(raw.length, position + query.length + SEARCH_SNIPPET_RADIUS_CHARS);
		const block = `--- MATCH chars ${start}-${end} ---\n${raw.slice(start, end)}`;
		const remainingChars = limit - returnedChars;

		snippets.push(block.slice(0, remainingChars));
		returnedChars += Math.min(block.length, remainingChars);
		position = lowerRaw.indexOf(lowerQuery, position + lowerQuery.length);
	}

	return `${outputHeader(candidate, "search")}
Query: ${JSON.stringify(query)}
Returned snippets: ${snippets.length}

${snippets.length > 0 ? snippets.join("\n\n") : "No matches found."}`;
}

export class ReadRawToolResultTool implements AgentTool<typeof readRawToolResultSchema, ReadRawToolResultDetails> {
	label = "Read Raw Tool Result";
	name = "read_raw_tool_result";
	description = `Read or search raw preserved output from a previous compacted REPL result or page research transcript.

Use this when a REPL result said "Large REPL output compacted" or a page research result needs internal transcript inspection for accurate work.

Inputs:
- toolCallId: tool call id from the raw-output result. If omitted, uses the most recent readable raw output.
- query: optional case-insensitive literal search query.
- offset: character offset for slice mode or search start.
- limit: maximum returned characters, capped at 20000.

Accuracy rule: use this tool to inspect omitted raw output or page research transcripts instead of guessing from compact model-facing content.`;
	parameters = readRawToolResultSchema;

	constructor(private readonly getMessages: () => AgentMessage[]) {}

	async execute(
		_toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: ReadRawToolResultDetails }> {
		if (signal?.aborted) {
			throw new Error("Read raw tool result aborted");
		}

		const args = params as ReadRawToolResultParams;
		const candidate = findRawOutput(this.getMessages(), args.toolCallId);
		if (!candidate) {
			const target = args.toolCallId ? ` for toolCallId ${JSON.stringify(args.toolCallId)}` : "";
			throw new Error(`No raw tool output found${target}.`);
		}

		const limit = clampLimit(args.limit);
		const query = args.query?.trim();
		const mode = query ? "search" : "slice";
		const output = query
			? buildSearchOutput(candidate, query, args.offset ?? 0, limit)
			: buildSliceOutput(candidate, args.offset ?? 0, limit);

		return {
			content: [{ type: "text", text: output }],
			details: {
				sourceToolCallId: candidate.toolCallId,
				sourceToolName: candidate.toolName,
				mode,
			},
		};
	}
}

export const readRawToolResultRenderer: ToolRenderer<ReadRawToolResultParams, ReadRawToolResultDetails> = {
	render(
		params: ReadRawToolResultParams | undefined,
		result: ToolResultMessage<ReadRawToolResultDetails> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		const title = params?.query ? `Search raw output: ${params.query}` : "Read raw output";

		if (result) {
			const output = result.content.find((c) => c.type === "text")?.text || "";

			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, Search, title, contentRef, chevronRef, false)}
						<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300 space-y-3">
							${output ? html`<console-block .content=${output} .variant=${result.isError ? "error" : "default"}></console-block>` : ""}
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
						${renderCollapsibleHeader(state, Search, title, contentRef, chevronRef, false)}
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, Search, "Preparing raw output reader..."), isCustom: false };
	},
};

registerToolRenderer("read_raw_tool_result", readRawToolResultRenderer);
