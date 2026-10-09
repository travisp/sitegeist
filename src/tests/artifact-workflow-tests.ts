import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	ArtifactsPanel,
	type Attachment,
	createStreamFn,
	DefaultRenderer,
	getToolRenderer,
	RUNTIME_MESSAGE_ROUTER,
	registerToolRenderer,
	SandboxIframe,
} from "@earendil-works/pi-web-ui";
import { render } from "lit";
import { openArtifactViewer } from "../artifacts/open-viewer.js";
import {
	type ArtifactSnapshot,
	type ArtifactViewerMessage,
	artifactChannelName,
	artifactViewerUrl,
	snapshotFromMessages,
} from "../artifacts/protocol.js";
import { ArtifactPublisher } from "../artifacts/publisher.js";
import { SitegeistChatPanel } from "../components/SitegeistChatPanel.js";
import { BrowserTarget, browserTarget } from "../tools/browser-target.js";
import { NavigateTool } from "../tools/navigate.js";
import { SkillDisclosure } from "../utils/format-skills.js";
import { assert, type BrowserTest, equal } from "./test-utils.js";

export const artifactWorkflowTests: BrowserTest[] = [];
const test = (name: string, run: () => Promise<void>) => artifactWorkflowTests.push({ name, run });

function operation(
	id: string,
	args: { command: string; filename: string; content?: string; old_str?: string; new_str?: string },
	options: { isError?: boolean; output?: string } = {},
): AgentMessage[] {
	return [
		fauxAssistantMessage(fauxToolCall("artifacts", args, { id }), { stopReason: "toolUse" }),
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "artifacts",
			content: [{ type: "text", text: options.output ?? "Done" }],
			isError: options.isError ?? false,
			timestamp: 1,
		},
	];
}

function nextSnapshot(channel: BroadcastChannel): Promise<ArtifactSnapshot> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			channel.removeEventListener("message", received);
			reject(new Error("Timed out waiting for artifact snapshot"));
		}, 2000);
		function received(event: MessageEvent<ArtifactViewerMessage>) {
			if (event.data.type !== "snapshot") return;
			clearTimeout(timeout);
			channel.removeEventListener("message", received);
			resolve(event.data.snapshot);
		}
		channel.addEventListener("message", received);
	});
}

function mockTab(id: number, windowId: number, url: string, active = false): chrome.tabs.Tab {
	return {
		id,
		windowId,
		url,
		active,
		title: `Tab ${id}`,
		index: 0,
		pinned: false,
		highlighted: active,
		incognito: false,
		selected: active,
		discarded: false,
		autoDiscardable: true,
		groupId: -1,
		frozen: false,
		splitViewId: -1,
		lastAccessed: 0,
	};
}

function replaceChrome(value: unknown): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
	Object.defineProperty(globalThis, "chrome", { configurable: true, value });
	return () => {
		if (descriptor) Object.defineProperty(globalThis, "chrome", descriptor);
		else Reflect.deleteProperty(globalThis, "chrome");
	};
}

const getURL = (path: string) => `chrome-extension://artifact-test/${path}`;

