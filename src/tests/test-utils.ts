export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export function equal(actual: unknown, expected: unknown, message: string) {
	assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`);
}

export type BrowserTest = { name: string; run: () => Promise<void> };
