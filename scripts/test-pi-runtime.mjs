import { EventEmitter, once } from "node:events";
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

let socket;
try {
	const response = await fetch(`${browserUrl}/json/version`);
	if (!response.ok) throw new Error(`Chrome discovery failed: ${response.status}`);
	const browser = await response.json();
	socket = new WebSocket(browser.webSocketDebuggerUrl);
	await once(socket, "open");
	await runBrowserTests(socket, `http://127.0.0.1:${server.address().port}`);
} finally {
	socket?.close();
	const closed = once(server, "close");
	server.close();
	// Chrome can leave speculative connections open even after its test tab closes.
	server.closeAllConnections();
	await closed;
}

async function runBrowserTests(socket, url) {
	let nextId = 0;
	let sessionId;
	const pending = new Map();
	const pageEvents = new EventEmitter();
	const disconnected = new AbortController();
	const runtimeErrors = [];
	pageEvents.on("Runtime.exceptionThrown", (event) => runtimeErrors.push(event.exceptionDetails));
	socket.on("message", (data) => {
		const message = JSON.parse(data.toString());
		if (message.id) {
			// A reply can arrive after its request timed out.
			pending.get(message.id)?.(
				message.error ? new Error(JSON.stringify(message.error)) : undefined,
				message.result,
			);
		} else if (message.sessionId === sessionId) {
			pageEvents.emit(message.method, message.params);
		}
	});
	const rejectPending = (error) => {
		disconnected.abort(error);
		for (const finish of pending.values()) finish(error);
	};
	socket.on("close", () => rejectPending(new Error("Chrome connection closed")));
	socket.on("error", rejectPending);
	const send = (method, params = {}, sessionId) =>
		new Promise((resolve, reject) => {
			if (socket.readyState !== WebSocket.OPEN) {
				reject(new Error("Chrome connection is not open"));
				return;
			}
			const id = ++nextId;
			const finish = (error, result) => {
				clearTimeout(timeout);
				pending.delete(id);
				if (error) reject(error);
				else resolve(result);
			};
			const timeout = setTimeout(() => finish(new Error(`Timed out: ${method}`)), 60_000);
			pending.set(id, finish);
			socket.send(JSON.stringify({ id, method, params, sessionId }), (error) => {
				if (error) finish(error);
			});
		});

	const { targetId } = await send("Target.createTarget", { url: "about:blank", background: true });
	try {
		({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
		// Bind page commands to this tab; Target commands use the browser connection directly.
		const page = (method, params) => send(method, params, sessionId);
		await Promise.all([
			page("Page.enable"),
			page("Runtime.enable"),
			// Keep animation-frame rendering tests running without activating the real tab/window.
			page("Emulation.setFocusEmulationEnabled", { enabled: true }),
		]);
		await Promise.all([
			once(pageEvents, "Page.loadEventFired", {
				signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(60_000)]),
			}),
			page("Page.navigate", { url }),
		]);
		const result = await page("Runtime.evaluate", {
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
		if (!disconnected.signal.aborted && socket.readyState === WebSocket.OPEN)
			await send("Target.closeTarget", { targetId });
	}
}
