import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// pi-web-ui 0.75 imports legacy pi-ai globals that moved to the compat entry point.
const piWebUiCompatPlugin = {
	name: "pi-web-ui-compat",
	setup(build) {
		build.onResolve({ filter: /^@earendil-works\/pi-ai$/ }, (args) => {
			if (!args.importer.includes("@earendil-works/pi-web-ui")) return;

			return build.resolve("@earendil-works/pi-ai/compat", {
				kind: args.kind,
				resolveDir: args.resolveDir,
			});
		});
		// Sandboxed HTML may open websites, never privileged extension pages or executable URL schemes.
		build.onLoad({ filter: /\/SandboxedIframe\.js$/ }, async (args) => {
			if (!args.path.includes("/@earendil-works/pi-web-ui/dist/")) return;
			const source = await readFile(args.path, "utf8");
			const condition = 'e.data.type === "open-external-url" && e.source === this.iframe?.contentWindow';
			if (source.split(condition).length !== 3) {
				throw new Error(`Expected two sandbox URL handlers in ${args.path}; review the pinned web UI adaptation`);
			}
			return {
				contents: source.replaceAll(
					condition,
					`${condition} && typeof e.data.url === "string" && /^https?:\\/\\//i.test(e.data.url)`,
				),
				loader: "js",
			};
		});
		// Artifact commands report validation errors as text; do not replay those failures on session restore.
		build.onLoad({ filter: /\/artifacts\.js$/ }, async (args) => {
			if (!args.path.includes("/@earendil-works/pi-web-ui/dist/tools/artifacts/")) return;
			const source = await readFile(args.path, "utf8");
			const condition = 'm.role === "toolResult" && m.toolName === artifactToolName && !m.isError';
			if (source.split(condition).length !== 2) {
				throw new Error(
					`Expected one artifact replay condition in ${args.path}; review the pinned web UI adaptation`,
				);
			}
			return {
				contents: source.replace(
					condition,
					`${condition} && !m.content.some((block) => block.type === "text" && block.text.startsWith("Error:"))`,
				),
				loader: "js",
			};
		});
		// PDF.js 6 moved document destruction to its loading task. Adapt the pinned web UI's three callers.
		build.onLoad({ filter: /\/(attachment-utils|AttachmentOverlay|PdfArtifact)\.js$/ }, async (args) => {
			if (!args.path.includes("/@earendil-works/pi-web-ui/dist/")) return;
			const source = await readFile(args.path, "utf8");
			if (source.split("pdf.destroy();").length !== 2) {
				throw new Error(`Expected one PDF cleanup call in ${args.path}; review the pinned web UI adaptation`);
			}
			return { contents: source.replace("pdf.destroy();", "await pdf.loadingTask.destroy();"), loader: "js" };
		});
	},
};

// Shared by the extension build and the browser integration tests.
export function createBuildOptions(isWatch = false) {
	return {
		absWorkingDir: packageRoot,
		entryPoints: {
			sidepanel: join(packageRoot, "src/sidepanel.ts"),
			artifact: join(packageRoot, "src/artifact.ts"),
			debug: join(packageRoot, "src/debug.ts"),
			icons: join(packageRoot, "src/icons.ts"),
			background: join(packageRoot, "src/background.ts"),
		},
		bundle: true,
		outdir: join(packageRoot, "dist-chrome"),
		format: "esm",
		target: ["chrome120"],
		platform: "browser",
		sourcemap: isWatch ? "inline" : true,
		entryNames: "[name]",
		loader: { ".ts": "ts", ".tsx": "tsx" },
		define: {
			"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? (isWatch ? "development" : "production")),
			"process.env.TARGET_BROWSER": JSON.stringify("chrome"),
			global: "globalThis",
		},
		inject: [join(packageRoot, "scripts/process-shim.js")],
		plugins: [piWebUiCompatPlugin],
		// Force all mini-lit and lit imports to resolve to sitegeist's node_modules.
		alias: {
			process: join(packageRoot, "scripts/process-shim.js"),
			"@mariozechner/mini-lit": join(packageRoot, "node_modules/@mariozechner/mini-lit"),
			lit: join(packageRoot, "node_modules/lit"),
			"lit/decorators.js": join(packageRoot, "node_modules/lit/decorators.js"),
			"lit/directives/class-map.js": join(packageRoot, "node_modules/lit/directives/class-map.js"),
			"lit/directives/unsafe-html.js": join(packageRoot, "node_modules/lit/directives/unsafe-html.js"),
		},
	};
}