test("saved artifact reconstruction replays successful tool and REPL changes without executing HTML", async () => {
	const attachment: Attachment = {
		id: "attachment",
		type: "document",
		fileName: "source.txt",
		mimeType: "text/plain",
		size: 6,
		content: "c291cmNl",
	};
	const messages: AgentMessage[] = [
		{ role: "user-with-attachments", content: "Read source", timestamp: 1, attachments: [attachment] },
		...operation("create", { command: "create", filename: "notes.md", content: "Hello old" }),
		...operation("edit", { command: "update", filename: "notes.md", old_str: "old", new_str: "new" }),
		...operation("rewrite", { command: "rewrite", filename: "notes.md", content: "Final notes" }),
		...operation("failed-rewrite", { command: "rewrite", filename: "notes.md", content: "Wrong" }, { isError: true }),
		...operation(
			"text-error",
			{ command: "rewrite", filename: "notes.md", content: "Also wrong" },
			{ output: "Error: rejected" },
		),
		...operation("html", {
			command: "create",
			filename: "app.html",
			content: "<script>throw new Error('must not execute')</script>",
		}),
		...operation("prototype", { command: "create", filename: "__proto__", content: "ordinary filename" }),
		...operation("empty", { command: "create", filename: "empty.txt", content: "" }),
		{ role: "artifact", action: "create", filename: "data.json", content: "[1]", timestamp: "2026-01-01T00:00:00Z" },
		{
			role: "artifact",
			action: "update",
			filename: "data.json",
			content: "[1,2]",
			timestamp: "2026-01-01T00:00:01Z",
		},
		...operation("temporary", { command: "create", filename: "temporary.txt", content: "delete me" }),
		...operation("delete-tool", { command: "delete", filename: "temporary.txt" }),
		{
			role: "artifact",
			action: "create",
			filename: "repl-temp.txt",
			content: "delete me",
			timestamp: "2026-01-01T00:00:02Z",
		},
		{ role: "artifact", action: "delete", filename: "repl-temp.txt", timestamp: "2026-01-01T00:00:03Z" },
		...operation("read", { command: "get", filename: "notes.md" }, { output: "Final notes" }),
	];
	const before = JSON.stringify(messages);
	const snapshot = snapshotFromMessages(messages);
	equal(snapshot.artifacts["notes.md"], "Final notes", "failed and read operations do not mutate files");
	equal(snapshot.artifacts["data.json"], "[1,2]", "REPL writes survive reconstruction");
	equal(snapshot.artifacts["empty.txt"], "", "empty saved file retained");
	equal(
		Reflect.get(snapshot.artifacts, "__proto__"),
		"ordinary filename",
		"prototype-like filename is an ordinary own property",
	);
	assert(Object.hasOwn(snapshot.artifacts, "__proto__"), "no prototype mutation");
	assert(snapshot.artifacts["app.html"].includes("must not execute"), "generated HTML preserved as data");
	assert(!Object.hasOwn(snapshot.artifacts, "temporary.txt"), "tool deletion applied");
	assert(!Object.hasOwn(snapshot.artifacts, "repl-temp.txt"), "REPL deletion applied");
	equal(snapshot.attachments, [attachment], "attachment data retained for HTML readers");
	equal(JSON.stringify(messages), before, "reconstruction does not change session history");
});

test("artifact publisher answers independent viewers and isolates reconnects and closed owners", async () => {
	const sessionId = `publisher-${crypto.randomUUID()}`;
	const otherSessionId = `${sessionId}-other`;
	const viewer = new BroadcastChannel(artifactChannelName(sessionId));
	const movedViewer = new BroadcastChannel(artifactChannelName(sessionId));
	const otherViewer = new BroadcastChannel(artifactChannelName(otherSessionId));
	let current: ArtifactSnapshot = { artifacts: { "notes.md": "initial" }, attachments: [] };
	const publisher = new ArtifactPublisher(() => current);
	try {
		const initial = nextSnapshot(viewer);
		const movedInitial = nextSnapshot(movedViewer);
		publisher.connect(sessionId);
		equal(await initial, current, "initial snapshot reaches first viewer");
		equal(await movedInitial, current, "same-session subscriber needs no window identifier");

		const response = nextSnapshot(movedViewer);
		const broadcastResponse = nextSnapshot(viewer);
		movedViewer.postMessage({ type: "request" } satisfies ArtifactViewerMessage);
		equal(await response, current, "viewer can request current live state");
		equal(await broadcastResponse, current, "request response updates all session viewers");

		current = { artifacts: { "notes.md": "updated", "data.json": "[2]" }, attachments: [] };
		const firstUpdate = nextSnapshot(viewer);
		const movedUpdate = nextSnapshot(movedViewer);
		publisher.publish();
		equal(await firstUpdate, current, "first viewer receives live updates");
		equal(await movedUpdate, current, "independent viewer receives the same updates");

		let oldSessionUpdates = 0;
		viewer.addEventListener("message", (event: MessageEvent<ArtifactViewerMessage>) => {
			if (event.data.type === "snapshot") oldSessionUpdates++;
		});
		const reconnected = nextSnapshot(otherViewer);
		publisher.connect(otherSessionId);
		equal(await reconnected, current, "new session channel receives snapshot");
		viewer.postMessage({ type: "request" } satisfies ArtifactViewerMessage);
		await new Promise((resolve) => setTimeout(resolve, 40));
		equal(oldSessionUpdates, 0, "old session channel cannot receive or request new session data");

		let closedOwnerUpdates = 0;
		otherViewer.addEventListener("message", (event: MessageEvent<ArtifactViewerMessage>) => {
			if (event.data.type === "snapshot") closedOwnerUpdates++;
		});
		publisher.close();
		publisher.publish();
		otherViewer.postMessage({ type: "request" } satisfies ArtifactViewerMessage);
		await new Promise((resolve) => setTimeout(resolve, 40));
		equal(closedOwnerUpdates, 0, "closed owner stops responding without disturbing viewer data");
	} finally {
		publisher.close();
		viewer.close();
		movedViewer.close();
		otherViewer.close();
	}
});

