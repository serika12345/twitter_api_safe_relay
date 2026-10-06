import fs from "node:fs/promises";
import path from "node:path";

type JsonRecord = Record<string, unknown>;

export type ArchivePostKind = "post" | "repost" | "unknown";

export type ArchivePost = {
	id: string;
	createdAt?: string;
	kind: ArchivePostKind;
	favoriteCount?: number;
	retweetCount?: number;
	hasMedia?: boolean;
	isReply?: boolean;
};

export type ArchiveAccount = {
	id: string;
	username: string;
};

export type ArchiveContents = {
	account: ArchiveAccount;
	posts: ArchivePost[];
	deletedPostCount: number;
	duplicatePostCount: number;
};

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const readAssignedArray = async (file: string): Promise<unknown[]> => {
	const source = await fs.readFile(file, "utf8");
	const start = source.indexOf("[");
	const end = source.lastIndexOf("]");
	if (start === -1 || end < start) {
		throw new Error(`${file} にアーカイブ配列がありません`);
	}

	const parsed: unknown = JSON.parse(source.slice(start, end + 1));
	if (!Array.isArray(parsed)) {
		throw new Error(`${file} の内容が配列ではありません`);
	}
	return parsed;
};

const readOptionalAssignedArray = async (file: string): Promise<unknown[]> => {
	try {
		return await readAssignedArray(file);
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return [];
		throw error;
	}
};

const getNestedRecord = (value: unknown, key: string): JsonRecord | undefined => {
	if (!isRecord(value)) return undefined;
	const nested = value[key];
	return isRecord(nested) ? nested : undefined;
};

const getString = (value: JsonRecord, key: string): string | undefined => {
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : undefined;
};

const getCount = (value: JsonRecord, key: string): number | undefined => {
	const candidate = value[key];
	if (typeof candidate === "number") return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
	if (typeof candidate !== "string" || !/^\d+$/.test(candidate)) return undefined;
	const parsed = Number(candidate);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const hasMediaAttachment = (tweet: JsonRecord): boolean | undefined => {
	if (tweet.entities === undefined && tweet.extended_entities === undefined) return undefined;
	for (const key of ["entities", "extended_entities"]) {
		const media = getNestedRecord(tweet, key)?.media;
		if (Array.isArray(media) && media.length > 0) return true;
	}
	return false;
};

const parseTweet = (value: unknown, fallbackKind: ArchivePostKind): ArchivePost | undefined => {
	const tweet = getNestedRecord(value, "tweet");
	if (!tweet) return undefined;

	const id = getString(tweet, "id_str") ?? getString(tweet, "tweet_id");
	if (!id || !/^\d{1,19}$/.test(id)) return undefined;

	const text = getString(tweet, "full_text");
	const kind = text === undefined ? fallbackKind : text.startsWith("RT @") ? "repost" : "post";
	const enriched = text !== undefined;
	const replyId = getString(tweet, "in_reply_to_status_id_str") ?? getString(tweet, "in_reply_to_status_id");
	const hasReplyFields = "in_reply_to_status_id_str" in tweet || "in_reply_to_status_id" in tweet;
	return {
		id,
		createdAt: getString(tweet, "created_at"),
		kind,
		favoriteCount: getCount(tweet, "favorite_count"),
		retweetCount: getCount(tweet, "retweet_count"),
		hasMedia: hasMediaAttachment(tweet),
		isReply: hasReplyFields || enriched ? replyId !== undefined && replyId !== "" : undefined,
	};
};

const mergePosts = (existing: ArchivePost, incoming: ArchivePost): ArchivePost => ({
	id: existing.id,
	createdAt: existing.createdAt ?? incoming.createdAt,
	kind: existing.kind === "unknown" ? incoming.kind : existing.kind,
	favoriteCount: existing.favoriteCount ?? incoming.favoriteCount,
	retweetCount: existing.retweetCount ?? incoming.retweetCount,
	hasMedia: existing.hasMedia ?? incoming.hasMedia,
	isReply: existing.isReply ?? incoming.isReply,
});

const loadAccount = async (dataDirectory: string): Promise<ArchiveAccount> => {
	const rows = await readAssignedArray(path.join(dataDirectory, "account.js"));
	const account = getNestedRecord(rows[0], "account");
	const id = account && getString(account, "accountId");
	const username = account && getString(account, "username");
	if (!id || !/^\d{1,19}$/.test(id) || !username) {
		throw new Error("account.js からアカウントIDとユーザー名を読み取れません");
	}
	return { id, username };
};

const deletedIdsFrom = (rows: unknown[]) =>
	new Set(rows.map((row) => parseTweet(row, "unknown")?.id).filter((id): id is string => id !== undefined));

export const loadArchive = async (archiveDirectory: string): Promise<ArchiveContents> => {
	const dataDirectory = path.join(archiveDirectory, "data");
	const account = await loadAccount(dataDirectory);
	const [tweetRows, communityTweetRows, headerRows, deletedTweetRows, deletedHeaderRows] = await Promise.all([
		readAssignedArray(path.join(dataDirectory, "tweets.js")),
		readOptionalAssignedArray(path.join(dataDirectory, "community-tweet.js")),
		readOptionalAssignedArray(path.join(dataDirectory, "tweet-headers.js")),
		readOptionalAssignedArray(path.join(dataDirectory, "deleted-tweets.js")),
		readOptionalAssignedArray(path.join(dataDirectory, "deleted-tweet-headers.js")),
	]);

	const deletedIds = new Set([...deletedIdsFrom(deletedTweetRows), ...deletedIdsFrom(deletedHeaderRows)]);
	const postsById = new Map<string, ArchivePost>();
	let duplicatePostCount = 0;

	for (const [rows, fallbackKind] of [
		[tweetRows, "unknown"],
		[communityTweetRows, "unknown"],
		[headerRows, "unknown"],
	] as const) {
		for (const row of rows) {
			const post = parseTweet(row, fallbackKind);
			if (!post || deletedIds.has(post.id)) continue;
			const existing = postsById.get(post.id);
			if (existing) {
				duplicatePostCount += 1;
				postsById.set(post.id, mergePosts(existing, post));
				continue;
			}
			postsById.set(post.id, post);
		}
	}

	const posts = [...postsById.values()].toSorted((left, right) => {
		const leftTime = left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
		const rightTime = right.createdAt ? Date.parse(right.createdAt) : Number.NaN;
		if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime;
		if (Number.isFinite(leftTime)) return -1;
		if (Number.isFinite(rightTime)) return 1;
		return right.id.localeCompare(left.id);
	});

	return {
		account,
		posts,
		deletedPostCount: deletedIds.size,
		duplicatePostCount,
	};
};
