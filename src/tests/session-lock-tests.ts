import { type SessionLockState, type SessionLockStorage, SessionLocks } from "../background/session-locks.js";
import { type SidepanelConnection, SidepanelPort } from "../utils/port.js";
import type { SidepanelRequest, SidepanelResponse } from "../utils/sidepanel-protocol.js";
import { assert, type BrowserTest, equal } from "./test-utils.js";

export const sessionLockTests: BrowserTest[] = [];
const test = (name: string, run: () => Promise<void>) => sessionLockTests.push({ name, run });

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

class MemoryLockStorage implements SessionLockStorage {
	state: SessionLockState;
	gate?: Promise<void>;
	onSave?: () => void;
	activeWrites = 0;
	maxActiveWrites = 0;

	constructor(state: SessionLockState = { locks: {}, openWindows: [] }) {
		this.state = structuredClone(state);
	}

	async load(): Promise<SessionLockState> {
		return structuredClone(this.state);
	}

	async save(state: SessionLockState): Promise<void> {
		this.activeWrites++;
		this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
		this.onSave?.();
		try {
			await this.gate;
			this.state = structuredClone(state);
		} finally {
			this.activeWrites--;
		}
	}
}

const acquire = (requestId: string, sessionId = "shared"): SidepanelRequest => ({
	type: "acquireLock",
	requestId,
	sessionId,
});

async function expectRejected(promise: Promise<unknown>, text: string) {
	try {
		await promise;
	} catch (error) {
		assert(String(error).includes(text), `failure includes ${text}`);
		return;
	}
	throw new Error(`Expected rejection containing ${text}`);
}

test("simultaneous session requests have one owner and await the persisted grant", async () => {
	const storage = new MemoryLockStorage();
	const locks = new SessionLocks(storage);
	const a = {};
	const b = {};
	await Promise.all([locks.connect(a, 10), locks.connect(b, 20)]);
	const gate = deferred<void>();
	const started = deferred<void>();
	storage.gate = gate.promise;
	storage.onSave = () => started.resolve();
	let replied = false;
	const first = locks.handleRequest(a, acquire("a")).then((response) => {
		replied = true;
		return response;
	});
	const second = locks.handleRequest(b, acquire("b"));
	await started.promise;
	assert(!replied, "grant does not precede persistence");
	equal(storage.state.locks, {}, "write is still pending");
	gate.resolve();
	equal(await first, { type: "lockResult", requestId: "a", sessionId: "shared", success: true }, "first owner");
	equal(
		await second,
		{ type: "lockResult", requestId: "b", sessionId: "shared", success: false, ownerWindowId: 10 },
		"second window cannot acquire the same session",
	);
	equal(storage.state.locks, { shared: 10 }, "only one owner persisted");
	equal(storage.maxActiveWrites, 1, "state writes never overlap");
});

test("concurrent acquisitions of different sessions preserve both locks", async () => {
	const storage = new MemoryLockStorage();
	const locks = new SessionLocks(storage);
	const a = {};
	const b = {};
	await Promise.all([locks.connect(a, 10), locks.connect(b, 20)]);
	await Promise.all([locks.handleRequest(a, acquire("a", "first")), locks.handleRequest(b, acquire("b", "second"))]);
	equal(storage.state.locks, { first: 10, second: 20 }, "neither write loses the other lock");
	const again = await locks.handleRequest(a, acquire("again", "first"));
	assert(again.type === "lockResult" && again.success, "the same owner can reacquire its session");
});

test("closing one connection keeps locks until the last connection in its window closes", async () => {
	const storage = new MemoryLockStorage();
	const locks = new SessionLocks(storage);
	const oldConnection = {};
	const activeConnection = {};
	const otherWindow = {};
	await Promise.all([
		locks.connect(oldConnection, 10),
		locks.connect(activeConnection, 10),
		locks.connect(otherWindow, 20),
	]);
	await locks.handleRequest(activeConnection, acquire("owner"));
	await locks.handleRequest(otherWindow, acquire("other", "other-session"));
	await locks.disconnect(oldConnection);
	assert(locks.isOpen(10), "another connection keeps the window open");
	const denied = await locks.handleRequest(otherWindow, acquire("denied"));
	assert(denied.type === "lockResult" && !denied.success, "lock remains exclusive");
	await locks.disconnect(activeConnection);
	assert(!locks.isOpen(10), "last connection closes the window");
	equal(storage.state.locks, { "other-session": 20 }, "only the closing window's locks are released");
	const granted = await locks.handleRequest(otherWindow, acquire("granted"));
	assert(granted.type === "lockResult" && granted.success, "released session is available");
	await locks.disconnect(oldConnection);
	equal(storage.state.locks.shared, 20, "late disconnect cannot release another owner's lock");
});

