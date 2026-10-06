export type RateLimitOperation = "DeleteTweet" | "DeleteRetweet";

export type RateLimitSnapshot = {
	limit: number | undefined;
	remaining: number;
	resetAt: number;
	observedAt: number;
};

export type RateLimitResponse = {
	url: () => string;
	headers: () => Record<string, string>;
};

export type RateLimitHeaderSource = {
	on: (event: "response", listener: (response: RateLimitResponse) => void) => unknown;
	off: (event: "response", listener: (response: RateLimitResponse) => void) => unknown;
};

export type RateLimitHeaderStore = {
	get: (operation: RateLimitOperation) => RateLimitSnapshot | undefined;
	dispose: () => void;
};

const operationFromUrl = (url: string): RateLimitOperation | undefined => {
	const match = /\/graphql\/[^/?#]+\/(DeleteTweet|DeleteRetweet)(?:[?#]|$)/.exec(url);
	return match?.[1] as RateLimitOperation | undefined;
};

const readNumber = (value: string | undefined) => {
	if (value === undefined) return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) ? parsed : undefined;
};

export const parseRateLimitHeaders = (
	headers: Record<string, string>,
	observedAt: number,
): RateLimitSnapshot | undefined => {
	const normalized = Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [key.trim().toLowerCase(), value]),
	);
	const remaining = readNumber(normalized["x-rate-limit-remaining"]);
	const reset = readNumber(normalized["x-rate-limit-reset"]);
	if (remaining === undefined || reset === undefined) return undefined;
	if (remaining < 0 || reset <= 0) return undefined;
	return {
		limit: readNumber(normalized["x-rate-limit-limit"]),
		remaining,
		resetAt: reset * 1_000,
		observedAt,
	};
};

export const createRateLimitHeaderStore = (page: RateLimitHeaderSource): RateLimitHeaderStore => {
	const snapshots = new Map<RateLimitOperation, RateLimitSnapshot>();
	const onResponse = (response: RateLimitResponse) => {
		const operation = operationFromUrl(response.url());
		if (operation === undefined) return;
		const snapshot = parseRateLimitHeaders(response.headers(), Date.now());
		if (snapshot === undefined) return;
		snapshots.set(operation, snapshot);
	};
	page.on("response", onResponse);
	return {
		get: (operation) => snapshots.get(operation),
		dispose: () => page.off("response", onResponse),
	};
};
