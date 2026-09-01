type JsonRecord = Record<string, unknown>;

type ApiErrorCategory = "absent" | "fatal" | "permanent" | "retryable";

type ApiErrorDetail = {
	code?: number | string;
	message: string;
};

export type ViewerIdentity = {
	id: string;
	username?: string;
};

export type TweetLookup = {
	exists: boolean;
	repostSourceId?: string;
	repostedByViewer?: boolean;
};

export class ApiResponseError extends Error {
	readonly category: ApiErrorCategory;

	constructor(operation: string, details: ApiErrorDetail[]) {
		const summary = details
			.map((detail) => `${detail.code === undefined ? "" : `[${detail.code}] `}${detail.message}`)
			.join("; ");
		super(`${operation}: ${summary}`);
		this.name = "ApiResponseError";
		this.category = classifyDetails(details);
	}
}

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const getPath = (value: unknown, keys: string[]): unknown => {
	let current = value;
	for (const key of keys) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return current;
};

const stringValue = (value: unknown) => (typeof value === "string" ? value : undefined);

const booleanValue = (value: unknown) => (typeof value === "boolean" ? value : undefined);

const errorDetail = (value: unknown): ApiErrorDetail | undefined => {
	if (!isRecord(value)) return undefined;
	const message = stringValue(value.message) ?? stringValue(value.detail) ?? stringValue(value.title);
	if (!message) return undefined;
	const code = typeof value.code === "number" || typeof value.code === "string" ? value.code : undefined;
	return { code, message };
};

const collectErrors = (value: unknown, depth = 0): ApiErrorDetail[] => {
	if (depth > 5 || !isRecord(value)) return [];
	const result: ApiErrorDetail[] = [];
	for (const [key, child] of Object.entries(value)) {
		if (key === "errors" && Array.isArray(child)) {
			result.push(...child.map(errorDetail).filter((detail): detail is ApiErrorDetail => detail !== undefined));
			continue;
		}
		if (isRecord(child)) result.push(...collectErrors(child, depth + 1));
	}
	return result;
};

const classifyDetails = (details: ApiErrorDetail[]): ApiErrorCategory => {
	const codes = new Set(details.map((detail) => String(detail.code)));
	const message = details.map((detail) => detail.message).join(" ");
	if (codes.has("34") || codes.has("144") || /not found|does not exist|no status found/i.test(message)) {
		return "absent";
	}
	if (codes.has("88") || /rate limit|too many requests|temporar|try again|over capacity|timeout/i.test(message)) {
		return "retryable";
	}
	if (
		["32", "89", "220", "326"].some((code) => codes.has(code)) ||
		/authenticat|not authorized|account.*(locked|suspended)/i.test(message)
	) {
		return "fatal";
	}
	return "permanent";
};

export const assertNoApiErrors = (response: unknown, operation: string) => {
	const errors = collectErrors(response);
	if (errors.length > 0) throw new ApiResponseError(operation, errors);
};

const unwrapTweet = (value: unknown): JsonRecord | undefined => {
	if (!isRecord(value)) return undefined;
	if (isRecord(value.tweet)) return value.tweet;
	return value;
};

export const readTweetLookup = (response: unknown): TweetLookup => {
	const rawResult = getPath(response, ["data", "tweetResult", "result"]);
	const result = unwrapTweet(rawResult);
	if (!result) return { exists: false };

	const legacy = isRecord(result.legacy) ? result.legacy : undefined;
	const retweetedStatusResult =
		legacy && isRecord(legacy.retweeted_status_result) ? legacy.retweeted_status_result.result : undefined;
	const source = unwrapTweet(retweetedStatusResult);
	const repostSourceId = source && stringValue(source.rest_id);
	const sourceLegacy = source && isRecord(source.legacy) ? source.legacy : undefined;
	const repostedByViewer = booleanValue(sourceLegacy?.retweeted);
	return {
		exists: true,
		...(repostSourceId === undefined ? {} : { repostSourceId }),
		...(repostedByViewer === undefined ? {} : { repostedByViewer }),
	};
};

const identityFromUser = (value: unknown): ViewerIdentity | undefined => {
	const user = isRecord(value) && isRecord(value.user) ? value.user : value;
	if (!isRecord(user)) return undefined;
	const id = stringValue(user.rest_id) ?? stringValue(user.id);
	if (!id || !/^\d{1,19}$/.test(id)) return undefined;
	const legacy = isRecord(user.legacy) ? user.legacy : undefined;
	const core = isRecord(user.core) ? user.core : undefined;
	return {
		id,
		username: stringValue(core?.screen_name) ?? stringValue(legacy?.screen_name) ?? stringValue(user.username),
	};
};

export const readViewerIdentity = (response: unknown): ViewerIdentity | undefined => {
	for (const path of [
		["data", "viewer", "user_results", "result"],
		["data", "viewer", "user", "result"],
		["data"],
	] as const) {
		const identity = identityFromUser(getPath(response, [...path]));
		if (identity) return identity;
	}
	return undefined;
};

export const isLikelyRetryableError = (error: unknown) => {
	if (error instanceof ApiResponseError) return error.category === "retryable";
	const message = error instanceof Error ? error.message : String(error);
	return /429|5\d\d|rate limit|timeout|timed out|ECONN|network|socket|temporar|target.*closed/i.test(message);
};

export const isFatalApiError = (error: unknown) => error instanceof ApiResponseError && error.category === "fatal";

export const isAbsentApiError = (error: unknown) => error instanceof ApiResponseError && error.category === "absent";
