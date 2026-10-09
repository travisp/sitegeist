import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, type ToolResultMessage, Type } from "@earendil-works/pi-ai";
import { registerToolRenderer, type ToolRenderer, type ToolRenderResult } from "@earendil-works/pi-web-ui";
import { i18n, icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { Loader2 } from "lucide";
import { isArtifactViewerUrl } from "../artifacts/protocol.js";
import { SkillPill } from "../components/SkillPill.js";
import { TabPill } from "../components/TabPill.js";
import { NAVIGATE_TOOL_DESCRIPTION } from "../prompts/prompts.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import type { Skill } from "../storage/stores/skills-store.js";
import type { SkillDisclosure } from "../utils/format-skills.js";
import "../utils/i18n-extension.js";
import { browserTarget, type TargetTab } from "./browser-target.js";

// Track tool-initiated navigations to filter out duplicate navigation messages
let isNavigating = false;

export function isToolNavigating(): boolean {
	return isNavigating;
}

// ============================================================================
// TYPES
// ============================================================================

const navigateSchema = Type.Object({
	url: Type.Optional(Type.String({ description: "URL to navigate to (in current tab or new tab if newTab is true)" })),
	newTab: Type.Optional(Type.Boolean({ description: "Set to true to open URL in a new tab instead of current tab" })),
	listTabs: Type.Optional(Type.Boolean({ description: "Set to true to list tabs in the working window" })),
	switchToTab: Type.Optional(
		Type.Number({
			description:
				"Tab ID in the working window (get IDs from listTabs); selects the tab without focusing the window",
		}),
	),
});

export type NavigateParams = Static<typeof navigateSchema>;

export interface TabInfo {
	id: number;
	url: string;
	title: string;
	active: boolean;
	favicon?: string;
}

export type NavigateResult =
	| { kind: "tabs"; tabs: TabInfo[] }
	| {
			kind: "navigation";
			finalUrl: string | undefined;
			title: string | undefined;
			favicon: string | undefined;
			tabId: number;
			skills: Skill[];
	  };

type NavigateAction =
	| { kind: "list" }
	| { kind: "select"; tabId: number }
	| { kind: "navigate"; url: string; newTab: boolean };

/** Resolve the tool's flat arguments once, before any browser side effects. */
export function parseNavigateAction(args: NavigateParams): NavigateAction {
	if (args.listTabs) {
		if (args.url !== undefined || args.switchToTab !== undefined || args.newTab) {
			throw new Error("listTabs cannot be combined with navigation");
		}
		return { kind: "list" };
	}
	if (args.switchToTab !== undefined) {
		if (args.url !== undefined || args.newTab) {
			throw new Error("switchToTab cannot be combined with a URL or newTab; select the tab first, then navigate");
		}
		return { kind: "select", tabId: args.switchToTab };
	}
	if (args.url === undefined) throw new Error("Provide a URL or a target tab ID");
	return { kind: "navigate", url: args.url, newTab: args.newTab === true };
}

// ============================================================================
// TOOL
// ============================================================================

export class NavigateTool implements AgentTool<typeof navigateSchema, NavigateResult> {
	label = "Navigate";
	name = "navigate";
	description = NAVIGATE_TOOL_DESCRIPTION;
	parameters = navigateSchema;

	constructor(private readonly skills: SkillDisclosure) {}

	async execute(
		_toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		signal?.throwIfAborted();
		const action = parseNavigateAction(params as NavigateParams);
		if (action.kind === "list") return this.listTabs();
		if (action.kind === "navigate" && isArtifactViewerUrl(action.url)) {
			throw new Error("Artifact viewers cannot be used as browser targets.");
		}

		isNavigating = true;
		try {
			let tab: TargetTab;
			let description: string;
			if (action.kind === "select") {
				tab = await browserTarget.select(action.tabId);
				description = "Selected working tab";
			} else if (action.newTab) {
				tab = await this.openTab();
				description = "Opened tab";
			} else {
				tab = await browserTarget.select();
				description = "Navigated tab";
			}

			let finalUrl = tab.url;
			if (action.kind === "navigate") {
				finalUrl = await this.navigateToUrl(tab.id, action.url, signal);
				tab = await browserTarget.get(tab.id);
			}

			const skillsRepo = getSitegeistStorage().skills;
			const matchingSkills = finalUrl ? await skillsRepo.getSkillsForUrl(finalUrl) : [];
			const skillsOutput = this.skills.format(matchingSkills);
			const details: NavigateResult = {
				kind: "navigation",
				finalUrl,
				title: tab.title,
				favicon: tab.favIconUrl,
				tabId: tab.id,
				skills: matchingSkills,
			};
			const output = `${description} ${tab.id}${finalUrl ? `: ${finalUrl}` : ""}\n\n${skillsOutput}`;
			return { content: [{ type: "text", text: output }], details };
		} finally {
			isNavigating = false;
		}
	}

	private async navigateToUrl(tabId: number, url: string, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timeout);
				chrome.webNavigation.onDOMContentLoaded.removeListener(loaded);
				chrome.webNavigation.onErrorOccurred.removeListener(failed);
				chrome.tabs.onRemoved.removeListener(closed);
				signal?.removeEventListener("abort", aborted);
			};
			const fail = (error: unknown) => {
				cleanup();
				reject(error);
			};
			const loaded = (event: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
				if (event.tabId !== tabId || event.frameId !== 0) return;
				// A new tab's initial blank document is not the requested destination.
				if (event.url === "about:blank" && url !== "about:blank") return;
				cleanup();
				resolve(event.url);
			};
			const failed = (event: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
				if (event.tabId === tabId && event.frameId === 0)
					fail(new Error(`Navigation failed in tab ${tabId}: ${event.error}`));
			};
			const closed = (closedId: number) => {
				if (closedId === tabId) fail(new Error(`Target tab ${tabId} was closed during navigation`));
			};
			const aborted = () => fail(new Error("Navigation aborted"));
			const timeout = setTimeout(
				() => fail(new Error(`Navigation timed out in tab ${tabId}; inspect its current state before retrying`)),
				30_000,
			);
			chrome.webNavigation.onDOMContentLoaded.addListener(loaded);
			chrome.webNavigation.onErrorOccurred.addListener(failed);
			chrome.tabs.onRemoved.addListener(closed);
			signal?.addEventListener("abort", aborted, { once: true });
			chrome.tabs.update(tabId, { url }).catch(fail);
		});
	}

	private async openTab(): Promise<TargetTab> {
		// Load the destination only after navigateToUrl has installed its listeners.
		if (browserTarget.windowId === undefined) throw new Error("No working browser window selected");
		const tab = await chrome.tabs.create({ url: "about:blank", active: false, windowId: browserTarget.windowId });
		return browserTarget.select(tab.id!);
	}

	private async listTabs(): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		if (browserTarget.windowId === undefined) throw new Error("No working browser window selected");
		const tabs = await chrome.tabs.query({ windowId: browserTarget.windowId });

		const tabInfos: TabInfo[] = tabs
			.filter(
				(t: chrome.tabs.Tab): t is chrome.tabs.Tab & { id: number; url: string } =>
					t.id !== undefined && t.url !== undefined && !isArtifactViewerUrl(t.url),
			)
			.map((t: chrome.tabs.Tab & { id: number; url: string }) => ({
				id: t.id,
				url: t.url,
				title: t.title || "Untitled",
				active: t.active,
				favicon: t.favIconUrl,
			}));

		const details: NavigateResult = {
			kind: "tabs",
			tabs: tabInfos,
		};

		let output = `Found ${tabInfos.length} open tabs:\n`;
		for (const tab of tabInfos) {
			const activeMarker = `${tab.active ? " [VISIBLE IN WINDOW]" : ""}${tab.id === browserTarget.tabId ? " [WORKING TARGET]" : ""}`;
			output += `  - Tab ${tab.id}: ${tab.title}${activeMarker}\n`;
			output += `    URL: ${tab.url}\n`;
		}

		return { content: [{ type: "text", text: output }], details };
	}
}

