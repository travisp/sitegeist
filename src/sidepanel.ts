import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { Agent, type AgentState, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { getModel, getModels } from "@earendil-works/pi-ai/compat";
import {
	ChatPanel,
	createExtractDocumentTool,
	createStreamFn,
	formatTokenCount,
	ModelSelector,
	ProxyTab,
	registerMessageRenderer,
	SettingsDialog,
	// PersistentStorageDialog,
	setAppStorage,
	setShowJsonMode,
} from "@earendil-works/pi-web-ui";
import { html, render } from "lit";
import { History, Plus, Settings } from "lucide";
import { Toast } from "./components/Toast.js";
import { AboutTab } from "./dialogs/AboutTab.js";
import { ApiKeyOrOAuthDialog } from "./dialogs/ApiKeyOrOAuthDialog.js";
import { ApiKeysOAuthTab } from "./dialogs/ApiKeysOAuthTab.js";
import { CostsTab } from "./dialogs/CostsTab.js";
import { SessionCostDialog } from "./dialogs/SessionCostDialog.js";
import { SitegeistSessionListDialog } from "./dialogs/SessionListDialog.js";
import { SkillsTab } from "./dialogs/SkillsTab.js";
import { UpdateNotificationDialog } from "./dialogs/UpdateNotificationDialog.js";
import { UserScriptsPermissionDialog } from "./dialogs/UserScriptsPermissionDialog.js";
import { WelcomeSetupDialog } from "./dialogs/WelcomeSetupDialog.js";
import { estimateConversationTokens } from "./messages/compaction.js";
import { browserMessageTransformer } from "./messages/message-transformer.js";
import { createNavigationMessage, registerNavigationRenderer } from "./messages/NavigationMessage.js";
import { registerUserMessageRenderer } from "./messages/UserMessageRenderer.js";
import { createWelcomeMessage, registerWelcomeRenderer } from "./messages/WelcomeMessage.js";
import { isOAuthCredentials, resolveApiKey } from "./oauth/index.js";
import { SYSTEM_PROMPT } from "./prompts/prompts.js";
import { isUserMessage, Session, type SessionOptions } from "./session.js";
import { SitegeistAppStorage } from "./storage/app-storage.js";
import { browserTarget } from "./tools/browser-target.js";
import { DebuggerTool } from "./tools/debugger.js";
import { ExtractImageTool, registerExtractImageRenderer } from "./tools/extract-image.js";
import { AskUserWhichElementTool, ReadRawToolResultTool, ResearchPageTool, skillTool } from "./tools/index.js";
import { NativeInputEventsRuntimeProvider } from "./tools/NativeInputEventsRuntimeProvider.js";
import { isToolNavigating, type NavigateResult, NavigateTool } from "./tools/navigate.js";
import { ownsOverlayRun } from "./tools/repl/overlay-inject.js";
import { createReplTool } from "./tools/repl/repl.js";
import { BrowserJsRuntimeProvider, NavigateRuntimeProvider } from "./tools/repl/runtime-providers.js";
import * as port from "./utils/port.js";
import "./utils/i18n-extension.js";
import "./utils/live-reload.js";
import { tutorials } from "./tutorials.js";

function schedulePostAgentEndUpdate() {
	setTimeout(() => {
		if (!agent) return;
		chatPanel?.agentInterface?.requestUpdate();
		chatPanel?.requestUpdate();
		renderApp();
	}, 0);
}

// Register custom message renderers
registerNavigationRenderer();
registerExtractImageRenderer();
registerMessageRenderer("conversation-compaction", {
	render: (message) =>
		html`<details class="mx-4 my-2 text-xs text-muted-foreground"><summary>Conversation compacted (original history retained)</summary><pre class="whitespace-pre-wrap">${message.summary}</pre></details>`,
});

// Listen for abort messages from REPL overlay
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	console.log("[Sidepanel] Received message:", message, "from:", sender);
	if (message.type === "abort-repl" && ownsOverlayRun(message.runId)) {
		console.log("[Sidepanel] Abort-repl message received, agent streaming:", agent?.state.isStreaming);
		if (agent?.state.isStreaming) {
			console.log("[Sidepanel] Aborting agent...");
			agent.abort();
			sendResponse({ success: true });
		} else {
			console.log("[Sidepanel] Agent not streaming, ignoring");
			sendResponse({ success: false, reason: "not-streaming" });
		}
		return true; // Keep channel open for async response
	}
});

