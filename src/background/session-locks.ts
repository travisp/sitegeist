import type { SidepanelRequest, SidepanelResponse } from "../utils/sidepanel-protocol.js";

export interface SessionLockState {
	locks: Record<string, number>;
	openWindows: number[];
}

export interface SessionLockStorage {
	load(): Promise<SessionLockState>;
	save(state: SessionLockState): Promise<void>;
}

/** The background worker owns all lock decisions and serializes their persistence. */
export class SessionLocks {
	readonly ready: Promise<void>;
	private locks: Record<string, number> = {};
	private readonly openWindows = new Set<number>();
	private readonly connections = new Map<object, number>();
	private readonly changedDuringLoad = new Set<number>();
	private loading = true;
	private queue = Promise.resolve();

	constructor(private readonly storage: SessionLockStorage) {
		this.ready = storage.load().then((state) => {
			this.locks = state.locks;
			// Connection events can arrive while storage is loading. Their state is newer.
			for (const windowId of state.openWindows) {
				if (!this.changedDuringLoad.has(windowId)) this.openWindows.add(windowId);
			}
			this.loading = false;
			this.changedDuringLoad.clear();
		});
	}

	isOpen(windowId: number): boolean {
		return this.openWindows.has(windowId);
	}

	connect(connection: object, windowId: number): Promise<void> {
		this.connections.set(connection, windowId);
		this.setOpen(windowId, true);
		return this.run(() => this.persist());
	}

	disconnect(connection: object): Promise<void> {
		const windowId = this.connections.get(connection);
		if (windowId === undefined) return Promise.resolve();
		this.connections.delete(connection);
		if ([...this.connections.values()].includes(windowId)) return Promise.resolve();
		return this.closeWindow(windowId);
	}

	closeWindow(windowId: number): Promise<void> {
		for (const [connection, owner] of this.connections) {
			if (owner === windowId) this.connections.delete(connection);
		}
		this.setOpen(windowId, false);
		return this.run(async () => {
			const nextLocks = { ...this.locks };
			for (const sessionId of Object.keys(nextLocks)) {
				if (nextLocks[sessionId] === windowId) delete nextLocks[sessionId];
			}
			await this.persist(nextLocks);
			this.locks = nextLocks;
		});
	}

	handleRequest(connection: object, request: SidepanelRequest): Promise<SidepanelResponse> {
		return this.run(async () => {
			const windowId = this.connections.get(connection);
			if (windowId === undefined) throw new Error("Sidepanel connection closed before its request completed");
			const { requestId } = request;
			if (request.type === "getLockedSessions") {
				return { type: "lockedSessions", requestId, locks: { ...this.locks } };
			}

			const { sessionId } = request;
			const ownerWindowId = this.locks[sessionId];
			if (ownerWindowId !== undefined && ownerWindowId !== windowId && this.isOpen(ownerWindowId)) {
				return { type: "lockResult", requestId, sessionId, success: false, ownerWindowId };
			}
			const nextLocks = { ...this.locks, [sessionId]: windowId };
			// Commit ownership only after persistence succeeds; a failed write grants nothing.
			await this.persist(nextLocks);
			this.locks = nextLocks;
			return { type: "lockResult", requestId, sessionId, success: true };
		});
	}

	private setOpen(windowId: number, open: boolean): void {
		if (this.loading) this.changedDuringLoad.add(windowId);
		if (open) this.openWindows.add(windowId);
		else this.openWindows.delete(windowId);
	}

	private persist(locks = this.locks): Promise<void> {
		return this.storage.save({ locks: { ...locks }, openWindows: [...this.openWindows] });
	}

	private run<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(async () => {
			await this.ready;
			return operation();
		});
		// A failed operation must not strand later requests. Initialization still must succeed.
		this.queue = result.then(
			() => {},
			() => {},
		);
		return result;
	}
}