// ============================================================================
// RENDERER
// ============================================================================

function getFallbackFavicon(url: string): string {
	try {
		const urlObj = new URL(url);
		return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
	} catch {
		return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23999' d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z'/%3E%3C/svg%3E";
	}
}

export const navigateRenderer: ToolRenderer<NavigateParams, NavigateResult> = {
	render(
		params: NavigateParams | undefined,
		result: ToolResultMessage<NavigateResult> | undefined,
		_isStreaming?: boolean,
	): ToolRenderResult {
		// Loading state (params but no result)
		if (params && !result) {
			let displayText = "";
			if ("url" in params && params.url) {
				displayText = params.url;
			} else if ("listTabs" in params) {
				displayText = "Listing tabs...";
			} else if ("switchToTab" in params) {
				displayText = `Switching to tab ${params.switchToTab}`;
			}

			return {
				content: html`
					<div class="my-2">
						<div
							class="inline-flex items-center gap-2 px-3 py-2 text-sm text-card-foreground bg-card border border-border rounded-lg max-w-full shadow-lg"
						>
							<div class="w-4 h-4 flex-shrink-0 flex items-center justify-center">
								${icon(Loader2, "sm", "animate-spin")}
							</div>
							<span class="truncate font-medium">${i18n("Navigating to")} ${displayText}</span>
						</div>
					</div>
				`,
				isCustom: true,
			};
		}

		// Complete state (with result)
		if (result && !result.isError && result.details) {
			// Handle tab listing
			if (result.details.kind === "tabs") {
				return {
					content: html`
						<div class="flex items-center gap-2 flex-wrap">
							<span class="text-sm text-muted-foreground">${i18n("Open tabs")}</span>
							${result.details.tabs.map((tab) => TabPill(tab, true))}
						</div>
					`,
					isCustom: false,
				};
			}

			// Handle navigation/switch results
			const { finalUrl, title, favicon, skills } = result.details;
			if (finalUrl && title) {
				const faviconUrl = favicon || getFallbackFavicon(finalUrl);

				return {
					content: html`
						<div class="my-2 space-y-2">
							<button
								class="inline-flex items-center gap-2 px-3 py-2 text-sm text-card-foreground bg-card border border-border rounded-lg hover:bg-accent/50 transition-colors max-w-full cursor-pointer shadow-lg"
								@click=${() => chrome.tabs.create({ url: finalUrl })}
								title="${i18n("Click to open")}: ${finalUrl}"
							>
								<img src="${faviconUrl}" alt="" class="w-4 h-4 flex-shrink-0" />
								<span class="truncate font-medium">${title}</span>
							</button>
							${
								skills.length > 0
									? html`
										<div class="flex flex-wrap gap-2">
											${skills.map((s) => SkillPill(s, true))}
										</div>
								  `
									: ""
							}
						</div>
					`,
					isCustom: true,
				};
			}
		}

		// Error state
		if (result?.isError) {
			const errorText = result.content.find((c) => c.type === "text")?.text || "Unknown error";
			return {
				content: html`
					<div class="my-2">
						<div class="text-sm text-destructive">${errorText}</div>
					</div>
				`,
				isCustom: true,
			};
		}

		// Waiting state
		return {
			content: html`<div class="my-2 text-sm text-muted-foreground">${i18n("Waiting...")}</div>`,
			isCustom: true,
		};
	},
};

// Auto-register renderer
registerToolRenderer("navigate", navigateRenderer);
