/** Coalesce streaming checkpoints and serialize boundary saves without a growing queue. */
export class SaveScheduler {
	private timer?: ReturnType<typeof setTimeout>;
	private running?: Promise<void>;
	private dirty = false;

	constructor(
		private readonly save: () => Promise<void>,
		private readonly intervalMs = 2000,
	) {}

	checkpoint(): void {
		if (this.timer !== undefined) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, this.intervalMs);
	}

	flush(): Promise<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.dirty = true;
		this.running ??= Promise.resolve().then(async () => {
			try {
				while (this.dirty) {
					this.dirty = false;
					await this.save();
				}
			} finally {
				// Clear before settling so a boundary save arriving next starts a fresh drain.
				this.running = undefined;
			}
		});
		return this.running;
	}
}
