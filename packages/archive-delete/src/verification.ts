import { setTimeout as sleep } from "node:timers/promises";

export type VerificationPassOptions<Result> = {
	rounds: number;
	waitMs: number;
	signal: AbortSignal;
	remainingCount: () => number;
	verify: (round: number) => Promise<Result>;
	onWait?: (remaining: number, waitMs: number, round: number) => void;
	wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export const runVerificationPasses = async <Result>(options: VerificationPassOptions<Result>) => {
	const results: Result[] = [];
	const wait =
		options.wait ??
		(async (milliseconds: number, signal: AbortSignal) => {
			await sleep(milliseconds, undefined, { signal });
		});
	for (let round = 1; round <= options.rounds; round += 1) {
		const remaining = options.remainingCount();
		if (remaining === 0) break;
		if (round > 1) {
			options.onWait?.(remaining, options.waitMs, round);
			await wait(options.waitMs, options.signal);
		}
		results.push(await options.verify(round));
	}
	return results;
};
