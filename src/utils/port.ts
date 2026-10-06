import {
	type AcquireLockMessage,
	type BackgroundToSidepanelMessage,
	type GetLockedSessionsMessage,
	type LockedSessionsMessage,
	type LockResultMessage,
	REQUEST_TO_RESPONSE_TYPE,
	type SidepanelRequest,
	type SidepanelResponse,
	type SidepanelToBackgroundMessage,
} from "./sidepanel-protocol.js";

/** The subset of a Chrome port used by the sidebar request client. */
export interface SidepanelConnection {
	postMessage(message: SidepanelRequest): void;
	disconnect(): void;
	onMessage: { addListener(listener: (message: SidepanelResponse) => void): void };
	onDisconnect: { addListener(listener: () => void): void };
}

type PendingRequest = {
	connection: SidepanelConnection;
	responseType: SidepanelResponse["type"];
	resolve: (message: SidepanelResponse) => void;
	reject: (error: Error) => void;
};

/** Owns one sidebar connection and matches concurrent replies by request ID. */
export class SidepanelPort {
	private connection?: SidepanelConnection;
	private windowId?: number;
	private readonly pending = new Map<string, PendingRequest>();

	constructor(private readonly connectPort: (name: string) => SidepanelConnection) {}

	initialize(windowId: number): void {
		this.windowId = windowId;
		this.connect();
	}

	isConnected(): boolean {
		return this.connection !== undefined;
	}

	sendMessage(message: AcquireLockMessage, timeoutMs?: number): Promise<LockResultMessage>;
	sendMessage(message: GetLockedSessionsMessage, timeoutMs?: number): Promise<LockedSessionsMessage>;
	async sendMessage(message: SidepanelToBackgroundMessage, timeoutMs = 5000): Promise<BackgroundToSidepanelMessage> {
		for (let attempt = 1; ; attempt++) {
			const connection = this.connection ?? this.connect();
			try {
				return await this.request(connection, message, timeoutMs);
			} catch (error) {
				if (attempt === 2) throw new Error(`[Port] Failed to send message after ${attempt} attempts: ${error}`);
				// A disconnected port is replaced on the next attempt. A slow reply does not
				// require closing a healthy connection or interrupting other pending requests.
				console.warn("[Port] Request failed, retrying:", error);
			}
		}
	}

	private connect(): SidepanelConnection {
		if (this.windowId === undefined) throw new Error("[Port] Window ID not initialized");
		const connection = this.connectPort(`sidepanel:${this.windowId}`);
		this.connection = connection;
		connection.onMessage.addListener((message) => {
			const request = this.pending.get(message.requestId);
			if (!request || request.connection !== connection) return;
			if (message.type !== request.responseType) {
				request.reject(new Error(`[Port] Unexpected response type: ${message.type}`));
			} else {
				request.resolve(message);
			}
		});
		connection.onDisconnect.addListener(() => {
			if (this.connection === connection) this.connection = undefined;
			for (const request of this.pending.values()) {
				if (request.connection === connection) request.reject(new Error("[Port] Connection disconnected"));
			}
		});
		return connection;
	}

	private request(
		connection: SidepanelConnection,
		message: SidepanelToBackgroundMessage,
		timeoutMs: number,
	): Promise<SidepanelResponse> {
		const requestId = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timeout);
				this.pending.delete(requestId);
			};
			const fail = (error: Error) => {
				cleanup();
				reject(error);
			};
			const timeout = setTimeout(() => fail(new Error(`[Port] Timeout waiting for ${message.type}`)), timeoutMs);
			this.pending.set(requestId, {
				connection,
				responseType: REQUEST_TO_RESPONSE_TYPE[message.type],
				resolve: (response) => {
					cleanup();
					resolve(response);
				},
				reject: fail,
			});
			try {
				connection.postMessage({ ...message, requestId });
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
				if (this.connection === connection) this.connection = undefined;
				connection.disconnect();
			}
		});
	}
}

export const sidepanelPort = new SidepanelPort((name) => chrome.runtime.connect({ name }));