// ============================================================================
// STORAGE SETUP
// ============================================================================
const storage = new SitegeistAppStorage();
setAppStorage(storage);

// ============================================================================
// APP STATE
// ============================================================================
let session: Session;
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
let currentWindowId: number;

// Cached auth type label for the current provider
let authLabel = "";

const DEFAULT_MODELS: Record<string, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	anthropic: "claude-sonnet-4-6",
	"azure-openai-responses": "gpt-5.2",
	cerebras: "zai-glm-4.6",
	"github-copilot": "gpt-4o",
	google: "gemini-2.5-flash",
	"google-antigravity": "gemini-3.1-pro-high",
	"google-vertex": "gemini-3-pro-preview",
	groq: "openai/gpt-oss-20b",
	huggingface: "moonshotai/Kimi-K2.5",
	"kimi-coding": "kimi-k2-thinking",
	minimax: "MiniMax-M2.1",
	"minimax-cn": "MiniMax-M2.1",
	mistral: "devstral-medium-latest",
	openai: "gpt-4o-mini",
	"openai-codex": "gpt-5.1-codex-mini",
	opencode: "claude-opus-4-6",
	"opencode-go": "kimi-k2.5",
	openrouter: "openai/gpt-5.1-codex",
	"vercel-ai-gateway": "anthropic/claude-opus-4-6",
	xai: "grok-4-fast-non-reasoning",
	zai: "glm-4.6",
};

async function selectDefaultModelForAvailableProvider() {
	const providers = await getProvidersWithKeys();
	if (providers.length === 0 || !agent) return;

	// Try each provider with keys and find a default model
	for (const provider of providers) {
		const modelId = DEFAULT_MODELS[provider];
		if (modelId) {
			const model = getModel(provider as any, modelId);
			if (model) {
				agent.state.model = model;
				await storage.settings.set("lastUsedModel", model);
				await updateAuthLabel();
				renderApp();
				return;
			}
		}
	}

	// If no default found, try the first model for the first provider with a key
	for (const provider of providers) {
		const models = getModels(provider as any);
		if (models.length > 0) {
			agent.state.model = models[0];
			await storage.settings.set("lastUsedModel", models[0]);
			await updateAuthLabel();
			renderApp();
			return;
		}
	}
}

async function getProvidersWithKeys(): Promise<string[]> {
	const providers = await storage.providerKeys.list();
	const result: string[] = [];
	for (const provider of providers) {
		const key = await storage.providerKeys.get(provider);
		if (key) result.push(provider);
	}
	return result;
}

async function hasAnyApiKey(): Promise<boolean> {
	const providers = await storage.providerKeys.list();
	return providers.length > 0;
}

function openApiKeysDialog(): Promise<void> {
	return new Promise((resolve) => {
		SettingsDialog.open(
			[new ApiKeysOAuthTab(), new CostsTab(), new SkillsTab(), new ProxyTab(), new AboutTab()],
			resolve,
		);
	});
}

async function updateAuthLabel() {
	if (!agent) {
		authLabel = "";
		return;
	}
	const provider = agent.state.model.provider;
	const stored = await storage.providerKeys.get(provider);
	if (!stored) {
		authLabel = "";
	} else if (isOAuthCredentials(stored)) {
		authLabel = "subscription";
	} else {
		authLabel = "api key";
	}
}

async function getEnabledProxyUrl(): Promise<string | undefined> {
	const enabled = await storage.settings.get<boolean>("proxy.enabled");
	if (!enabled) return undefined;
	return (await storage.settings.get<string>("proxy.url")) || undefined;
}

async function getApiKeyForProvider(provider: string): Promise<string | undefined> {
	const stored = await storage.providerKeys.get(provider);
	if (!stored) return undefined;
	return resolveApiKey(stored, provider, storage.providerKeys);
}

// ============================================================================
// HELPERS
// ============================================================================
const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

