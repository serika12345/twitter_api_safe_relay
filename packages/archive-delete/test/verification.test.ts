import { describe, expect, test } from "vitest";
import { runVerificationPasses } from "../src/verification.ts";

describe("runVerificationPasses", () => {
	test("waits only between passes and stops when delayed absence is confirmed", async () => {
		let remaining = 2;
		const waits: number[] = [];
		const rounds: number[] = [];
		const results = await runVerificationPasses({
			rounds: 3,
			waitMs: 60_000,
			signal: new AbortController().signal,
			remainingCount: () => remaining,
			verify: async (round) => {
				rounds.push(round);
				remaining = round === 1 ? 1 : 0;
				return `round-${round}`;
			},
			wait: async (milliseconds) => {
				waits.push(milliseconds);
			},
		});

		expect(results).toEqual(["round-1", "round-2"]);
		expect(rounds).toEqual([1, 2]);
		expect(waits).toEqual([60_000]);
	});
});
