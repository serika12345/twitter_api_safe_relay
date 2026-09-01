import { setTimeout as sleep } from "node:timers/promises";
import type { TwitterApiProfileClient } from "twitter-api-safe-request";
import type { DeleteTweetCooldown, MutationCooldown } from "./adaptive-cooldown.ts";
import {
	ApiResponseError,
	assertNoApiErrors,
	isAbsentApiError,
	isFatalApiError,
	readTweetLookup,
} from "./api-result.ts";
import type { ArchivePost } from "./archive.ts";
import { executeOperation, type OperationCatalog, type OperationName } from "./catalog.ts";
import {
	appendProgress,
	isCompleted,
	type ProgressEvent,
	type ProgressStatus,
	REPOST_WRAPPER_ABSENT_DETAIL,
	sanitizeDetail,
} from "./progress.ts";
import type { RateLimiter } from "./rate-limiter.ts";

export type ArchiveDeleteRunnerOptions = {
	accountId: string;
	client: TwitterApiProfileClient;
	catalog: OperationCatalog;
	rateLimiter: RateLimiter;
	progressFile: string;
	progress: Map<string, ProgressEvent>;
	maximumAttempts: number;
	requestTimeoutMs: number;
	recoverAfterTimeout: () => Promise<void>;
	retryDelayMs?: (attempt: number) => number;
	isPostCompleted?: (event: ProgressEvent | undefined) => boolean;
	deleteTweetCooldown?: DeleteTweetCooldown;
	mutationCooldown?: MutationCooldown;
	signal: AbortSignal;
	onProgress?: (event: RunnerProgress) => void;
};

export type RunnerProgress = {
	phase: "delete" | "verify";
	completed: number;
	total: number;
	postId: string;
	status: ProgressStatus;
};

export type RunnerSummary = {
	deleted: number;
	unretweeted: number;
	alreadyAbsent: number;
	failed: number;
	verifiedAbsent: number;
	verificationFailed: number;
	skipped: number;
	stopped: boolean;
};

class RetryExhaustedError extends Error {
	constructor(operation: string, cause: unknown) {
		super(`${operation} の一時エラーが規定回数を超えました`, { cause });
		this.name = "RetryExhaustedError";
	}
}

class RequestTimeoutError extends Error {
	constructor(operation: string, timeoutMs: number) {
		super(`${operation} が${timeoutMs}ミリ秒以内に完了しませんでした`);
		this.name = "RequestTimeoutError";
	}
}

const backoffDelay = (attempt: number) => Math.min(300_000, 5_000 * 3 ** (attempt - 1)) + Math.random() * 1_000;

const emptySummary = (): RunnerSummary => ({
	deleted: 0,
	unretweeted: 0,
	alreadyAbsent: 0,
	failed: 0,
	verifiedAbsent: 0,
	verificationFailed: 0,
	skipped: 0,
	stopped: false,
});

const addStatusToSummary = (summary: RunnerSummary, status: ProgressStatus) => {
	switch (status) {
		case "deleted":
			summary.deleted += 1;
			break;
		case "unretweeted":
			summary.unretweeted += 1;
			break;
		case "already_absent":
			summary.alreadyAbsent += 1;
			break;
		case "failed":
			summary.failed += 1;
			break;
		case "verified_absent":
			summary.verifiedAbsent += 1;
			break;
		case "verification_failed":
			summary.verificationFailed += 1;
			break;
	}
};

