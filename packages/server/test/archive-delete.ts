import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TwitterApiProfileClient } from "twitter-api-safe-request";
import { afterEach, describe, expect, test } from "vitest";
import { createDeleteTweetCooldown, createMutationCooldown } from "../src/archive-delete/adaptive-cooldown.ts";
import {
	ApiResponseError,
	assertNoApiErrors,
	readTweetLookup,
	readViewerIdentity,
} from "../src/archive-delete/api-result.ts";
import { type ArchivePost, loadArchive } from "../src/archive-delete/archive.ts";
import type { OperationCatalog } from "../src/archive-delete/catalog.ts";
import {
	findRepeatedUnretweetPostIds,
	isConfirmedAbsent,
	REPOST_WRAPPER_ABSENT_DETAIL,
	readProgress,
} from "../src/archive-delete/progress.ts";
import type { RateLimiter } from "../src/archive-delete/rate-limiter.ts";
import { createArchiveDeleteRunner } from "../src/archive-delete/runner.ts";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "archive-delete-test-"));
	temporaryDirectories.push(directory);
	return directory;
};

const writeArchiveFile = async (directory: string, name: string, variable: string, value: unknown) => {
	const dataDirectory = path.join(directory, "data");
	await fs.mkdir(dataDirectory, { recursive: true });
	await fs.writeFile(path.join(dataDirectory, name), `window.YTD.${variable}.part0 = ${JSON.stringify(value)}`);
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(async (directory) => await fs.rm(directory, { recursive: true })),
	);
});

describe("loadArchive", () => {
	test("loads, deduplicates, sorts, classifies, and excludes deleted posts", async () => {
		const directory = await makeTemporaryDirectory();
		await writeArchiveFile(directory, "account.js", "account", [
			{ account: { accountId: "123", username: "archive_user" } },
		]);
		await writeArchiveFile(directory, "tweets.js", "tweets", [
			{ tweet: { id_str: "10", created_at: "2024-01-01T00:00:00Z", full_text: "post" } },
			{ tweet: { id_str: "11", created_at: "2024-02-01T00:00:00Z", full_text: "RT @user: repost" } },
			{ tweet: { id_str: "12", created_at: "2024-03-01T00:00:00Z", full_text: "deleted" } },
		]);
		await writeArchiveFile(directory, "tweet-headers.js", "tweet_headers", [
			{ tweet: { tweet_id: "10", created_at: "2024-01-01T00:00:00Z" } },
			{ tweet: { tweet_id: "13", created_at: "2024-04-01T00:00:00Z" } },
		]);
		await writeArchiveFile(directory, "deleted-tweets.js", "deleted_tweets", [
			{ tweet: { id_str: "12", full_text: "deleted" } },
		]);

		const archive = await loadArchive(directory);

		expect(archive.account).toEqual({ id: "123", username: "archive_user" });
		expect(archive.posts).toEqual([
			{ id: "13", createdAt: "2024-04-01T00:00:00Z", kind: "unknown" },
			{ id: "11", createdAt: "2024-02-01T00:00:00Z", kind: "repost" },
			{ id: "10", createdAt: "2024-01-01T00:00:00Z", kind: "post" },
		]);
		expect(archive.deletedPostCount).toBe(1);
	});
});

describe("API response readers", () => {
	test("reads the signed-in viewer identity", () => {
		expect(
			readViewerIdentity({
				data: { viewer: { user_results: { result: { rest_id: "123", legacy: { screen_name: "archive_user" } } } } },
			}),
		).toEqual({ id: "123", username: "archive_user" });
	});

	test("reads the source post from a repost wrapper", () => {
		expect(
			readTweetLookup({
				data: {
					tweetResult: {
						result: {
							legacy: {
								retweeted_status_result: {
									result: { rest_id: "999", legacy: { retweeted: false } },
								},
							},
						},
					},
				},
			}),
		).toEqual({ exists: true, repostSourceId: "999", repostedByViewer: false });
	});

	test("classifies missing posts separately from temporary failures", () => {
		expect(() => assertNoApiErrors({ errors: [{ code: 144, message: "No status found" }] }, "lookup")).toThrow(
			ApiResponseError,
		);
		try {
			assertNoApiErrors({ errors: [{ code: 88, message: "Rate limit exceeded" }] }, "lookup");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiResponseError);
			expect((error as ApiResponseError).category).toBe("retryable");
		}
	});
});