const createAgent = async (initialState?: Partial<AgentState>, options: SessionOptions = {}) => {
	await session?.compaction.wait();
	await session?.flush();
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	// Load debugger mode setting
	const stored = await chrome.storage.local.get("debuggerMode");
	const debuggerModeEnabled = stored.debuggerMode || false;

	// Load CORS proxy settings for extract_document tool
	const corsProxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
	const corsProxyUrl = await storage.settings.get<string>("proxy.url");

	// Determine default model: saved > default for a provider with key > Anthropic fallback
	let defaultModel: Model<any> | undefined;
	if (!initialState?.model) {
		const savedModel = await storage.settings.get<Model<any>>("lastUsedModel");
		if (savedModel) {
			defaultModel = savedModel;
		} else {
			// Try to find a default model for a provider the user already has a key for
			const providersWithKeys = await getProvidersWithKeys();
			for (const provider of providersWithKeys) {
				const modelId = DEFAULT_MODELS[provider];
				if (modelId) {
					const model = getModel(provider as any, modelId);
					if (model) {
						defaultModel = model;
						break;
					}
				}
			}
		}
	}
	if (!defaultModel && !initialState?.model) {
		defaultModel = getModel("anthropic", "claude-sonnet-4-6");
	}

	const streamFn = createStreamFn(getEnabledProxyUrl);
	const agentInstance = new Agent({
		initialState: initialState || {
			systemPrompt: SYSTEM_PROMPT,
			model: defaultModel,
			thinkingLevel: "medium",
			messages: [],
			tools: [],
		},
		convertToLlm: browserMessageTransformer,
		toolExecution: "sequential",
		streamFn,
		getApiKey: getApiKeyForProvider,
	});
	const sessionInstance = new Session(
		agentInstance,
		{
			storage,
			onCreated: (id) => {
				void port
					.sendMessage({ type: "acquireLock", sessionId: id, windowId: currentWindowId })
					.then((response) => {
						if (!response.success) console.warn("Failed to acquire lock for newly created session", id);
					});
				updateUrl(id);
			},
			onChange: () => {
				chatPanel.agentInterface?.requestUpdate();
				renderApp();
			},
		},
		options,
	);
	agent = agentInstance;
	session = sessionInstance;
	await updateAuthLabel();

	agentUnsubscribe = agentInstance.subscribe(async (event) => {
		if (event.type === "message_end") {
			agentInstance.state.messages = agentInstance.state.messages.slice();
		}
		if (event.type === "agent_end") schedulePostAgentEndUpdate();
		await sessionInstance.handleEvent(event);
	});

	await chatPanel.setAgent(agentInstance, {
		sandboxUrlProvider: () => {
			return chrome.runtime.getURL("sandbox.html");
		},
		onApiKeyRequired: async (provider: string) => {
			return await ApiKeyOrOAuthDialog.prompt(provider);
		},
		onModelSelect: async () => {
			const providers = await getProvidersWithKeys();
			if (providers.length === 0) {
				openApiKeysDialog();
				return;
			}
			ModelSelector.open(
				agentInstance.state.model,
				(model) => {
					agentInstance.state.model = model;
					void storage.settings.set("lastUsedModel", model);
					void sessionInstance.flush();
					chatPanel.agentInterface?.requestUpdate();
					updateAuthLabel().catch(() => {});
					renderApp();
				},
				providers,
			);
		},
		onBeforeSend: async () => {
			if (agentInstance.state.isStreaming) return;
			await sessionInstance.compaction.wait();

			const tab = await browserTarget.capture(currentWindowId);
			if (!tab.url || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("moz-extension://")) return;

			// Find most recent navigation (either nav message or nav tool result)
			let lastUrl: string | undefined;
			let lastTabId: number | undefined;
			for (let i = agentInstance.state.messages.length - 1; i >= 0; i--) {
				const msg = agentInstance.state.messages[i];
				if (msg.role === "navigation") {
					lastUrl = msg.url;
					lastTabId = msg.tabId;
					break;
				}
				if (msg.role === "toolResult" && msg.toolName === "navigate") {
					const details = msg.details as NavigateResult | undefined;
					if (details?.kind === "navigation") {
						lastUrl = details.finalUrl;
						lastTabId = details.tabId;
						break;
					}
				}
			}

			// Distinguish tabs even when they have identical URLs.
			if (lastUrl !== tab.url || lastTabId !== tab.id) {
				const navMessage = await createNavigationMessage(
					sessionInstance.skills,
					tab.url,
					tab.title || "Untitled",
					tab.favIconUrl,
					tab.id,
				);
				agentInstance.state.messages = [...agentInstance.state.messages, navMessage];
			}
		},
		onCostClick: () => SessionCostDialog.open(agentInstance.state.messages),
		toolsFactory: (agentInstance, _agentInterface, _artifactsPanel, runtimeProvidersFactory) => {
			const navigateTool = new NavigateTool(sessionInstance.skills);
			const selectElementTool = new AskUserWhichElementTool();

			// Create extract_document tool with CORS proxy from settings (loaded above)
			const extractDocumentTool = createExtractDocumentTool();
			if (corsProxyEnabled && corsProxyUrl) {
				extractDocumentTool.corsProxyUrl = `${corsProxyUrl}/?url=`;
			}

			const replTool = createReplTool();
			replTool.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");

			// Extend base providers with browser orchestration capabilities
			replTool.runtimeProvidersFactory = () => {
				// Providers that should be available in page context via browserjs()
				const pageProviders = [
					...runtimeProvidersFactory(), // attachments + artifacts from ChatPanel
					new NativeInputEventsRuntimeProvider(), // trusted browser events
				];

				return [
					...pageProviders, // Make them available in REPL context too
					new BrowserJsRuntimeProvider(pageProviders), // Pass to page context
					new NavigateRuntimeProvider(navigateTool),
				];
			};

			const extractImageTool = new ExtractImageTool();

			const readRawToolResultTool = new ReadRawToolResultTool(() => agentInstance.state.messages);
			const researchPageTool = new ResearchPageTool(() => agentInstance.state.model, getApiKeyForProvider, streamFn);

			const tools: AgentTool<any, any>[] = [
				navigateTool,
				selectElementTool,
				replTool,
				readRawToolResultTool,
				researchPageTool,
				skillTool,
				extractDocumentTool,
				extractImageTool,
			];

			// Conditionally add debugger tool if enabled
			if (debuggerModeEnabled) {
				const debuggerTool = new DebuggerTool();
				tools.push(debuggerTool);
			}

			return tools;
		},
	});

	// Register custom message renderers after agentInterface is available
	if (chatPanel.agentInterface) {
		registerWelcomeRenderer(agentInstance, chatPanel.agentInterface);

		// Only disable auto-scroll for new sessions with welcome message
		// Check if this is a fresh session (only has welcome message, no user messages)
		const hasUserMessage = agentInstance.state.messages.some(isUserMessage);
		if (!hasUserMessage) {
			chatPanel.agentInterface.setAutoScroll(false);

			// Re-enable auto-scroll on first user message
			let unsubscribe: (() => void) | undefined;
			unsubscribe = agentInstance.subscribe(() => {
				const hasUserMsg = agentInstance.state.messages.some(isUserMessage);
				if (hasUserMsg && unsubscribe) {
					chatPanel.agentInterface?.setAutoScroll(true);
					unsubscribe();
				}
			});
		}
	}
};