test("window closure releases its locks and invalidates its connections", async () => {
	const storage = new MemoryLockStorage();
	const locks = new SessionLocks(storage);
	const connection = {};
	await locks.connect(connection, 10);
	await locks.handleRequest(connection, acquire("owner"));
	await locks.closeWindow(10);
	equal(storage.state, { locks: {}, openWindows: [] }, "window state and locks are saved together");
	await expectRejected(locks.handleRequest(connection, acquire("closed")), "connection closed");
});

test("startup restores ownership without overwriting newer connection events", async () => {
	const initial = deferred<SessionLockState>();
	const storage = new MemoryLockStorage();
	const locks = new SessionLocks({ load: () => initial.promise, save: (state) => storage.save(state) });
	const connection = {};
	const opening = locks.connect(connection, 10);
	const closing = locks.closeWindow(20);
	initial.resolve({ locks: { closed: 20, retained: 30 }, openWindows: [20, 30] });
	await Promise.all([opening, closing]);
	assert(locks.isOpen(10), "new connection is not lost during restoration");
	assert(!locks.isOpen(20), "closed window is not restored as open");
	assert(locks.isOpen(30), "untouched window remains open across worker startup");
	equal(storage.state.locks, { retained: 30 }, "closed owner's locks are removed");
	const response = await locks.handleRequest(connection, acquire("retained", "retained"));
	assert(response.type === "lockResult" && !response.success, "restored owner still excludes other windows");
});

test("failed initialization or persistence never produces a successful grant", async () => {
	const storage = new MemoryLockStorage();
	const locks = new SessionLocks(storage);
	const connection = {};
	await locks.connect(connection, 10);
	storage.gate = Promise.reject(new Error("write failed"));
	await expectRejected(locks.handleRequest(connection, acquire("failed")), "write failed");
	equal(storage.state.locks, {}, "failed grant was not persisted");
	storage.gate = undefined;
	const otherConnection = {};
	await locks.connect(otherConnection, 20);
	const response = await locks.handleRequest(otherConnection, acquire("recovered"));
	assert(response.type === "lockResult" && response.success, "failed write does not leave a phantom owner");
	const unavailable = new SessionLocks({
		load: async () => {
			throw new Error("load failed");
		},
		save: async () => {
			throw new Error("must not save");
		},
	});
	await expectRejected(unavailable.connect({}, 20), "load failed");
});

class FakeConnection implements SidepanelConnection {
	readonly sent: SidepanelRequest[] = [];
	private readonly messageListeners: ((message: SidepanelResponse) => void)[] = [];
	private readonly disconnectListeners: (() => void)[] = [];
	onSend?: (message: SidepanelRequest) => void;
	readonly onMessage = {
		addListener: (listener: (message: SidepanelResponse) => void) => this.messageListeners.push(listener),
	};
	readonly onDisconnect = {
		addListener: (listener: () => void) => this.disconnectListeners.push(listener),
	};

	postMessage(message: SidepanelRequest): void {
		this.sent.push(message);
		this.onSend?.(message);
	}

	reply(message: SidepanelResponse): void {
		for (const listener of this.messageListeners) listener(message);
	}

	disconnect(): void {
		for (const listener of this.disconnectListeners) listener();
	}
}

function clientFixture() {
	const connections: FakeConnection[] = [];
	const client = new SidepanelPort((name) => {
		equal(name, "sidepanel:10", "connection identifies its window");
		const connection = new FakeConnection();
		connections.push(connection);
		return connection;
	});
	client.initialize(10);
	return { client, connections };
}