describe("archive deletion runner", () => {
	test("removes the repost relation and deletes the outer repost ID, then resumes", async () => {
		const directory = await makeTemporaryDirectory();
		const progressFile = path.join(directory, "progress.ndjson");
		const requests: unknown[] = [];
		const client = {
			dispatch: async (request: unknown) => {
				requests.push(request);
				if (
					typeof request === "object" &&
					request !== null &&
					"path" in request &&
					request.path === "/graphql/lookup/TweetResultByRestId"
				) {
					return {
						data: {
							tweetResult: {
								result: {
									legacy: {
										retweeted_status_result: {
											result: { rest_id: "999", legacy: { retweeted: true } },
										},
									},
								},
							},
						},
					};
				}
				return { data: {} };
			},
		} as unknown as TwitterApiProfileClient;
		const capture = (operation: string, method: "GET" | "POST") => ({
			method,
			path: `/graphql/${operation.toLowerCase()}/${operation}`,
			headers: {},
			...(method === "GET" ? { params: { variables: "{}" } } : { data: { queryId: operation.toLowerCase() } }),
		});
		const catalog: OperationCatalog = {
			DeleteRetweet: capture("DeleteRetweet", "POST"),
			DeleteTweet: capture("DeleteTweet", "POST"),
			TweetResultByRestId: { ...capture("TweetResultByRestId", "GET"), path: "/graphql/lookup/TweetResultByRestId" },
			Viewer: capture("Viewer", "GET"),
		};
		const rateLimiter = {
			schedule: async <T>(request: () => Promise<T>) => await request(),
		} as RateLimiter;
		const posts: ArchivePost[] = [
			{ id: "10", kind: "post" },
			{ id: "11", kind: "repost" },
		];
		const progress = new Map();
		const runner = createArchiveDeleteRunner({
			accountId: "123",
			client,
			catalog,
			rateLimiter,
			progressFile,
			progress,
			maximumAttempts: 2,
			requestTimeoutMs: 1_000,
			recoverAfterTimeout: async () => {},
			signal: new AbortController().signal,
		});

		const first = await runner.deletePosts(posts);
		expect(first).toMatchObject({ deleted: 2, unretweeted: 0, failed: 0, skipped: 0 });
		expect(requests).toHaveLength(4);
		expect(requests[0]).toMatchObject({
			path: "/graphql/deletetweet/DeleteTweet",
			data: { variables: { tweet_id: "10" } },
		});
		expect(requests[2]).toMatchObject({
			path: "/graphql/deleteretweet/DeleteRetweet",
			data: { variables: { source_tweet_id: "999" } },
		});
		expect(requests[3]).toMatchObject({
			path: "/graphql/deletetweet/DeleteTweet",
			data: { variables: { tweet_id: "11" } },
		});

		const saved = await readProgress(progressFile, "123");
		const resumed = createArchiveDeleteRunner({
			accountId: "123",
			client,
			catalog,
			rateLimiter,
			progressFile,
			progress: saved,
			maximumAttempts: 2,
			requestTimeoutMs: 1_000,
			recoverAfterTimeout: async () => {},
			signal: new AbortController().signal,
		});
		expect(await resumed.deletePosts(posts)).toMatchObject({ skipped: 2 });
		expect(requests).toHaveLength(4);
	});

	test("deletes an orphaned repost wrapper without repeating DeleteRetweet", async () => {
		const directory = await makeTemporaryDirectory();
		const progressFile = path.join(directory, "progress.ndjson");
		const requests: Array<Record<string, unknown>> = [];
		const client = {
			dispatch: async (request: Record<string, unknown>) => {
				requests.push(request);
				if (request.path === "/graphql/lookup/TweetResultByRestId") {
					return {
						data: {
							tweetResult: {
								result: {
									legacy: {
										retweeted_status_result: {
											result: { rest_id: "999", legacy: { retweeted: false } },
										},
									},
								},
							},
						},
					};
				}
				return { data: {} };
			},
		} as unknown as TwitterApiProfileClient;
		const getCapture = {
			method: "GET" as const,
			path: "/graphql/lookup/TweetResultByRestId",
			headers: {},
			params: { variables: "{}" },
		};
		const runner = createArchiveDeleteRunner({
			accountId: "123",
			client,
			catalog: {
				DeleteRetweet: { method: "POST", path: "/graphql/unretweet/DeleteRetweet", headers: {}, data: {} },
				DeleteTweet: { method: "POST", path: "/graphql/delete/DeleteTweet", headers: {}, data: {} },
				TweetResultByRestId: getCapture,
				Viewer: { ...getCapture, path: "/graphql/viewer/Viewer" },
			},
			rateLimiter: { schedule: async <T>(request: () => Promise<T>) => await request() } as RateLimiter,
			progressFile,
			progress: new Map(),
			maximumAttempts: 2,
			requestTimeoutMs: 1_000,
			recoverAfterTimeout: async () => {},
			signal: new AbortController().signal,
		});

		expect(await runner.deletePosts([{ id: "11", kind: "repost" }])).toMatchObject({ deleted: 1 });
		expect(requests.map((request) => request.path)).toEqual([
			"/graphql/lookup/TweetResultByRestId",
			"/graphql/delete/DeleteTweet",
		]);
		expect(requests[1]).toMatchObject({ data: { variables: { tweet_id: "11" } } });
	});

	test("skips a post after one failed retry and continues with the next post", async () => {
		const directory = await makeTemporaryDirectory();
		const progressFile = path.join(directory, "progress.ndjson");
		let requestCount = 0;
		const client = {
			dispatch: async () => {
				requestCount += 1;
				if (requestCount <= 2) throw new Error("request failed");
				return { data: {} };
			},
		} as unknown as TwitterApiProfileClient;
		const postCapture = {
			method: "POST" as const,
			path: "/graphql/delete/DeleteTweet",
			headers: {},
			data: { queryId: "delete" },
		};
		const catalog: OperationCatalog = {
			DeleteRetweet: { ...postCapture, path: "/graphql/unretweet/DeleteRetweet" },
			DeleteTweet: postCapture,
			TweetResultByRestId: {
				method: "GET",
				path: "/graphql/lookup/TweetResultByRestId",
				headers: {},
				params: { variables: "{}" },
			},
			Viewer: {
				method: "GET",
				path: "/graphql/viewer/Viewer",
				headers: {},
				params: { variables: "{}" },
			},
		};
		const runner = createArchiveDeleteRunner({
			accountId: "123",
			client,
			catalog,
			rateLimiter: { schedule: async <T>(request: () => Promise<T>) => await request() } as RateLimiter,
			progressFile,
			progress: new Map(),
			maximumAttempts: 2,
			requestTimeoutMs: 1_000,
			recoverAfterTimeout: async () => {},
			retryDelayMs: () => 0,
			signal: new AbortController().signal,
		});

		const result = await runner.deletePosts([
			{ id: "10", kind: "post" },
			{ id: "11", kind: "post" },
		]);

		expect(result).toMatchObject({ failed: 1, deleted: 1, stopped: false });
		expect(requestCount).toBe(3);
		const progress = await readProgress(progressFile, "123");
		expect(progress.get("10")?.status).toBe("failed");
		expect(progress.get("11")?.status).toBe("deleted");
	});

	test("does not verify posts whose absence is already confirmed", async () => {
		const directory = await makeTemporaryDirectory();
		const progressFile = path.join(directory, "progress.ndjson");
		let requestCount = 0;
		const client = {
			dispatch: async () => {
				requestCount += 1;
				return { data: { tweetResult: {} } };
			},
		} as unknown as TwitterApiProfileClient;
		const getCapture = {
			method: "GET" as const,
			path: "/graphql/lookup/TweetResultByRestId",
			headers: {},
			params: { variables: "{}" },
		};
		const catalog: OperationCatalog = {
			DeleteRetweet: { method: "POST", path: "/graphql/unretweet/DeleteRetweet", headers: {}, data: {} },
			DeleteTweet: { method: "POST", path: "/graphql/delete/DeleteTweet", headers: {}, data: {} },
			TweetResultByRestId: getCapture,
			Viewer: { ...getCapture, path: "/graphql/viewer/Viewer" },
		};
		const progress = new Map([
			[
				"10",
				{
					version: 1 as const,
					at: new Date().toISOString(),
					accountId: "123",
					postId: "10",
					kind: "post" as const,
					status: "verified_absent" as const,
					attempts: 1,
				},
			],
		]);
		const runner = createArchiveDeleteRunner({
			accountId: "123",
			client,
			catalog,
			rateLimiter: { schedule: async <T>(request: () => Promise<T>) => await request() } as RateLimiter,
			progressFile,
			progress,
			maximumAttempts: 2,
			requestTimeoutMs: 1_000,
			recoverAfterTimeout: async () => {},
			signal: new AbortController().signal,
		});

		const result = await runner.verifyPosts([
			{ id: "10", kind: "post" },
			{ id: "11", kind: "post" },
		]);

		expect(result).toMatchObject({ skipped: 1, verifiedAbsent: 1 });
		expect(requestCount).toBe(1);
	});

	test("does not treat an inactive repost relation as an absent outer repost ID", async () => {
		const directory = await makeTemporaryDirectory();
		const progressFile = path.join(directory, "progress.ndjson");
		const client = {
			dispatch: async () => ({
				data: {
					tweetResult: {
						result: {
							legacy: {
								retweeted_status_result: {
									result: { rest_id: "999", legacy: { retweeted: false } },
								},
							},
						},
					},
				},
			}),
		} as unknown as TwitterApiProfileClient;
		const getCapture = {
			method: "GET" as const,
			path: "/graphql/lookup/TweetResultByRestId",
			headers: {},
			params: { variables: "{}" },
		};
		const runner = createArchiveDeleteRunner({
			accountId: "123",
			client,
			catalog: {
				DeleteRetweet: { method: "POST", path: "/graphql/unretweet/DeleteRetweet", headers: {}, data: {} },
				DeleteTweet: { method: "POST", path: "/graphql/delete/DeleteTweet", headers: {}, data: {} },
				TweetResultByRestId: getCapture,
				Viewer: { ...getCapture, path: "/graphql/viewer/Viewer" },
			},
			rateLimiter: { schedule: async <T>(request: () => Promise<T>) => await request() } as RateLimiter,
			progressFile,
			progress: new Map(),
			maximumAttempts: 2,
			requestTimeoutMs: 1_000,
			recoverAfterTimeout: async () => {},
			signal: new AbortController().signal,
		});

		const result = await runner.verifyPosts([{ id: "11", kind: "repost" }]);

		expect(result).toMatchObject({ verifiedAbsent: 0, verificationFailed: 1 });
		expect((await readProgress(progressFile, "123")).get("11")?.status).toBe("verification_failed");
	});
});