const loadSession = async (sessionId: string) => {
	await session.compaction.wait();
	await session.flush();
	// Navigation will disconnect port and auto-release locks
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.location.href = url.toString();
};

const newSession = async () => {
	await session?.compaction.wait();
	await session?.flush();
	// Navigation will disconnect port and auto-release locks
	const url = new URL(window.location.href);
	url.search = "?new=true";
	window.location.href = url.toString();
};

async function showWorkingTab(): Promise<void> {
	try {
		await browserTarget.show();
	} catch (error) {
		Toast.error(String(error));
	}
}

async function compactConversation(): Promise<void> {
	try {
		if (!(await session.compact())) {
			Toast.show("Not enough older history to compact yet.");
		}
	} catch (error) {
		Toast.error(`Compaction failed: ${String(error)}`);
	}
}

// ============================================================================
// RENDER
// ============================================================================
function renderContextUsage() {
	if (!agent) return "";

	const { contextWindow } = agent.state.model;
	const tokens = estimateConversationTokens(agent.state.messages);
	const percent = (tokens / contextWindow) * 100;
	const colorClass = percent > 90 ? "text-destructive" : percent > 70 ? "text-warning" : "text-muted-foreground";
	const title = `Estimated current context if you send now: ${tokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`;

	return html`
		<div class="shrink-0 px-3 pb-1 text-xs flex justify-end">
			${
				agent.state.isStreaming && browserTarget.tabId !== undefined
					? html`<button class="mr-auto text-muted-foreground hover:text-foreground"
				title="Working target; click to show this tab"
				@click=${showWorkingTab}>Tab ${browserTarget.tabId}</button>`
					: ""
			}
			<button class="mr-2 hover:text-foreground disabled:opacity-50" ?disabled=${agent.state.isStreaming || session.isCompacting}
				@click=${compactConversation}>${session.isCompacting ? "Compacting…" : "Compact"}</button>
			<span class=${colorClass} title=${title}>Ctx ${percent.toFixed(1)}%/${formatTokenCount(contextWindow)}</span>
		</div>
	`;
}

