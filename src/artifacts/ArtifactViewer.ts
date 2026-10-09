import { type ArtifactElement, AttachmentsRuntimeProvider, HtmlArtifact } from "@earendil-works/pi-web-ui";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import type { ArtifactSnapshot } from "./protocol.js";
import { captureReadingPosition } from "./reading-position.js";
import { SnapshotArtifactsProvider } from "./SnapshotArtifactsProvider.js";

/** The pinned HTML renderer otherwise reexecutes whenever it updates without console logs. */
class ViewerHtmlArtifact extends HtmlArtifact {
	applyPendingUpdate?: () => boolean;

	override executeContent(content: string): void {
		if (this.applyPendingUpdate?.()) return;
		super.executeContent(content);
	}

	override updated(): void {
		// Initial execution is handled by firstUpdated; explicit reload and content setters execute themselves.
	}
}
customElements.define("sitegeist-viewer-html-artifact", ViewerHtmlArtifact);

const textExtensions = [
	"txt",
	"json",
	"xml",
	"yaml",
	"yml",
	"csv",
	"js",
	"ts",
	"jsx",
	"tsx",
	"py",
	"java",
	"c",
	"cpp",
	"h",
	"css",
	"scss",
	"sass",
	"less",
	"sh",
	"toml",
	"sql",
	"go",
	"rs",
	"rb",
	"php",
	"swift",
	"kt",
	"r",
];

function artifactTag(filename: string): string {
	const extension = filename.split(".").pop()!.toLowerCase();
	if (extension === "html" || extension === "htm") return "sitegeist-viewer-html-artifact";
	if (extension === "md" || extension === "markdown") return "markdown-artifact";
	if (extension === "svg") return "svg-artifact";
	if (extension === "pdf") return "pdf-artifact";
	if (extension === "docx") return "docx-artifact";
	if (extension === "xlsx" || extension === "xls") return "excel-artifact";
	if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"].includes(extension)) return "image-artifact";
	if (textExtensions.includes(extension)) return "text-artifact";
	return "generic-artifact";
}

function artifactContent(snapshot: ArtifactSnapshot, filename: string): string | undefined {
	return Object.hasOwn(snapshot.artifacts, filename) ? snapshot.artifacts[filename] : undefined;
}

function sameSnapshot(left: ArtifactSnapshot, right: ArtifactSnapshot): boolean {
	const leftNames = Object.keys(left.artifacts);
	const rightNames = Object.keys(right.artifacts);
	return (
		leftNames.length === rightNames.length &&
		leftNames.every(
			(name) => Object.hasOwn(right.artifacts, name) && left.artifacts[name] === right.artifacts[name],
		) &&
		JSON.stringify(left.attachments) === JSON.stringify(right.attachments)
	);
}

export class ArtifactViewer extends LitElement {
	static override properties = { filename: { type: String } };
	filename = "";
	sandboxUrlProvider?: () => string;
	private snapshot?: ArtifactSnapshot;
	private appliedSnapshot?: ArtifactSnapshot;
	private artifact?: ArtifactElement;
	private pendingReload = false;
	private error?: string;
	private headerControls: TemplateResult | HTMLElement | typeof nothing = nothing;

	override createRenderRoot(): this {
		return this;
	}

	applySnapshot(snapshot: ArtifactSnapshot): void {
		this.snapshot = snapshot;
		this.error = undefined;
		try {
			const content = artifactContent(snapshot, this.filename);
			if (content === undefined) {
				this.clearArtifact();
			} else if (!this.artifact) {
				this.createArtifact(snapshot, content);
			} else if (this.artifact instanceof HtmlArtifact) {
				this.pendingReload = !sameSnapshot(this.appliedSnapshot!, snapshot);
			} else if (this.artifact.content !== content) {
				this.updateDocument(content);
			}
			// Validate header controls alongside file content; malformed files show an error instead of losing controls.
			this.headerControls = this.artifact?.getHeaderButtons() ?? nothing;
		} catch (error) {
			this.clearArtifact();
			this.error = error instanceof Error ? error.message : String(error);
		}
		this.requestUpdate();
	}

	showError(message: string): void {
		this.error = message;
		this.requestUpdate();
	}

	reload(): void {
		if (!this.snapshot) return;
		this.clearArtifact();
		this.applySnapshot(this.snapshot);
	}

	private clearArtifact(): void {
		this.artifact = undefined;
		this.appliedSnapshot = undefined;
		this.pendingReload = false;
		this.headerControls = nothing;
	}

	private createArtifact(snapshot: ArtifactSnapshot, content: string): void {
		// The pi-web-ui import registers every tag returned by artifactTag.
		const element = document.createElement(artifactTag(this.filename)) as ArtifactElement;
		element.filename = this.filename;
		element.style.display = "block";
		element.style.height = "100%";
		if (element instanceof ViewerHtmlArtifact) {
			element.runtimeProviders = [
				new SnapshotArtifactsProvider(snapshot.artifacts),
				new AttachmentsRuntimeProvider(snapshot.attachments),
			];
			element.sandboxUrlProvider = this.sandboxUrlProvider;
			// The native HTML reload button uses executeContent too; replace the renderer when changes are pending.
			element.applyPendingUpdate = () => {
				if (!this.pendingReload) return false;
				this.reload();
				return true;
			};
		}
		element.content = content;
		this.artifact = element;
		this.appliedSnapshot = snapshot;
		this.pendingReload = false;
		// Once mounted, HTML download controls can include the sandbox's snapshot data.
		void element.updateComplete.then(() => {
			if (this.artifact === element) {
				this.headerControls = element.getHeaderButtons();
				this.requestUpdate();
			}
		});
	}

	private updateDocument(content: string): void {
		const artifact = this.artifact!;
		const restorePosition = captureReadingPosition(this);
		artifact.content = content;
		void artifact.updateComplete.then(() => {
			requestAnimationFrame(() => {
				if (this.artifact === artifact) restorePosition();
			});
		});
	}

	override render() {
		const status =
			this.error ??
			(this.snapshot ? "This artifact is no longer available in this conversation." : "Loading artifact…");
		return html`
			<div class="h-full flex flex-col bg-background text-foreground">
				<header class="flex flex-wrap items-center gap-2 border-b border-border p-3 shrink-0">
					<div class="min-w-0 flex-1"><h1 class="text-sm font-medium break-all">${this.filename || "Artifact"}</h1></div>
					<div class="flex flex-wrap items-center gap-2">${this.headerControls}
					</div>
				</header>
				${
					this.pendingReload
						? html`<div class="flex items-center justify-between gap-2 border-b border-border bg-muted p-3 text-sm" role="status">
					<span>Updated — reload to apply changes.</span>
					${Button({ variant: "outline", size: "sm", children: "Reload", onClick: () => this.reload() })}
				</div>`
						: nothing
				}
				<main class="flex-1 min-h-0 overflow-auto">${this.artifact ?? html`<div class="p-6 text-sm text-muted-foreground" role="status">${status}</div>`}</main>
			</div>`;
	}
}
customElements.define("sitegeist-artifact-viewer", ArtifactViewer);
