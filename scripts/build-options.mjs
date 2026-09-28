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
