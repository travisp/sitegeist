import type { SandboxRuntimeProvider } from "@earendil-works/pi-web-ui";

/** HTML viewers and downloaded apps read the snapshot applied at their last explicit reload. */
export class SnapshotArtifactsProvider implements SandboxRuntimeProvider {
	constructor(private readonly artifacts: Record<string, string>) {}

	getData(): { artifacts: Record<string, string> } {
		return { artifacts: this.artifacts };
	}

	getRuntime(): (sandboxId: string) => void {
		// The sandbox stringifies this function, so it must not reference the provider or module scope.
		return () => {
			const runtime = window as unknown as {
				artifacts: Record<string, string>;
				listArtifacts: () => Promise<string[]>;
				getArtifact: (filename: string) => Promise<unknown>;
			};
			runtime.listArtifacts = async () => Object.keys(runtime.artifacts);
			runtime.getArtifact = async (filename) => {
				if (!Object.hasOwn(runtime.artifacts, filename)) throw new Error(`Artifact not found: ${filename}`);
				const content = runtime.artifacts[filename];
				return filename.endsWith(".json") ? JSON.parse(content) : content;
			};
		};
	}

	async handleMessage(message: Record<string, unknown>, respond: (response: unknown) => void): Promise<void> {
		if (message.type !== "artifact-operation") return;
		if (message.action === "list") {
			respond({ success: true, result: Object.keys(this.artifacts) });
		} else if (message.action === "get") {
			const filename = message.filename as string;
			respond(
				Object.hasOwn(this.artifacts, filename)
					? { success: true, result: this.artifacts[filename] }
					: { success: false, error: `Artifact not found: ${filename}` },
			);
		} else {
			respond({ success: false, error: "Artifact viewers are read-only." });
		}
	}

	getDescription(): string {
		return "Read snapshot files with listArtifacts() and getArtifact(filename). JSON files are parsed automatically.";
	}
}
