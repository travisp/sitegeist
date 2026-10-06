/** Session ownership requests use the window identity of their port connection. */
export interface AcquireLockMessage {
	type: "acquireLock";
	sessionId: string;
}

export type LockResultMessage =
	| { type: "lockResult"; sessionId: string; success: true }
	| { type: "lockResult"; sessionId: string; success: false; ownerWindowId: number };

export interface GetLockedSessionsMessage {
	type: "getLockedSessions";
}

export interface LockedSessionsMessage {
	type: "lockedSessions";
	locks: Record<string, number>;
}

type MessagePair =
	| { request: AcquireLockMessage; response: LockResultMessage }
	| { request: GetLockedSessionsMessage; response: LockedSessionsMessage };

export type SidepanelToBackgroundMessage = MessagePair["request"];
export type BackgroundToSidepanelMessage = MessagePair["response"];

export type SidepanelRequest = SidepanelToBackgroundMessage & { requestId: string };
export type SidepanelResponse = BackgroundToSidepanelMessage & { requestId: string };

export const REQUEST_TO_RESPONSE_TYPE = {
	acquireLock: "lockResult",
	getLockedSessions: "lockedSessions",
} as const;
