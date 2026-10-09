import {
	type ConsoleLog,
	ConsoleRuntimeProvider,
	RUNTIME_MESSAGE_ROUTER,
	type SandboxRuntimeProvider,
} from "@earendil-works/pi-web-ui";
import {
	BROWSERJS_RUNTIME_PROVIDER_DESCRIPTION,
	NAVIGATE_RUNTIME_PROVIDER_DESCRIPTION,
} from "../../prompts/prompts.js";
import { getSitegeistStorage } from "../../storage/app-storage.js";
import { browserTarget } from "../browser-target.js";
import type { NavigateParams, NavigateTool } from "../navigate.js";
import { buildWrapperCode, checkUserScriptsAvailability } from "./userscripts-helpers.js";

export interface BrowserFrame {
	frameId: number;
	parentFrameId: number;
	url: string;
}

export interface BrowserJsHelper {
	<Args extends unknown[], Result>(func: (...args: Args) => Result, ...args: Args): Promise<Awaited<Result>>;
	frames(): Promise<BrowserFrame[]>;
	inFrame<Args extends unknown[], Result>(
		frameId: number,
		func: (...args: Args) => Result,
		...args: Args
	): Promise<Awaited<Result>>;
}

type BrowserJsResponse = ({ success: true; result?: unknown } | { success: false; error: string }) & {
	console?: ConsoleLog[];
};

/**
 * BrowserJsRuntimeProvider
 *
 * Provides the browserjs() helper to REPL scripts, which executes code
 * in the working target tab's page context via userScripts API.
 *
 * Usage in REPL:
 *   const title = await browserjs(() => document.title);
 *   const count = await browserjs((sel) => document.querySelectorAll(sel).length, '.product');
 */
export class BrowserJsRuntimeProvider implements SandboxRuntimeProvider {
	private activeSandboxIds: Set<string> = new Set();
	private sandboxAbortSignals = new Map<string, AbortSignal>();

	constructor(private sharedProviders: SandboxRuntimeProvider[]) {}

	getData(): Record<string, unknown> {
		return {};
	}

	getRuntime(): (sandboxId: string) => void {
		// This function will be stringified and injected into the REPL iframe
		return (_sandboxId: string) => {
			const runtimeWindow = window as unknown as {
				sendRuntimeMessage: (message: Record<string, unknown>) => Promise<BrowserJsResponse>;
				browserjs: BrowserJsHelper;
			};
			const sendRuntimeMessage = runtimeWindow.sendRuntimeMessage;

			// All helpers share response handling so frame errors and console output reach the REPL.
			const request = async <Result>(message: Record<string, unknown>): Promise<Result> => {
				const response = await sendRuntimeMessage(message);

				// Show page logs before throwing so failed scripts retain their diagnostics.
				if (response.console) {
					for (const log of response.console) console[log.type](`[browserjs] ${log.text}`);
				}

				if (!response.success) {
					throw new Error(response.error);
				}

				return response.result as Result;
			};

			const execute = async <Args extends unknown[], Result>(
				frameId: number,
				func: (...args: Args) => Result,
				...args: Args
			): Promise<Awaited<Result>> => {
				if (typeof func !== "function") {
					throw new Error("browserjs() requires a function");
				}
				return request<Awaited<Result>>({
					type: "browser-js",
					code: func.toString(),
					args: JSON.stringify(args),
					frameId,
				});
			};

			const browserjs = <Args extends unknown[], Result>(func: (...args: Args) => Result, ...args: Args) =>
				execute(0, func, ...args);
			runtimeWindow.browserjs = Object.assign(browserjs, {
				frames: () => request<BrowserFrame[]>({ type: "browser-js-frames" }),
				inFrame: execute,
			});
		};
	}

	onExecutionStart(sandboxId: string, signal?: AbortSignal): void {
		if (signal) {
			this.sandboxAbortSignals.set(sandboxId, signal);
		}
	}

	onExecutionEnd(sandboxId: string): void {
		// Clean up the abort signal when REPL execution ends
		this.sandboxAbortSignals.delete(sandboxId);
	}

	async handleMessage(message: any, respond: (response: any) => void): Promise<void> {
		if (message.type !== "browser-js" && message.type !== "browser-js-frames") return;

		const abortSignal = this.sandboxAbortSignals.get(message.sandboxId);
		let sandboxId: string | undefined;
		let abortHandler: (() => Promise<void>) | undefined;
		let pageConsoleProvider: ConsoleRuntimeProvider | undefined;

		try {
			const tab = await browserTarget.get();
			if (
				tab.url?.startsWith("chrome://") ||
				tab.url?.startsWith("chrome-extension://") ||
				tab.url?.startsWith("moz-extension://") ||
				tab.url?.startsWith("about:")
			) {
				throw new Error(`Cannot execute scripts on ${tab.url}. Extension pages and internal URLs are protected.`);
			}

			// Discovery is read-only and does not require userScripts to be enabled.
			if (message.type === "browser-js-frames") {
				const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
				if (!frames) throw new Error(`Cannot list frames for target tab ${tab.id}`);
				respond({
					success: true,
					result: frames.map(({ frameId, parentFrameId, url }) => ({ frameId, parentFrameId, url })),
				});
				return;
			}

			const frameId: number = message.frameId;
			if (!Number.isInteger(frameId) || frameId < 0) {
				throw new Error("browserjs.inFrame() requires a non-negative integer frame ID");
			}
			const apiCheck = await checkUserScriptsAvailability();
			if (!apiCheck.available) throw new Error(apiCheck.message);

			// Only iframe executions need a separate URL lookup for matching skills.
			let skillUrl = tab.url;
			if (frameId !== 0) {
				const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId });
				if (!frame) {
					throw new Error(
						`Frame ${frameId} is no longer available in target tab ${tab.id}. Call browserjs.frames() again.`,
					);
				}
				skillUrl = frame.url;
			}
			const skills = skillUrl ? await getSitegeistStorage().skills.getSkillsForUrl(skillUrl) : [];
			const skillLibrary = skills.map((skill) => skill.library).join("\n\n");
			const args: unknown[] = JSON.parse(message.args);

