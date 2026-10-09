import type { Agent } from "@earendil-works/pi-agent-core";
import { ArtifactsToolRenderer, ChatPanel, registerToolRenderer } from "@earendil-works/pi-web-ui";
import { html } from "lit";
import { customElement } from "lit/decorators.js";

/** Keep chat as the default view; only an explicit Preview action opens the sidebar viewer. */
@customElement("sitegeist-chat-panel")
export class SitegeistChatPanel extends ChatPanel {
	onOpenInTab?: (filename: string) => void;
	onArtifactsUpdated?: () => void;
	private previewOpen = false;

	override async setAgent(agent: Agent, config?: Parameters<ChatPanel["setAgent"]>[1]): Promise<void> {
		this.previewOpen = false;
		await super.setAgent(agent, config);
		const panel = this.artifactsPanel!;
		panel.onArtifactsChange = () => {
			if (panel.artifacts.size === 0) this.previewOpen = false;
			this.onArtifactsUpdated?.();
			this.requestUpdate();
		};
		panel.onOpen = () => {
			this.previewOpen = true;
			this.requestUpdate();
		};
		panel.onClose = () => {
			this.previewOpen = false;
			this.requestUpdate();
		};

		// Preserve the existing tool's diff, code, and log rendering, adding a direct viewer action.
		const renderer = new ArtifactsToolRenderer(panel);
		registerToolRenderer("artifacts", {
			render: (params, result, streaming) => {
				const rendered = renderer.render(params, result, streaming);
				const filename = typeof params?.filename === "string" ? params.filename : undefined;
				return {
					...rendered,
					content: html`${rendered.content}${
						filename && panel.artifacts.has(filename)
							? html`
						<button class="text-xs text-muted-foreground hover:text-foreground underline mt-1"
							@click=${() => this.onOpenInTab?.(filename)}>Open in tab</button>
					`
							: ""
					}`,
				};
			},
		});
		this.requestUpdate();
	}

	override render() {
		const panel = this.artifactsPanel;
		if (!this.agentInterface || !panel) return html``;
		const overlay = window.innerWidth < 800;
		panel.collapsed = !this.previewOpen;
		panel.overlay = overlay;
		return html`
			<div class="relative h-full flex flex-col overflow-hidden">
				${
					panel.artifacts.size > 0
						? html`
					<details class="border-b border-border bg-background shrink-0">
						<summary class="px-3 py-2 text-xs cursor-pointer text-muted-foreground">Artifacts (${panel.artifacts.size})</summary>
						<div class="max-h-48 overflow-auto px-3 pb-2 space-y-2">
							${Array.from(
								panel.artifacts.keys(),
								(filename) => html`
								<div class="rounded border border-border p-2 text-xs">
									<div class="font-mono break-all mb-1">${filename}</div>
									<div class="flex gap-3">
										<button class="hover:underline" @click=${() => panel.openArtifact(filename)}>Preview</button>
										<button class="hover:underline" @click=${() => this.onOpenInTab?.(filename)}>Open in tab</button>
									</div>
								</div>
							`,
							)}
						</div>
					</details>
				`
						: ""
				}
				<div class="relative flex flex-1 min-h-0">
					<div class="h-full min-w-0" style=${!overlay && this.previewOpen ? "width: 50%;" : "width: 100%;"}>${this.agentInterface}</div>
					<div class=${overlay ? "absolute inset-0 pointer-events-none" : "h-full min-w-0"}
						style=${overlay ? "" : this.previewOpen ? "width: 50%;" : "display: none;"}>${panel}</div>
				</div>
			</div>
		`;
	}
}