describe("legacy repost progress repair", () => {
	test("requires wrapper absence again after repeated unretweet completion", () => {
		const events = [
			{
				version: 1 as const,
				at: "2026-01-01T00:00:00.000Z",
				accountId: "123",
				postId: "11",
				kind: "repost" as const,
				status: "unretweeted" as const,
				attempts: 1,
			},
			{
				version: 1 as const,
				at: "2026-01-01T01:00:00.000Z",
				accountId: "123",
				postId: "11",
				kind: "repost" as const,
				status: "unretweeted" as const,
				attempts: 1,
			},
		];
		const candidates = findRepeatedUnretweetPostIds(events);
		expect(candidates).toEqual(new Set(["11"]));
		expect(isConfirmedAbsent({ ...events[1], status: "verified_absent" as const }, candidates)).toBe(false);
		expect(
			isConfirmedAbsent(
				{
					...events[1],
					status: "verified_absent" as const,
					detail: REPOST_WRAPPER_ABSENT_DETAIL,
				},
				candidates,
			),
		).toBe(true);
	});
});

describe("adaptive DeleteTweet cooldown", () => {
	test("waits for the rolling 200 request window before the next deletion", async () => {
		const directory = await makeTemporaryDirectory();
		const progressFile = path.join(directory, "progress.ndjson");
		const events = Array.from({ length: 200 }, (_, index) => ({
			version: 1,
			at: new Date(index * 1_000).toISOString(),
			accountId: "123",
			postId: String(index),
			kind: "post",
			status: "deleted",
			attempts: 1,
		}));
		await fs.writeFile(progressFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
		let currentTime = 300_000;
		const waits: number[] = [];
		const cooldown = await createDeleteTweetCooldown({
			accountId: "123",
			progressFile,
			signal: new AbortController().signal,
			now: () => currentTime,
			random: () => 0,
			wait: async (milliseconds) => {
				waits.push(milliseconds);
				currentTime += milliseconds;
			},
		});

		await cooldown.beforeAttempt();

		expect(waits).toEqual([615_000]);
	});

	test("shares a rolling one-hour allowance between deletes and unretweets", async () => {
		const directory = await makeTemporaryDirectory();
		const progressFile = path.join(directory, "progress.ndjson");
		const events = Array.from({ length: 450 }, (_, index) => ({
			version: 1,
			at: new Date(index * 1_000).toISOString(),
			accountId: "123",
			postId: String(index),
			kind: index < 400 ? "repost" : "post",
			status: index < 400 ? "unretweeted" : "deleted",
			attempts: 1,
		}));
		await fs.writeFile(progressFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
		let currentTime = 1_200_000;
		const waits: number[] = [];
		const cooldown = await createMutationCooldown({
			accountId: "123",
			progressFile,
			signal: new AbortController().signal,
			now: () => currentTime,
			random: () => 0,
			wait: async (milliseconds) => {
				waits.push(milliseconds);
				currentTime += milliseconds;
			},
		});

		await cooldown.beforeAttempt();

		expect(waits).toEqual([2_415_000]);
	});

	test("probes with increasing waits and saves a successful recovery interval", async () => {
		const directory = await makeTemporaryDirectory();
		const progressFile = path.join(directory, "progress.ndjson");
		const stateFile = path.join(directory, "cooldown.json");
		let currentTime = 1_000_000;
		const waits: number[] = [];
		const notices: string[] = [];
		const cooldown = await createDeleteTweetCooldown({
			accountId: "123",
			progressFile,
			stateFile,
			signal: new AbortController().signal,
			now: () => currentTime,
			wait: async (milliseconds) => {
				waits.push(milliseconds);
				currentTime += milliseconds;
			},
			onNotice: ({ kind }) => notices.push(kind),
		});

		await cooldown.recordFailure();
		await cooldown.beforeAttempt();
		await cooldown.recordFailure();
		await cooldown.beforeAttempt();
		await cooldown.recordSuccess();

		expect(waits).toEqual([60_000, 120_000]);
		expect(notices).toEqual(["limit_detected", "waiting", "limit_detected", "waiting", "recovered"]);
		expect(JSON.parse(await fs.readFile(stateFile, "utf8"))).toMatchObject({ probeMs: 213_000 });
	});
});
