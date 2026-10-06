import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { packageRoot } from "./build-options.mjs";

// These tests need no browser, credentials, or files in the watched extension output.
const bundle = await build({
	absWorkingDir: packageRoot,
	entryPoints: ["src/tests/session-locks.test.ts"],
	bundle: true,
	write: false,
	format: "esm",
	platform: "node",
	target: "node24",
});
if (bundle.warnings.length) throw new Error("Session lock tests emitted bundle warnings");
execFileSync(process.execPath, ["--input-type=module", "-"], {
	input: bundle.outputFiles[0].contents,
	stdio: ["pipe", "inherit", "inherit"],
});