test("open artifact viewer reuses its tab after moving to another window", async () => {
	const tabs: chrome.tabs.Tab[] = [];
	const queries: chrome.tabs.QueryInfo[] = [];
	const creations: chrome.tabs.CreateProperties[] = [];
	const selections: Array<{ id: number; options: chrome.tabs.UpdateProperties }> = [];
	const focusedWindows: number[] = [];
	const restore = replaceChrome({
		runtime: { getURL },
		tabs: {
			query: async (query: chrome.tabs.QueryInfo) => {
				queries.push(query);
				return tabs;
			},
			create: async (options: chrome.tabs.CreateProperties) => {
				creations.push(options);
				const tab = mockTab(11, options.windowId!, options.url!, options.active);
				tabs.push(tab);
				return tab;
			},
			update: async (id: number, options: chrome.tabs.UpdateProperties) => {
				selections.push({ id, options });
				return tabs.find((tab) => tab.id === id);
			},
		},
		windows: { update: async (id: number) => focusedWindows.push(id) },
	});
	try {
		const filename = "a document & chart #1.md";
		await openArtifactViewer("session / one", filename, 10);
		equal(
			creations,
			[{ url: artifactViewerUrl("session / one", filename), windowId: 10, active: true }],
			"new viewer opens only on explicit user action",
		);
		const viewerUrl = new URL(tabs[0].url!);
		equal(viewerUrl.searchParams.get("file"), filename, "filename survives URL encoding");
		equal(viewerUrl.searchParams.get("session"), "session / one", "session id survives URL encoding");
		tabs[0].windowId = 20;
		await openArtifactViewer("session / one", filename, 10);
		equal(creations.length, 1, "moving viewer does not cause duplicate tab");
		equal(selections, [{ id: 11, options: { active: true } }], "existing moved viewer selected");
		equal(focusedWindows, [20], "explicit reopening focuses viewer's current window");
		assert(
			queries.every((query) => query.windowId === undefined),
			"viewer search is not tied to working window",
		);
		await openArtifactViewer("other session", filename, 10);
		equal(creations.length, 2, "same filename in another session uses another viewer");
	} finally {
		restore();
	}
});

test("artifact viewers never replace the browser working target or appear in target listings", async () => {
	const website = mockTab(1, 10, "https://example.test/work", true);
	const viewer = mockTab(2, 10, `${getURL("artifact.html")}?session=test&file=notes.md`);
	const tabs = [website, viewer];
	let activeTab = website;
	const selected: number[] = [];
	const restore = replaceChrome({
		runtime: { getURL },
		tabs: {
			query: async (query: chrome.tabs.QueryInfo) =>
				query.active ? [activeTab] : tabs.filter((tab) => tab.windowId === query.windowId),
			get: async (id: number) => {
				const tab = tabs.find((item) => item.id === id);
				if (!tab) throw new Error("No such tab");
				return tab;
			},
			update: async (id: number) => {
				selected.push(id);
				return tabs.find((tab) => tab.id === id);
			},
		},
	});
	try {
		const target = new BrowserTarget();
		await target.capture(10);
		await browserTarget.capture(10);
		activeTab = viewer;
		website.active = false;
		viewer.active = true;
		equal((await target.capture(10)).id, website.id, "starting another turn while viewing artifact retains website");
		equal(target.tabId, website.id, "capture does not retarget to generated content");
		equal(selected, [], "capture does not silently select or focus another tab");

		let rejected = false;
		try {
			await target.select(viewer.id);
		} catch {
			rejected = true;
		}
		assert(rejected, "explicit browser target selection rejects artifact viewer");
		equal(target.tabId, website.id, "rejected selection leaves working target intact");
		equal(selected, [], "viewer rejection happens before browser selection");

		rejected = false;
		try {
			await new BrowserTarget().capture(10);
		} catch {
			rejected = true;
		}
		assert(rejected, "fresh sidebar asks for a website rather than targeting viewer");

		const listed = await new NavigateTool(new SkillDisclosure()).execute("list", { listTabs: true });
		assert(listed.details.kind === "tabs", "tab list result");
		equal(
			listed.details.tabs.map((tab) => tab.id),
			[website.id],
			"viewer omitted from automation target listings",
		);
	} finally {
		restore();
	}
});

