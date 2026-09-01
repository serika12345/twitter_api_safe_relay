import { setTimeout as sleep } from "node:timers/promises";

export type RateLimiter = ReturnType<typeof createRateLimiter>;

const randomBetween = (minimum: number, maximum: number) =>
	minimum + Math.floor(Math.random() * (maximum - minimum + 1));

export const createRateLimiter = (minimumDelayMs: number, maximumDelayMs: number, signal: AbortSignal) => {
	if (minimumDelayMs < 1_001) throw new Error("最小待機時間は1001ミリ秒以上にしてください");
	if (maximumDelayMs < minimumDelayMs) throw new Error("最大待機時間は最小待機時間以上にしてください");

	let nextRequestAt = 0;
	const schedule = async <T>(request: () => Promise<T>): Promise<T> => {
		const now = Date.now();
		if (nextRequestAt > now) await sleep(nextRequestAt - now, undefined, { signal });
		nextRequestAt = Date.now() + randomBetween(minimumDelayMs, maximumDelayMs);
		return await request();
	};

	return { schedule };
};