const renderApp = () => {
	const appHtml = html`
		<div class="w-full h-full flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-3 py-2">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(History, "sm"),
						onClick: () => {
							SitegeistSessionListDialog.open(
								(sessionId: string) => {
									loadSession(sessionId);
								},
								(deletedSessionId: string) => {
									// Only reload if the current session was deleted
									if (deletedSessionId === session?.id) {
										newSession();
									}
								},
							);
						},
						title: "Sessions",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Plus, "sm"),
						onClick: newSession,
						title: "New Session",
					})}

					${
						session?.title
							? isEditingTitle
								? html`<div class="flex items-center gap-2">
									${Input({
										type: "text",
										value: session.title,
										className: "text-sm w-48",
										onKeyDown: async (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												const newTitle = (e.target as HTMLInputElement).value.trim();
												if (newTitle && newTitle !== session.title) {
													session.title = newTitle;
													await session.flush();
												}
												isEditingTitle = false;
												renderApp();
											} else if (e.key === "Escape") {
												isEditingTitle = false;
												renderApp();
											}
										},
									})}
								</div>`
								: html`<button
									class="px-2 py-1 text-xs text-foreground hover:bg-secondary rounded transition-colors truncate max-w-[150px]"
									@click=${() => {
										isEditingTitle = true;
										renderApp();
										requestAnimationFrame(() => {
											const input = document.body.querySelector('input[type="text"]') as HTMLInputElement;
											if (input) {
												input.focus();
												input.select();
											}
										});
									}}
									title="Click to edit title"
								>
									${session.title}
								</button>`
							: html``
					}
				</div>
				<div class="flex items-center gap-1 px-2">
					${agent ? html`<span class="text-[10px] text-muted-foreground truncate max-w-[120px]" title="${agent.state.model.provider}/${agent.state.model.id}${authLabel ? ` (${authLabel})` : ""}">${agent.state.model.provider}${authLabel ? html` <span class="text-[9px] opacity-70">${authLabel}</span>` : ""}</span>` : ""}
					<theme-toggle></theme-toggle>
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () =>
							SettingsDialog.open([
								new ApiKeysOAuthTab(),
								new CostsTab(),
								new SkillsTab(),
								new ProxyTab(),
								new AboutTab(),
							]),
						title: "Settings",
					})}
				</div>
			</div>

			<!-- Chat Panel -->
			<div class="flex-1 min-h-0">${chatPanel}</div>
			${renderContextUsage()}
		</div>
	`;

	render(appHtml, document.body);
};

// ============================================================================
// TAB NAVIGATION TRACKING
// ============================================================================

// Listen for tab updates and insert navigation messages only when agent is running
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
	// Follow navigation on the working target, including background tabs in other windows.
	// Tool-initiated navigations already include their context in the tool result.
	if (
		changeInfo.url &&
		tab.id === browserTarget.tabId &&
		tab.url &&
		agent?.state.isStreaming &&
		!tab.url.startsWith("chrome-extension://") &&
		!tab.url.startsWith("moz-extension://") &&
		!isToolNavigating()
	) {
		const owner = session;
		const navMessage = await createNavigationMessage(
			owner.skills,
			tab.url,
			tab.title || "Untitled",
			tab.favIconUrl,
			tab.id,
		);
		owner.agent.steer(navMessage);
		console.log("Queued navigation message for tab switch to", tab.url);
	}
});

