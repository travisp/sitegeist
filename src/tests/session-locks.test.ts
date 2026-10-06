import { sessionLockTests } from "./session-lock-tests.js";

const failures: unknown[] = [];
for (const { name, run } of sessionLockTests) {
	try {
		await run();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`, error);
		failures.push(error);
	}
}
if (failures.length) throw new AggregateError(failures, "Session lock tests failed");