test("sidebar initialization retains its connection and correlates out-of-order replies", async () => {
	const { client, connections } = clientFixture();
	assert(client.isConnected(), "initial connection retained");
	const first = client.sendMessage({ type: "acquireLock", sessionId: "first" });
	const second = client.sendMessage({ type: "acquireLock", sessionId: "second" });
	equal(connections.length, 1, "requests reuse the initial connection");
	const connection = connections[0];
	const [a, b] = connection.sent;
	assert(a.requestId !== b.requestId, "same-type requests have different IDs");
	connection.reply({ type: "lockResult", requestId: b.requestId, sessionId: "second", success: true });
	connection.reply({ type: "lockResult", requestId: a.requestId, sessionId: "first", success: true });
	equal((await first).sessionId, "first", "first response reaches first caller");
	equal((await second).sessionId, "second", "second response reaches second caller");
});

test("sidebar reconnects pending requests without a late old disconnect clearing the new port", async () => {
	const { client, connections } = clientFixture();
	const request = client.sendMessage({ type: "acquireLock", sessionId: "shared" });
	const oldConnection = connections[0];
	oldConnection.disconnect();
	await Promise.resolve();
	const current = connections[1];
	assert(current, "pending request reconnects immediately");
	oldConnection.disconnect();
	assert(client.isConnected(), "old disconnect does not clear current connection");
	current.reply({ type: "lockResult", requestId: current.sent[0].requestId, sessionId: "shared", success: true });
	assert((await request).success, "retry completes through current connection");
});

test("a request timeout does not close the healthy port or consume a late response", async () => {
	const { client, connections } = clientFixture();
	const connection = connections[0];
	const slowRequest = client.sendMessage({ type: "acquireLock", sessionId: "shared" }, 1);
	connection.onSend = (message) => {
		if (message.type !== "acquireLock") return;
		connection.reply({
			type: "lockResult",
			requestId: connection.sent[0].requestId,
			sessionId: "stale",
			success: true,
		});
		connection.reply({ type: "lockResult", requestId: message.requestId, sessionId: "shared", success: true });
	};
	const otherRequest = client.sendMessage({ type: "getLockedSessions" });
	const response = await slowRequest;
	equal(response.sessionId, "shared", "late first-attempt reply is ignored");
	equal(connections.length, 1, "timeout keeps the healthy port");
	connection.reply({ type: "lockedSessions", requestId: connection.sent[1].requestId, locks: { shared: 10 } });
	equal((await otherRequest).locks, { shared: 10 }, "timeout does not interrupt another pending request");
});

test("two sidebar clients cannot both open the same latest session", async () => {
	const storage = new MemoryLockStorage();
	const locks = new SessionLocks(storage);
	const registrations: Promise<void>[] = [];
	const replies: Promise<void>[] = [];
	const makeClient = (windowId: number) => {
		const client = new SidepanelPort(() => {
			const connection = new FakeConnection();
			registrations.push(locks.connect(connection, windowId));
			connection.onSend = (message) => {
				replies.push(locks.handleRequest(connection, message).then((response) => connection.reply(response)));
			};
			return connection;
		});
		client.initialize(windowId);
		return client;
	};
	const a = makeClient(10);
	const b = makeClient(20);
	await Promise.all(registrations);
	const requests = [
		a.sendMessage({ type: "acquireLock", sessionId: "latest" }),
		b.sendMessage({ type: "acquireLock", sessionId: "latest" }),
	];
	await Promise.all(replies);
	const responses = await Promise.all(requests);
	equal(
		responses.map((response) => response.success),
		[true, false],
		"one sidebar loads; the other must create a new session",
	);
	equal(storage.state.locks, { latest: 10 }, "one persisted owner");
});

test("a send failure reconnects without leaving a pending request timer", async () => {
	const { client, connections } = clientFixture();
	connections[0].onSend = () => {
		throw new Error("post failed");
	};
	const request = client.sendMessage({ type: "getLockedSessions" });
	await Promise.resolve();
	const current = connections[1];
	assert(current, "send failure creates a new connection");
	current.reply({ type: "lockedSessions", requestId: current.sent[0].requestId, locks: {} });
	equal((await request).locks, {}, "retry resolves");
});