			sandboxId = `browserjs_${crypto.randomUUID()}`;
			pageConsoleProvider = new ConsoleRuntimeProvider();
			this.activeSandboxIds.add(sandboxId);
			const wrapperCode = buildWrapperCode(
				message.code,
				skillLibrary,
				[pageConsoleProvider, ...this.sharedProviders],
				sandboxId,
				args,
			);

			// Cancellation is optional because Chrome's terminate API is not always exposed.
			// @ts-expect-error - terminate is not yet in the type definitions
			const supportsTerminate = typeof chrome.userScripts.terminate === "function";
			const executionId = supportsTerminate ? crypto.randomUUID() : undefined;
			if (executionId && abortSignal) {
				abortHandler = async () => {
					try {
						// @ts-expect-error - terminate is not yet in the type definitions
						await chrome.userScripts.terminate(tab.id, executionId);
					} catch (error) {
						console.error("[BrowserJsRuntimeProvider] Failed to terminate execution:", error);
					}
				};
				abortSignal.addEventListener("abort", abortHandler);
			}

			const worldId = "sitegeist-browser-script";
			await chrome.userScripts.configureWorld({
				worldId,
				messaging: true,
				csp: "script-src 'unsafe-eval' 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; frame-src 'none'; font-src 'none'; object-src 'none'; default-src 'none';",
			});
			const injectionConfig: chrome.userScripts.UserScriptInjection & { executionId?: string } = {
				js: [{ code: wrapperCode }],
				target: { tabId: tab.id, frameIds: [frameId] },
				world: "USER_SCRIPT",
				worldId,
				injectImmediately: true,
			};
			if (executionId) injectionConfig.executionId = executionId;

			// Exactly one frame is targeted, so there is only one result to unwrap.
			const [injection] = await chrome.userScripts.execute<{
				success: boolean;
				lastValue?: unknown;
				error?: string;
				stack?: string;
			}>(injectionConfig);
			if (!injection) throw new Error("No result returned from script execution");
			if (injection.error !== undefined) throw new Error(injection.error);

			const result = injection.result;
			respond({
				success: result.success,
				result: result.lastValue,
				error: result.error,
				stack: result.stack,
				console: pageConsoleProvider.getLogs(),
			});
		} catch (error) {
			respond({
				success: false,
				error: abortSignal?.aborted
					? "Script execution was cancelled"
					: error instanceof Error
						? error.message
						: String(error),
				console: pageConsoleProvider?.getLogs(),
			});
		} finally {
			if (abortHandler) abortSignal?.removeEventListener("abort", abortHandler);
			if (sandboxId) {
				RUNTIME_MESSAGE_ROUTER.unregisterSandbox(sandboxId);
				this.activeSandboxIds.delete(sandboxId);
			}
		}
	}

	getDescription(): string {
		return BROWSERJS_RUNTIME_PROVIDER_DESCRIPTION;
	}

	/**
	 * Cleanup all active sandboxes (call when provider is destroyed)
	 */
	public cleanupAll() {
		for (const sandboxId of this.activeSandboxIds) {
			RUNTIME_MESSAGE_ROUTER.unregisterSandbox(sandboxId);
		}
		this.activeSandboxIds.clear();
	}
}

/**
 * NavigateRuntimeProvider
 *
 * Provides the navigate() helper to REPL scripts, which wraps the NavigateTool.
 *
 * Usage in REPL:
 *   await navigate({ url: 'https://example.com' });
 *   await navigate({ history: 'back' });
 */
export class NavigateRuntimeProvider implements SandboxRuntimeProvider {
	constructor(private navigateTool: NavigateTool) {}

	getData(): Record<string, any> {
		return {};
	}

	getRuntime(): (sandboxId: string) => void {
		// This function will be stringified and injected into the REPL iframe
		return (_sandboxId: string) => {
			const sendRuntimeMessage = (window as any).sendRuntimeMessage;
			if (typeof sendRuntimeMessage !== "function") {
				throw new Error("sendRuntimeMessage is not available in this context");
			}

			// Inject navigate() helper
			(window as any).navigate = async (args: any): Promise<any> => {
				const response = await sendRuntimeMessage({
					type: "navigate",
					args,
				});

				if (!response.success) {
					throw new Error(response.error || "navigate() execution failed");
				}

				return response.result;
			};
		};
	}

	async handleMessage(message: any, respond: (response: any) => void): Promise<void> {
		if (message.type !== "navigate") {
			return;
		}

		console.log("[NavigateRuntimeProvider] Received message:", message);

		try {
			// Call the navigate tool
			const result = await this.navigateTool.execute(`navigate_${Date.now()}`, message.args as NavigateParams);

			respond({
				success: true,
				result: result.details,
			});
		} catch (error: any) {
			console.error("[NavigateRuntimeProvider] Error:", error);
			respond({
				success: false,
				error: error.message || String(error),
			});
		}
	}

	getDescription(): string {
		return NAVIGATE_RUNTIME_PROVIDER_DESCRIPTION;
	}
}