// Tab activation is deliberately not an agent event: browsing must not retarget a running task.

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================
window.addEventListener(
	"keydown",
	(e) => {
		// Escape key to abort streaming - works globally in sidepanel
		// Use capturing phase to intercept before MessageEditor handles it
		if (e.key === "Escape") session?.cancelCompaction();
		if (e.key === "Escape" && agent?.state.isStreaming) {
			e.preventDefault();
			e.stopPropagation();
			agent.abort();
		}

		// Cmd+U (Mac) or Ctrl+U (Windows/Linux) to open debug page
		if ((e.metaKey || e.ctrlKey) && e.key === "u") {
			e.preventDefault();
			window.location.href = "./debug.html";
		}

		// Cmd+Shift+K (Mac) or Ctrl+Shift+K (Windows/Linux) to show session costs
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
			e.preventDefault();
			if (agent?.state.messages && agent.state.messages.length > 0) {
				SessionCostDialog.open(agent.state.messages);
			}
		}
	},
	true,
); // Use capture phase to intercept Escape before it reaches MessageEditor

// ============================================================================
// TEST STEPS FROM DEBUGGER.TS
// ============================================================================
async function testSteps(): Promise<boolean> {
	const urlParams = new URLSearchParams(window.location.search);
	const testStepsParam = urlParams.get("teststeps");
	const testProvider = urlParams.get("provider");
	const testModel = urlParams.get("model");

	if (!testStepsParam) return false;

	// Handle test prompts - create temporary session without saving
	try {
		const testSteps = JSON.parse(decodeURIComponent(testStepsParam)) as string[];

		// Set model if specified
		let initialState: Partial<AgentState> | undefined;
		if (testProvider && testModel) {
			const model = getModel(testProvider as any, testModel);
			if (model) {
				initialState = {
					systemPrompt: SYSTEM_PROMPT,
					model,
				};
			}
		}

		await createAgent(initialState, { persist: false });
		renderApp();

		// Wait for UI to render
		await new Promise((resolve) => requestAnimationFrame(resolve));

		// Submit prompts sequentially
		for (let i = 0; i < testSteps.length; i++) {
			const step = testSteps[i];
			if (!chatPanel?.agentInterface) break;

			// Send the prompt
			await chatPanel.agentInterface.sendMessage(step);

			// Wait for agent to finish (not streaming anymore)
			if (i < testSteps.length - 1) {
				// Wait for response to complete before sending next step
				await new Promise<void>((resolve) => {
					const checkComplete = () => {
						if (!chatPanel.agent?.state.isStreaming) {
							resolve();
						} else {
							setTimeout(checkComplete, 100);
						}
					};
					checkComplete();
				});
			}
		}
		return true;
	} catch (err) {
		console.error("Failed to run test steps:", err);
		return false;
	}
}

// ============================================================================
// UPDATE CHECK
// ============================================================================
function isNewerVersion(latest: string, current: string): boolean {
	const latestParts = latest.split(".").map(Number);
	const currentParts = current.split(".").map(Number);

	for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
		const l = latestParts[i] || 0;
		const c = currentParts[i] || 0;
		if (l > c) return true;
		if (l < c) return false;
	}
	return false;
}

async function checkForUpdates() {
	try {
		const currentVersion = chrome.runtime.getManifest().version;

		// Fetch latest version
		const response = await fetch("https://sitegeist.ai/uploads/version.json", {
			cache: "no-cache",
		});
		const data = await response.json();
		const latestVersion = data.version;

		// Show dialog only if server version is newer than current version
		if (isNewerVersion(latestVersion, currentVersion)) {
			// Show update dialog - blocks until extension is updated and restarted
			await UpdateNotificationDialog.show(latestVersion);
		}
	} catch (err) {
		console.warn("[Sidepanel] Failed to check for updates:", err);
		// Silently fail - don't block startup
	}
}