test("sidebar artifacts stay closed until Preview and Open in tab never takes over chat", async () => {
	const previousRenderer = getToolRenderer("artifacts");
	const view = new SitegeistChatPanel();
	const toolHost = document.createElement("div");
	const opened: string[] = [];
	let updates = 0;
	view.onOpenInTab = (filename) => opened.push(filename);
	view.onArtifactsUpdated = () => updates++;
	view.style.width = "500px";
	view.style.height = "600px";
	const agent = new Agent({
		initialState: { model: getModel("anthropic", "claude-sonnet-4-6"), messages: [] },
		streamFn: createStreamFn(async () => undefined),
	});
	document.body.append(view, toolHost);
	try {
		await view.setAgent(agent);
		const artifacts = view.artifactsPanel;
		assert(artifacts, "artifact panel initialized");
		const settled = async () => {
			await view.updateComplete;
			await artifacts.updateComplete;
			await new Promise(requestAnimationFrame);
			await view.updateComplete;
			await artifacts.updateComplete;
		};
		await settled();
		assert(artifacts.collapsed, "initial conversation has no preview takeover");

		await artifacts.tool.execute("create", { command: "create", filename: "notes.md", content: "# First notes" });
		await settled();
		assert(artifacts.collapsed, "artifact creation leaves chat visible");
		assert(artifacts.querySelector(".hidden"), "sidebar viewer remains hidden after creation");
		equal(updates, 1, "creation notifies live publisher hook");

		const shelf = view.querySelector("details");
		assert(shelf, "artifact shelf is discoverable without opening viewer");
		shelf.open = true;
		const preview = Array.from(shelf.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Preview",
		);
		assert(preview, "explicit Preview action exists");
		preview.click();
		await settled();
		assert(!artifacts.collapsed, "Preview explicitly opens sidebar viewer");
		const close = artifacts.querySelector<HTMLButtonElement>('button[title="Close artifacts"]');
		assert(close, "preview has a close button");
		close.click();
		await settled();
		assert(artifacts.collapsed, "closing preview returns to conversation");

		await artifacts.tool.execute("rewrite", { command: "rewrite", filename: "notes.md", content: "# Updated notes" });
		await artifacts.tool.execute("create-other", {
			command: "create",
			filename: "other.md",
			content: "# Other file",
		});
		await settled();
		assert(artifacts.collapsed, "updates and subsequent artifacts respect the closed preview");
		equal(updates, 3, "closed preview still publishes every artifact change");
		equal(
			artifacts.artifacts.get("notes.md")?.content,
			"# Updated notes",
			"closed viewer does not block file updates",
		);

		const openInTab = Array.from(shelf.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Open in tab",
		);
		assert(openInTab, "artifact shelf offers Open in tab");
		openInTab.click();
		await settled();
		equal(opened, ["notes.md"], "shelf passes selected artifact to tab opener");
		assert(artifacts.collapsed, "Open in tab does not open sidebar viewer");

		const renderer = getToolRenderer("artifacts");
		assert(renderer, "artifact tool renderer registered");
		render(
			renderer.render({ command: "create", filename: "notes.md", content: "# Updated notes" }, undefined, false)
				.content,
			toolHost,
		);
		const toolOpenInTab = Array.from(toolHost.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Open in tab",
		);
		assert(toolOpenInTab, "artifact tool output has direct Open in tab action");
		toolOpenInTab.click();
		await settled();
		equal(opened, ["notes.md", "notes.md"], "tool output uses the same tab opener callback");
		assert(artifacts.collapsed, "tool Open in tab also preserves conversation view");
	} finally {
		view.remove();
		toolHost.remove();
		registerToolRenderer("artifacts", previousRenderer ?? new DefaultRenderer());
	}
});

test("sidebar and tab restoration both ignore duplicate-create errors reported as text", async () => {
	const messages = [
		...operation("first-create", { command: "create", filename: "notes.md", content: "Original A" }),
		...operation(
			"duplicate-create",
			{ command: "create", filename: "notes.md", content: "Rejected B" },
			{
				isError: false,
				output: "Error: File notes.md already exists",
			},
		),
	];
	const sidebar = new ArtifactsPanel();
	document.body.append(sidebar);
	try {
		await sidebar.reconstructFromMessages(messages);
		equal(
			sidebar.artifacts.get("notes.md")?.content,
			"Original A",
			"sidebar does not replay failed duplicate create",
		);
		const snapshot = snapshotFromMessages(messages);
		equal(snapshot.artifacts["notes.md"], "Original A", "tab snapshot retains first successful content");
		equal(
			Object.fromEntries(Array.from(sidebar.artifacts, ([filename, artifact]) => [filename, artifact.content])),
			snapshot.artifacts,
			"sidebar and tab restore the same files",
		);
	} finally {
		sidebar.remove();
	}
});

