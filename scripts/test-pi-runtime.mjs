import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { build } from "esbuild";
import WebSocket from "ws";
import { createBuildOptions } from "./build-options.mjs";

// Use an existing debug-enabled Chrome. Never reload the user's extension or write its watched output.
const browserUrl = process.env.CHROME_DEBUG_URL ?? "http://127.0.0.1:9222";
const options = createBuildOptions();
const extension = await build({ ...options, write: false });
if (extension.warnings.length) throw new Error("Extension bundle emitted warnings");
console.log(`Extension bundle: ${extension.outputFiles.length} outputs, no warnings`);
const bundle = await build({
	...options,
	entryPoints: ["src/tests/pi-runtime.test.ts"],
	sourcemap: false,
	write: false,
});
if (bundle.warnings.length) throw new Error("Test bundle emitted warnings");
const siteOrb = await build({
	...options,
	entryPoints: ["site/src/frontend/OrbAnimation.ts"],
	sourcemap: false,
	write: false,
});
if (siteOrb.warnings.length) throw new Error("Website orb bundle emitted warnings");
const pdfWorker = await readFile(new URL("../node_modules/pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url));

const server = createServer((request, response) => {
	if (request.url === "/test.js") {
		response.writeHead(200, { "Content-Type": "text/javascript" });
		response.end(bundle.outputFiles[0].contents);
	} else if (request.url === "/pdfjs-dist/build/pdf.worker.min.mjs") {
		response.writeHead(200, { "Content-Type": "text/javascript" });
		response.end(pdfWorker);
	} else if (request.url === "/site-orb.js") {
		response.writeHead(200, { "Content-Type": "text/javascript" });
		response.end(siteOrb.outputFiles[0].contents);
	} else if (request.url === "/site-orb.html") {
		response.writeHead(200, { "Content-Type": "text/html" });
		response.end(
			'<!doctype html><style>.orb-container { width: 160px; height: 160px; }</style><orb-animation></orb-animation><script type="module" src="/site-orb.js"></script>',
		);
	} else {
		response.writeHead(200, { "Content-Type": "text/html" });
		response.end('<!doctype html><title>Pi runtime tests</title><script type="module" src="/test.js"></script>');
	}
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

let target;
let socket;
try {
	const response = await fetch(`${browserUrl}/json/new?about:blank`, { method: "PUT" });
	if (!response.ok) throw new Error(`Chrome target creation failed: ${response.status}`);
	target = await response.json();
	socket = new WebSocket(target.webSocketDebuggerUrl);
	await once(socket, "open");
	let nextId = 0;
	const pending = new Map();
	const events = new Map();
	const runtimeErrors = [];
	socket.on("message", (data) => {
		const message = JSON.parse(data.toString());
		if (message.id) {
			const callback = pending.get(message.id);
			pending.delete(message.id);
			callback(message);
		} else {
			events.get(message.method)?.(message.params);
			if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails);
		}
	});
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = ++nextId;
			const timeout = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 60_000);
			pending.set(id, (message) => {
				clearTimeout(timeout);
				if (message.error) reject(new Error(JSON.stringify(message.error)));
				else resolve(message.result);
			});
			socket.send(JSON.stringify({ id, method, params }));
		});
	await send("Page.enable");
	await send("Runtime.enable");
	const loaded = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Test page did not load")), 60_000);
		events.set("Page.loadEventFired", () => {
			clearTimeout(timeout);
			resolve();
		});
	});
	await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}` });
	await loaded;
	const result = await send("Runtime.evaluate", {
		expression: "globalThis.piRuntimeTests",
		awaitPromise: true,
		returnByValue: true,
	});
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
	const tests = result.result.value;
	if (!Array.isArray(tests) || tests.length === 0) throw new Error("Browser tests did not start");
	for (const test of tests)
		console.log(`${test.error ? "FAIL" : "PASS"} ${test.name}${test.error ? `\n${test.error}` : ""}`);
	if (runtimeErrors.length) console.error(JSON.stringify(runtimeErrors, null, 2));
	if (tests.some((test) => test.error) || runtimeErrors.length) process.exitCode = 1;
} finally {
	socket?.close();
	if (target) await fetch(`${browserUrl}/json/close/${target.id}`);
	server.close();
}