// ============================================================================
// INIT
// ============================================================================
async function initApp() {
	// Show loading
	render(
		html`
			<div class="w-full h-full flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Loading...</div>
			</div>
		`,
		document.body,
	);

	// Load showJsonMode setting
	const stored = await chrome.storage.local.get("showJsonMode");
	const showJsonModeEnabled = (stored.showJsonMode as boolean) || false;
	setShowJsonMode(showJsonModeEnabled);

	// Get current window ID for filtering tab events
	const currentWindow = await chrome.windows.getCurrent();
	if (!currentWindow.id) {
		throw new Error("Failed to get current window ID");
	}
	currentWindowId = currentWindow.id;

	// Initialize port communication system
	port.initialize(currentWindowId);

	// TODO reenable Request persistent storage
	// if (storage.sessions) {
	// 	await PersistentStorageDialog.request();
	// }

	// Request userScripts permission if not available
	if (!chrome.userScripts) {
		await UserScriptsPermissionDialog.request();
	}

	// TODO: re-enable update check when publishing to users
	// await checkForUpdates();

	// Initialize default skills
	const { initializeDefaultSkills } = await import("./tools/skill.js");
	await initializeDefaultSkills();

	// Proxy disabled — CORS is handled locally via declarativeNetRequest rules
	await storage.settings.set("proxy.enabled", false);

	// Create ChatPanel
	chatPanel = new ChatPanel();

	// Handle test steps
	if (await testSteps()) {
		return;
	}

	// Check for session in URL
	const urlParams = new URLSearchParams(window.location.search);
	let sessionIdFromUrl = urlParams.get("session");
	const isNewSession = urlParams.get("new") === "true";

	// If no session in URL and not explicitly creating new, try to load the most recent session
	if (!sessionIdFromUrl && !isNewSession && storage.sessions) {
		const latestSessionId = await storage.sessions.getLatestSessionId();
		if (latestSessionId) {
			// Try to acquire lock for latest session
			const lockResponse = await port.sendMessage({
				type: "acquireLock",
				sessionId: latestSessionId,
				windowId: currentWindowId,
			});

			if (lockResponse.success) {
				sessionIdFromUrl = latestSessionId;
				// Update URL to include the latest session
				updateUrl(latestSessionId);
			}
			// If lock fails, fall through to create new session
		}
	}

	if (sessionIdFromUrl && storage.sessions) {
		const sessionData = await storage.sessions.loadSession(sessionIdFromUrl);
		if (sessionData) {
			// Try to acquire lock if we don't already have it (in case user navigated directly via URL)
			const lockResponse = await port.sendMessage({
				type: "acquireLock",
				sessionId: sessionIdFromUrl,
				windowId: currentWindowId,
			});

			if (!lockResponse.success) {
				// Session is locked in another window - show landing page instead
				await createAgent();
				if (agent) {
					const welcomeMessage = createWelcomeMessage(tutorials);
					agent.state.messages = [...agent.state.messages, welcomeMessage];
				}
				renderApp();
				return;
			}

			const metadata = await storage.sessions.getMetadata(sessionIdFromUrl);
			await createAgent(
				{
					systemPrompt: SYSTEM_PROMPT,
					model: sessionData.model,
					thinkingLevel: sessionData.thinkingLevel,
					messages: sessionData.messages,
					tools: [],
				},
				{ id: sessionIdFromUrl, title: metadata?.title },
			);

			renderApp();
			return;
		} else {
			// Session doesn't exist, redirect to new session
			newSession();
			return;
		}
	}

	// No session - create new agent with welcome message
	await createAgent();

	// Add welcome message for new sessions
	if (agent) {
		const welcomeMessage = createWelcomeMessage(tutorials);
		agent.state.messages = [...agent.state.messages, welcomeMessage];
	}

	renderApp();

	// If no API keys configured, show welcome dialog, open settings, then auto-select model
	if (!(await hasAnyApiKey())) {
		await WelcomeSetupDialog.show();
		await openApiKeysDialog();
		await selectDefaultModelForAvailableProvider();
		renderApp();
	}
}

// Register custom user message renderer early, before any session loads
registerUserMessageRenderer();

initApp();