test("navigate rejects viewer destination URLs before selecting or creating any browser tab", async () => {
	let browserCalls = 0;
	const unexpectedSideEffect = async () => {
		browserCalls++;
		throw new Error("Browser API must not be called for a viewer destination");
	};
	const restore = replaceChrome({
		runtime: { getURL },
		tabs: {
			query: unexpectedSideEffect,
			get: unexpectedSideEffect,
			update: unexpectedSideEffect,
			create: unexpectedSideEffect,
		},
	});
	try {
		const tool = new NavigateTool(new SkillDisclosure());
		const destinations = [
			{ url: artifactViewerUrl("session", "notes.md") },
			{ url: artifactViewerUrl("session", "notes.md"), newTab: true },
			{ url: `${getURL("artifact.html")}#only` },
			{ url: `${getURL("artifact.html")}#only`, newTab: true },
		];
		for (const destination of destinations) {
			let error: unknown;
			try {
				await tool.execute("viewer-navigation", destination);
			} catch (caught) {
				error = caught;
			}
			assert(
				error instanceof Error && error.message.includes("Artifact viewers"),
				"viewer destination rejected at the action boundary",
			);
			equal(browserCalls, 0, "rejection happens before any browser API side effect");
		}
	} finally {
		restore();
	}
});

test("both sandbox link handlers allow websites but reject privileged and executable URL schemes", async () => {
	const originalOpen = window.open;
	const openedTabs: string[] = [];
	const openedWindows: string[] = [];
	const restore = replaceChrome({
		runtime: { getURL },
		tabs: { create: async (options: chrome.tabs.CreateProperties) => openedTabs.push(options.url!) },
	});
	window.open = (url) => {
		openedWindows.push(String(url));
		return null;
	};
	try {
		for (const extensionMode of [true, false]) {
			const sandbox = new SandboxIframe();
			const sandboxId = `external-link-filter-${crypto.randomUUID()}`;
			const listeners: EventListenerOrEventListenerObject[] = [];
			if (extensionMode) sandbox.sandboxUrlProvider = () => "about:blank";
			document.body.append(sandbox);
			try {
				// The pinned component owns these listeners but does not remove them on disconnect.
				// Capture only this synchronous load's registrations so the test can clean up completely.
				const addEventListener = window.addEventListener;
				window.addEventListener = (...args: Parameters<Window["addEventListener"]>) => {
					if (args[0] === "message") listeners.push(args[1]);
					addEventListener.apply(window, args);
				};
				try {
					sandbox.loadContent(sandboxId, "<html><body>Sandbox link test</body></html>");
				} finally {
					window.addEventListener = addEventListener;
				}
				const frame = sandbox.querySelector("iframe");
				assert(frame?.contentWindow, "sandbox iframe has a real message source");
				const source = frame.contentWindow;
				const send = (url: unknown, messageSource: Window = source) => {
					window.dispatchEvent(
						new MessageEvent("message", {
							data: { type: "open-external-url", url },
							source: messageSource,
							origin: "null",
						}),
					);
				};
				const allowed = [
					"https://example.test/research",
					"http://example.test/plain",
					"HTTPS://example.test/uppercase",
				];
				for (const url of allowed) send(url);
				const rejected = [
					getURL("sidepanel.html?teststeps=must-not-run"),
					"javascript:throw new Error('must not run')",
					"data:text/html,<p>must not open</p>",
					"file:///must-not-open.html",
					"about:blank",
					null,
					123,
				];
				for (const url of rejected) send(url);
				send("https://example.test/spoofed-source", window);
				if (extensionMode) {
					equal(openedTabs, allowed, "extension handler forwards only HTTP(S) from its own iframe");
					equal(openedWindows, [], "extension mode uses mocked tabs API without opening real windows");
				} else {
					equal(openedWindows, allowed, "srcdoc handler forwards only HTTP(S) from its own iframe");
					equal(openedTabs, allowed, "srcdoc mode does not use extension tabs API");
				}
			} finally {
				sandbox.remove();
				RUNTIME_MESSAGE_ROUTER.unregisterSandbox(sandboxId);
				for (const listener of listeners) window.removeEventListener("message", listener);
			}
		}
	} finally {
		window.open = originalOpen;
		restore();
	}
});
