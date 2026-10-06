export type TargetTab = chrome.tabs.Tab & { id: number };

/** One working window per sidebar. Selecting its tabs never focuses the window. */
export class BrowserTarget {
	private selection?: { tabId: number; windowId: number };

	get tabId(): number | undefined {
		return this.selection?.tabId;
	}

	get windowId(): number | undefined {
		return this.selection?.windowId;
	}

	async capture(windowId: number): Promise<TargetTab> {
		const [tab] = await chrome.tabs.query({ active: true, windowId });
		if (tab?.id === undefined) throw new Error("No active tab in the sidebar's window");
		this.selection = { tabId: tab.id, windowId: tab.windowId };
		return { ...tab, id: tab.id };
	}

	/** Select an explicit tab, or reselect the current target, without raising its window. */
	async select(tabId = this.tabId): Promise<TargetTab> {
		const tab = await this.get(tabId);
		await chrome.tabs.update(tab.id, { active: true });
		this.selection = { tabId: tab.id, windowId: tab.windowId };
		return { ...tab, active: true };
	}

	/** Resolve a tab inside the working window without changing selection. */
	async get(tabId = this.tabId): Promise<TargetTab> {
		const windowId = this.windowId;
		if (tabId === undefined || windowId === undefined) {
			throw new Error("No browser target selected. Start a task from the sidebar.");
		}
		const tab = await chrome.tabs.get(tabId).catch(() => {
			throw new Error(`Target tab ${tabId} is no longer available. Use navigate to select or open a tab.`);
		});
		if (tab.windowId !== windowId) {
			throw new Error(`Tab ${tabId} is outside the working window. Select or open a tab in window ${windowId}.`);
		}
		return { ...tab, id: tabId };
	}

	async show(): Promise<void> {
		const tab = await this.select();
		await chrome.windows.update(tab.windowId, { focused: true });
	}

	/** Screenshots need the selected tab, but its window can remain in the background. */
	async requireSelected(): Promise<TargetTab> {
		const tab = await this.get();
		if (!tab.active) throw new Error(`Select target tab ${tab.id} before taking a screenshot.`);
		return tab;
	}

	/** Interactive picking needs the user to see the target and click in it. */
	async requireFocused(): Promise<TargetTab> {
		const tab = await this.get();
		if (!tab.active || !(await chrome.windows.get(tab.windowId)).focused) {
			throw new Error(`Bring target tab ${tab.id} to the foreground before selecting an element.`);
		}
		return tab;
	}
}

export const browserTarget = new BrowserTarget();