export const createArchiveDeleteRunner = (options: ArchiveDeleteRunnerOptions) => {
	const executeWithTimeout = async (operation: OperationName, variables: Record<string, unknown>) => {
		let timeout: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(
				() => reject(new RequestTimeoutError(operation, options.requestTimeoutMs)),
				options.requestTimeoutMs,
			);
		});
		try {
			return await Promise.race([
				executeOperation(options.client, options.catalog, operation, variables),
				timeoutPromise,
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	};

	const call = async (operation: OperationName, variables: Record<string, unknown>) => {
		let lastError: unknown;
		const cooldowns =
			operation === "DeleteTweet"
				? [options.mutationCooldown, options.deleteTweetCooldown].filter(
						(cooldown): cooldown is DeleteTweetCooldown => cooldown !== undefined,
					)
				: operation === "DeleteRetweet" && options.mutationCooldown
					? [options.mutationCooldown]
					: [];
		for (let attempt = 1; attempt <= options.maximumAttempts; attempt += 1) {
			if (options.signal.aborted) throw options.signal.reason;
			try {
				for (const cooldown of cooldowns) await cooldown.beforeAttempt();
				const response = await options.rateLimiter.schedule(async () => await executeWithTimeout(operation, variables));
				assertNoApiErrors(response, operation);
				for (const cooldown of cooldowns) await cooldown.recordSuccess();
				return { response, attempts: attempt };
			} catch (error) {
				lastError = error;
				if (options.signal.aborted || isAbsentApiError(error) || isFatalApiError(error)) throw error;
				const requestTimedOut = error instanceof RequestTimeoutError;
				if (requestTimedOut) {
					try {
						await options.recoverAfterTimeout();
					} catch (recoveryError) {
						throw new RetryExhaustedError(`${operation} 後のページ復旧`, recoveryError);
					}
				}
				if (attempt === options.maximumAttempts) break;
				await sleep((options.retryDelayMs ?? backoffDelay)(attempt), undefined, { signal: options.signal });
			}
		}
		for (const cooldown of cooldowns) await cooldown.recordFailure();
		throw new RetryExhaustedError(operation, lastError);
	};

	const record = async (
		post: ArchivePost,
		status: ProgressStatus,
		attempts: number,
		detail?: string,
	): Promise<ProgressEvent> => {
		const event: ProgressEvent = {
			version: 1,
			at: new Date().toISOString(),
			accountId: options.accountId,
			postId: post.id,
			kind: post.kind,
			status,
			attempts,
			...(detail === undefined ? {} : { detail }),
		};
		await appendProgress(options.progressFile, event);
		options.progress.set(post.id, event);
		return event;
	};

	const deleteOne = async (post: ArchivePost) => {
		let attempts = 0;
		try {
			let repostSourceId: string | undefined;
			let repostedByViewer: boolean | undefined;
			if (post.kind === "repost" || post.kind === "unknown") {
				const lookup = await call("TweetResultByRestId", {
					tweetId: post.id,
					withCommunity: false,
					includePromotedContent: false,
					withVoice: false,
				});
				attempts += lookup.attempts;
				const result = readTweetLookup(lookup.response);
				if (!result.exists) {
					return await record(
						post,
						"already_absent",
						attempts,
						post.kind === "repost" ? REPOST_WRAPPER_ABSENT_DETAIL : undefined,
					);
				}
				repostSourceId = result.repostSourceId;
				repostedByViewer = result.repostedByViewer;
				if (post.kind === "repost" && !repostSourceId) {
					throw new Error("リポスト元のポストIDを取得できません");
				}
			}

			if (post.kind === "repost" && repostSourceId && repostedByViewer !== false) {
				try {
					const unretweet = await call("DeleteRetweet", { source_tweet_id: repostSourceId });
					attempts += unretweet.attempts;
				} catch (error) {
					if (!isAbsentApiError(error)) throw error;
					attempts += 1;
				}
			}

			const deletion = await call("DeleteTweet", { tweet_id: post.id });
			attempts += deletion.attempts;
			return await record(post, "deleted", attempts);
		} catch (error) {
			if (isAbsentApiError(error)) {
				return await record(
					post,
					"already_absent",
					Math.max(attempts, 1),
					post.kind === "repost" ? REPOST_WRAPPER_ABSENT_DETAIL : undefined,
				);
			}
			const event = await record(post, "failed", Math.max(attempts, 1), sanitizeDetail(error));
			if (isFatalApiError(error)) throw error;
			return event;
		}
	};

	const deletePosts = async (posts: ArchivePost[]) => {
		const summary = emptySummary();
		const pending = posts.filter((post) => {
			if (!(options.isPostCompleted ?? isCompleted)(options.progress.get(post.id))) return true;
			summary.skipped += 1;
			return false;
		});

		for (const [index, post] of pending.entries()) {
			if (options.signal.aborted) {
				summary.stopped = true;
				break;
			}
			try {
				const event = await deleteOne(post);
				addStatusToSummary(summary, event.status);
				options.onProgress?.({
					phase: "delete",
					completed: index + 1,
					total: pending.length,
					postId: post.id,
					status: event.status,
				});
			} catch (error) {
				summary.failed += 1;
				throw Object.assign(error instanceof Error ? error : new Error(String(error)), { summary });
			}
		}
		return summary;
	};

	const verifyPosts = async (posts: ArchivePost[]) => {
		const summary = emptySummary();
		const pending = posts.filter((post) => {
			if (!(options.isPostCompleted ?? isCompleted)(options.progress.get(post.id))) return true;
			summary.skipped += 1;
			return false;
		});
		for (const [index, post] of pending.entries()) {
			if (options.signal.aborted) {
				summary.stopped = true;
				break;
			}

			let event: ProgressEvent;
			try {
				const lookup = await call("TweetResultByRestId", {
					tweetId: post.id,
					withCommunity: false,
					includePromotedContent: false,
					withVoice: false,
				});
				const result = readTweetLookup(lookup.response);
				event = await record(
					post,
					result.exists ? "verification_failed" : "verified_absent",
					lookup.attempts,
					result.exists
						? post.kind === "repost"
							? "削除後もリポストの外側IDを取得できます"
							: "削除後もポストを取得できます"
						: post.kind === "repost"
							? REPOST_WRAPPER_ABSENT_DETAIL
							: undefined,
				);
			} catch (error) {
				if (isAbsentApiError(error)) {
					event = await record(
						post,
						"verified_absent",
						1,
						post.kind === "repost" ? REPOST_WRAPPER_ABSENT_DETAIL : undefined,
					);
				} else {
					event = await record(post, "verification_failed", 1, sanitizeDetail(error));
					if (isFatalApiError(error)) {
						addStatusToSummary(summary, event.status);
						throw Object.assign(error instanceof Error ? error : new Error(String(error)), { summary });
					}
				}
			}

			addStatusToSummary(summary, event.status);
			options.onProgress?.({
				phase: "verify",
				completed: index + 1,
				total: pending.length,
				postId: post.id,
				status: event.status,
			});
		}
		return summary;
	};

	return { deletePosts, verifyPosts };
};

export const isApiResponseError = (error: unknown): error is ApiResponseError => error instanceof ApiResponseError;
