import { ArtifactElement, HtmlArtifact, SandboxIframe, type SandboxRuntimeProvider } from "@earendil-works/pi-web-ui";
import { LitElement } from "lit";
import { utils, write } from "xlsx";
import { ArtifactViewer } from "../artifacts/ArtifactViewer.js";
import { type ArtifactSnapshot, type ArtifactViewerMessage, artifactChannelName } from "../artifacts/protocol.js";
import { SnapshotArtifactsProvider } from "../artifacts/SnapshotArtifactsProvider.js";
import { ArtifactViewerConnection } from "../artifacts/viewer-connection.js";
import { assert, type BrowserTest, equal } from "./test-utils.js";

function snapshot(artifacts: Record<string, string>): ArtifactSnapshot {
	return { artifacts, attachments: [] };
}

async function settle(viewer: ArtifactViewer) {
	await viewer.updateComplete;
	for (const element of viewer.querySelectorAll("*")) {
		if (element instanceof LitElement) await element.updateComplete;
	}
	await new Promise(requestAnimationFrame);
	await new Promise(requestAnimationFrame);
}

async function waitUntil(condition: () => boolean) {
	const deadline = performance.now() + 3000;
	while (!condition()) {
		assert(performance.now() < deadline, "Timed out waiting for artifact viewer update");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export const artifactViewerTests: BrowserTest[] = [
	{
		name: "HTML snapshot runtime reads text and JSON in viewers and downloaded apps",
		async run() {
			const fields = ["artifacts", "listArtifacts", "getArtifact"];
			const descriptors = fields.map((field) => [field, Object.getOwnPropertyDescriptor(window, field)] as const);
			const provider = new SnapshotArtifactsProvider({ "notes.txt": "", "data.json": '{"value":2}' });
			const runtime = window as unknown as {
				listArtifacts: () => Promise<string[]>;
				getArtifact: (filename: string) => Promise<unknown>;
			};
			try {
				Object.assign(window, provider.getData());
				// Execute the same stringified function the sandbox injects into previews and downloads.
				new Function(`(${provider.getRuntime().toString()})("snapshot-test")`)();
				equal(await runtime.listArtifacts(), ["notes.txt", "data.json"], "snapshot files listed");
				equal(await runtime.getArtifact("notes.txt"), "", "empty text content retained");
				equal(await runtime.getArtifact("data.json"), { value: 2 }, "JSON content parsed");
			} finally {
				for (const [field, descriptor] of descriptors) {
					if (descriptor) Object.defineProperty(window, field, descriptor);
					else Reflect.deleteProperty(window, field);
				}
			}
		},
	},
	{
		name: "artifact viewer updates one document without replacing it or resetting scroll",
		async run() {
			const viewer = new ArtifactViewer();
			viewer.filename = "report.md";
			const content = Array.from({ length: 100 }, (_, index) => `Paragraph ${index}.`).join("\n\n");
			viewer.applySnapshot(
				snapshot({ "report.md": content, "other.html": "<script>throw Error('must not run')</script>" }),
			);
			document.body.append(viewer);
			try {
				await settle(viewer);
				const documentElement = viewer.querySelector("markdown-artifact");
				assert(documentElement instanceof ArtifactElement, "Markdown renderer mounted");
				assert(!viewer.querySelector("sandbox-iframe"), "unselected HTML never executes");
				const scroller = documentElement.querySelector<HTMLElement>(".overflow-auto");
				assert(scroller, "document has a scroll container");
				scroller.style.height = "100px";
				scroller.style.overflow = "auto";
				scroller.scrollTop = 80;
				equal(scroller.scrollTop, 80, "fixture scrolls");
				viewer.applySnapshot(snapshot({ "report.md": `${content}\n\nNew conclusion.` }));
				await settle(viewer);
				assert(viewer.querySelector("markdown-artifact") === documentElement, "same document element retained");
				equal(scroller.scrollTop, 80, "reading position retained");
				assert(documentElement.textContent?.includes("New conclusion."), "document content updated");
				assert(viewer.querySelector("preview-code-toggle"), "preview/source controls provided");
			} finally {
				viewer.remove();
			}
		},
	},
	{
		name: "Excel artifact updates preserve the selected sheet and replacement scroller offsets across reordering",
		async run() {
			const workbook = (names: string[], version: string): string => {
				const book = utils.book_new();
				for (const name of names) {
					const rows = Array.from({ length: 100 }, (_, row) =>
						Array.from({ length: 8 }, (_, column) => `${version} ${name} row ${row} column ${column}`),
					);
					utils.book_append_sheet(book, utils.aoa_to_sheet(rows), name);
				}
				return write(book, { type: "base64", bookType: "xlsx" });
			};
			const style = document.createElement("style");
			// The integration test page has no app.css; constrain actual replacement scrollers via stylesheet.
			style.textContent = `
				.excel-scroll-fixture #excel-container > div { display: flex; flex-direction: column; width: 320px; height: 180px; overflow: auto; }
				.excel-scroll-fixture #excel-container > div > div:first-child { flex-shrink: 0; }
				.excel-scroll-fixture #excel-container > div > div:not(:first-child) { flex: 1; min-height: 0; min-width: 0; overflow: auto; }
				.excel-scroll-fixture #excel-container table { min-width: 1400px; }
			`;
			const viewer = new ArtifactViewer();
			viewer.className = "excel-scroll-fixture";
			viewer.filename = "report.xlsx";
			viewer.applySnapshot(snapshot({ "report.xlsx": workbook(["Summary", "Details"], "Initial") }));
			document.body.append(style, viewer);
			try {
				await settle(viewer);
				const artifact = viewer.querySelector("excel-artifact");
				assert(artifact instanceof ArtifactElement, "Excel renderer mounted");
				const firstTabs = Array.from(artifact.querySelectorAll<HTMLButtonElement>("#excel-container button"));
				equal(
					firstTabs.map((tab) => tab.textContent),
					["Summary", "Details"],
					"two fixture sheets rendered",
				);
				firstTabs[1].click();
				let scroller = artifact.querySelector("#excel-container")?.firstElementChild?.children[2];
				assert(scroller instanceof HTMLElement, "selected sheet has a scroll wrapper");
				scroller.scrollTop = 80;
				scroller.scrollLeft = 45;
				equal([scroller.scrollTop, scroller.scrollLeft], [80, 45], "fixture scrolls in both directions");
				for (const [names, version] of [
					[["Summary", "Details"], "Updated"],
					[["Details", "Summary"], "Reordered"],
				] as const) {
					const previousScroller: HTMLElement = scroller;
					viewer.applySnapshot(snapshot({ "report.xlsx": workbook([...names], version) }));
					await settle(viewer);
					const tabs = Array.from(artifact.querySelectorAll<HTMLButtonElement>("#excel-container button"));
					equal(
						tabs.map((tab) => tab.textContent),
						names,
						"updated workbook order rendered",
					);
					equal(
						tabs.find((tab) => tab.classList.contains("border-primary"))?.textContent,
						"Details",
						"same sheet remains selected by name",
					);
					scroller =
						artifact.querySelector("#excel-container")?.firstElementChild?.children[
							tabs.findIndex((tab) => tab.textContent === "Details") + 1
						];
					assert(scroller instanceof HTMLElement, "updated selected sheet scroller available");
					assert(
						scroller !== previousScroller && !previousScroller.isConnected,
						"vendor replaced the original scroll wrapper",
					);
					equal(scroller.style.display, "flex", "selected worksheet is visible");
					equal(
						[scroller.scrollTop, scroller.scrollLeft],
						[80, 45],
						"replacement scroller retains reading position",
					);
					assert(scroller.textContent?.includes(`${version} Details row 0 column 0`), "updated cells rendered");
				}
			} finally {
				viewer.remove();
				style.remove();
			}
		},
	},
	{
		name: "artifact viewer defers HTML and dependency updates until explicit reload and rejects writes",
		async run() {
			const originalLoad = SandboxIframe.prototype.loadContent;
			const executions: { html: string; providers: SandboxRuntimeProvider[] }[] = [];
			SandboxIframe.prototype.loadContent = (_id, html, providers = []) => {
				executions.push({ html, providers });
			};
			const viewer = new ArtifactViewer();
			viewer.filename = "dashboard.html";
			const initial = snapshot({
				"dashboard.html": "<html><body>Initial app</body></html>",
				"data.json": '{"value":1}',
			});
			viewer.applySnapshot(initial);
			document.body.append(viewer);
			try {
				await settle(viewer);
				equal(executions.length, 1, "HTML executes exactly once at mount, even with no console logs");
				const app = viewer.querySelector("sitegeist-viewer-html-artifact");
				assert(app instanceof HtmlArtifact, "existing sandbox HTML renderer reused");
				const dependencyUpdate = snapshot({ ...initial.artifacts, "data.json": '{"value":2}' });
				viewer.applySnapshot(dependencyUpdate);
				await settle(viewer);
				equal(executions.length, 1, "dependency update does not reset app");
				assert(viewer.textContent?.includes("Updated — reload"), "pending dependency update is discoverable");
				viewer.applySnapshot(
					snapshot({ ...dependencyUpdate.artifacts, "dashboard.html": "<html><body>Updated app</body></html>" }),
				);
				await settle(viewer);
				equal(executions.length, 1, "HTML source update does not reset app");
				assert(viewer.querySelector("sitegeist-viewer-html-artifact") === app, "interactive app retained");
				assert(app.content.includes("Initial app"), "applied HTML remains unchanged");
				const nativeReload = viewer.querySelector<HTMLButtonElement>('button[title="Reload HTML"]');
				assert(nativeReload, "native HTML reload control available");
				nativeReload.click();
				await settle(viewer);
				equal(executions.length, 2, "native reload applies pending update exactly once");
				assert(executions[1].html.includes("Updated app"), "reload uses latest HTML");
				equal(
					executions[1].providers[0].getData().artifacts["data.json"],
					'{"value":2}',
					"reload uses latest dependent files",
				);
				assert(!viewer.textContent?.includes("Updated — reload"), "pending state clears after reload");
				let response: unknown;
				const provider = executions[1].providers[0];
				assert(provider.handleMessage, "artifact runtime provider supports reads");
				await provider.handleMessage(
					{ type: "artifact-operation", action: "get", filename: "data.json" },
					(value: unknown) => {
						response = value;
					},
				);
				equal(response, { success: true, result: '{"value":2}' }, "HTML reads snapshot files");
				await provider.handleMessage(
					{ type: "artifact-operation", action: "delete", filename: "data.json" },
					(value: unknown) => {
						response = value;
					},
				);
				equal(
					response,
					{ success: false, error: "Artifact viewers are read-only." },
					"viewer cannot mutate session artifacts",
				);
				viewer.applySnapshot({
					...dependencyUpdate,
					artifacts: { ...dependencyUpdate.artifacts, "dashboard.html": "<html><body>Updated app</body></html>" },
					attachments: [
						{
							id: "a",
							type: "document",
							fileName: "notes.txt",
							mimeType: "text/plain",
							size: 1,
							content: "YQ==",
						},
					],
				});
				await settle(viewer);
				equal(executions.length, 2, "attachment update does not reset app");
				assert(viewer.textContent?.includes("Updated — reload"), "attachment change requires reload");
				viewer.reload();
				await settle(viewer);
				equal(executions.length, 3, "explicit viewer reload applies attachments");
			} finally {
				viewer.remove();
				SandboxIframe.prototype.loadContent = originalLoad;
			}
		},
	},
	{
		name: "malformed binary artifacts show an error and recover when valid content arrives",
		async run() {
			const viewer = new ArtifactViewer();
			viewer.filename = "data.bin";
			document.body.append(viewer);
			try {
				viewer.applySnapshot(snapshot({ "data.bin": "not valid base64!" }));
				await settle(viewer);
				assert(!viewer.querySelector("generic-artifact"), "malformed file is not mounted");
				assert(viewer.querySelector('[role="status"]')?.textContent, "file error is visible");
				viewer.applySnapshot(snapshot({ "data.bin": "YQ==" }));
				await settle(viewer);
				assert(viewer.querySelector("generic-artifact"), "valid replacement file renders");
				assert(!viewer.querySelector('[role="status"]'), "file error clears");
			} finally {
				viewer.remove();
			}
		},
	},
	{
		name: "artifact viewer shows deletion and recovers when the file is recreated",
		async run() {
			const viewer = new ArtifactViewer();
			viewer.filename = "report.md";
			document.body.append(viewer);
			try {
				await settle(viewer);
				assert(viewer.textContent?.includes("Loading artifact"), "initial loading state");
				viewer.applySnapshot(snapshot({ "report.md": "# Existing report" }));
				await settle(viewer);
				assert(viewer.querySelector("markdown-artifact"), "file rendered");
				viewer.applySnapshot(snapshot({}));
				await settle(viewer);
				assert(!viewer.querySelector("markdown-artifact"), "deleted renderer removed");
				assert(viewer.textContent?.includes("no longer available"), "deletion state shown");
				viewer.applySnapshot(snapshot({ "report.md": "# Recreated report" }));
				await settle(viewer);
				assert(viewer.textContent?.includes("Recreated report"), "recreated file renders");
			} finally {
				viewer.remove();
			}
		},
	},
	{
		name: "artifact viewer treats inherited property names as missing or deleted files",
		async run() {
			for (const filename of ["constructor", "toString", "__proto__"]) {
				const viewer = new ArtifactViewer();
				viewer.filename = filename;
				document.body.append(viewer);
				try {
					viewer.applySnapshot(snapshot({}));
					viewer.reload();
					await settle(viewer);
					assert(viewer.textContent?.includes("no longer available"), `${filename} initially missing`);
					assert(!viewer.querySelector("generic-artifact"), `${filename} inherited value is not rendered`);
					viewer.applySnapshot(snapshot({ [filename]: "YQ==" }));
					await settle(viewer);
					assert(viewer.querySelector("generic-artifact"), `${filename} own property renders`);
					viewer.applySnapshot(snapshot({}));
					viewer.reload();
					await settle(viewer);
					assert(viewer.textContent?.includes("no longer available"), `${filename} deletion shown`);
					assert(!viewer.querySelector("generic-artifact"), `${filename} renderer removed after deletion`);
				} finally {
					viewer.remove();
				}
			}
		},
	},
	{
		name: "artifact live snapshots stay session-scoped and beat delayed saved state, including deletion",
		async run() {
			const sessionId = crypto.randomUUID();
			const publisher = new BroadcastChannel(artifactChannelName(sessionId));
			const unrelated = new BroadcastChannel(artifactChannelName(crypto.randomUUID()));
			const viewer = new ArtifactViewer();
			viewer.filename = "notes.txt";
			let resolveSaved!: (value: ArtifactSnapshot | null) => void;
			publisher.onmessage = (event: MessageEvent<ArtifactViewerMessage>) => {
				if (event.data.type === "request")
					publisher.postMessage({
						type: "snapshot",
						snapshot: snapshot({ "notes.txt": "Live content" }),
					} satisfies ArtifactViewerMessage);
			};
			const connection = new ArtifactViewerConnection(
				viewer,
				sessionId,
				() =>
					new Promise((resolve) => {
						resolveSaved = resolve;
					}),
			);
			document.body.append(viewer);
			try {
				await waitUntil(() => viewer.textContent?.includes("Live content") === true);
				unrelated.postMessage({
					type: "snapshot",
					snapshot: snapshot({ "notes.txt": "Unrelated content" }),
				} satisfies ArtifactViewerMessage);
				publisher.postMessage({ type: "snapshot", snapshot: snapshot({}) } satisfies ArtifactViewerMessage);
				await waitUntil(() => viewer.textContent?.includes("no longer available") === true);
				resolveSaved(snapshot({ "notes.txt": "Stale saved content" }));
				await settle(viewer);
				assert(
					!viewer.textContent?.includes("Stale saved content"),
					"late saved baseline cannot resurrect deleted file",
				);
				assert(!viewer.textContent?.includes("Unrelated content"), "other sessions cannot change viewer");
				connection.close();
				publisher.postMessage({
					type: "snapshot",
					snapshot: snapshot({ "notes.txt": "After close" }),
				} satisfies ArtifactViewerMessage);
				await settle(viewer);
				assert(!viewer.textContent?.includes("After close"), "closed connection ignores updates");
			} finally {
				connection.close();
				publisher.close();
				unrelated.close();
				viewer.remove();
			}
		},
	},
];
