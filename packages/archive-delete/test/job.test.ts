import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REPOST_WRAPPER_ABSENT_DETAIL } from "twitter-api-safe-relay/archive-delete";
import { afterEach, describe, expect, test } from "vitest";
import { loadJob } from "../src/job.ts";
import { loadProfile } from "../src/profile.ts";

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "archive-delete-cli-test-"));
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

describe("loadJob", () => {
	test("reopens legacy repost completions until wrapper absence is recorded", async () => {
		const directory = await makeTemporaryDirectory();
		const archiveDirectory = path.join(directory, "archive");
		const stateFile = path.join(directory, "progress.ndjson");
		await writeArchiveFile(archiveDirectory, "account.js", "account", [
			{ account: { accountId: "123", username: "archive_user" } },
		]);
		await writeArchiveFile(archiveDirectory, "tweets.js", "tweets", [
			{ tweet: { id_str: "10", full_text: "post" } },
			{ tweet: { id_str: "11", full_text: "RT @source: repost" } },
		]);
		const base = {
			version: 1 as const,
			accountId: "123",
			postId: "11",
			kind: "repost" as const,
			attempts: 1,
		};
		const events = [
			{ ...base, at: "2026-01-01T00:00:00.000Z", status: "unretweeted" },
			{ ...base, at: "2026-01-01T00:01:00.000Z", status: "unretweeted" },
			{ ...base, at: "2026-01-01T00:02:00.000Z", status: "verified_absent" },
		];
		await fs.writeFile(stateFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

		const legacy = await loadJob({ archive: archiveDirectory, state: stateFile, mode: "all" });
		expect(legacy.counts).toMatchObject({ total: 2, completed: 0, remaining: 2, verificationFailed: 0 });

		await fs.appendFile(
			stateFile,
			`${JSON.stringify({
				...base,
				at: "2026-01-01T00:03:00.000Z",
				status: "verified_absent",
				detail: REPOST_WRAPPER_ABSENT_DETAIL,
			})}\n`,
		);
		const repaired = await loadJob({ archive: archiveDirectory, state: stateFile, mode: "reposts" });
		expect(repaired.counts).toMatchObject({ total: 1, completed: 1, remaining: 0 });
	});

	test("applies exclusion conditions and reports the excluded count", async () => {
		const directory = await makeTemporaryDirectory();
		const archiveDirectory = path.join(directory, "archive");
		await writeArchiveFile(archiveDirectory, "account.js", "account", [
			{ account: { accountId: "123", username: "archive_user" } },
		]);
		await writeArchiveFile(archiveDirectory, "tweets.js", "tweets", [
			{ tweet: { id_str: "10", full_text: "popular", favorite_count: "120", retweet_count: "1", entities: {} } },
			{
				tweet: {
					id_str: "11",
					full_text: "with media",
					favorite_count: "0",
					retweet_count: "0",
					entities: { media: [{ id_str: "m" }] },
				},
			},
			{
				tweet: {
					id_str: "12",
					full_text: "reply",
					favorite_count: "0",
					retweet_count: "0",
					entities: {},
					in_reply_to_status_id_str: "9",
				},
			},
			{ tweet: { id_str: "13", full_text: "keep", favorite_count: "0", retweet_count: "0", entities: {} } },
		]);

		const job = await loadJob({
			archive: archiveDirectory,
			mode: "all",
			excludeMinFavorites: 100,
			excludeMedia: true,
			excludeReplies: true,
		});

		expect(job.selectedPosts.map((post) => post.id)).toEqual(["13"]);
		expect(job.counts).toMatchObject({ total: 1, excluded: 3, remaining: 1 });
	});

	test("reads excluded post IDs from a file", async () => {
		const directory = await makeTemporaryDirectory();
		const archiveDirectory = path.join(directory, "archive");
		const excludeFile = path.join(directory, "exclude.txt");
		await writeArchiveFile(archiveDirectory, "account.js", "account", [
			{ account: { accountId: "123", username: "archive_user" } },
		]);
		await writeArchiveFile(archiveDirectory, "tweets.js", "tweets", [
			{ tweet: { id_str: "10", full_text: "first", favorite_count: "0", retweet_count: "0", entities: {} } },
			{ tweet: { id_str: "11", full_text: "second", favorite_count: "0", retweet_count: "0", entities: {} } },
		]);
		await fs.writeFile(excludeFile, "# pinned post\n10\n");

		const job = await loadJob({ archive: archiveDirectory, mode: "all", excludePostIdsFile: excludeFile });

		expect(job.selectedPosts.map((post) => post.id)).toEqual(["11"]);
		expect(job.counts.excluded).toBe(1);
	});

	test("reports a post ID removed by an exclusion", async () => {
		const directory = await makeTemporaryDirectory();
		const archiveDirectory = path.join(directory, "archive");
		await writeArchiveFile(archiveDirectory, "account.js", "account", [
			{ account: { accountId: "123", username: "archive_user" } },
		]);
		await writeArchiveFile(archiveDirectory, "tweets.js", "tweets", [
			{ tweet: { id_str: "10", full_text: "post", favorite_count: "0", retweet_count: "0", entities: {} } },
		]);

		await expect(
			loadJob({ archive: archiveDirectory, mode: "all", postId: "10", excludePostIds: ["10"] }),
		).rejects.toThrow("除外条件");
	});
});

describe("loadProfile", () => {
	test("resolves browser paths relative to settings and applies an executable override", async () => {
		const directory = await makeTemporaryDirectory();
		const settingsFile = path.join(directory, "settings.json");
		await fs.writeFile(
			settingsFile,
			JSON.stringify({
				profiles: [
					{
						name: "main",
						home: { url: "https://x.com/home" },
						browser: { type: "launch", userDataDir: "./browser-data", headless: false },
					},
				],
			}),
		);

		const profile = await loadProfile({
			settings: settingsFile,
			browserExecutable: "./Chromium",
		});

		expect(profile).toMatchObject({ name: "main", homeUrl: "https://x.com/home" });
		expect(profile.browser).toMatchObject({
			type: "launch",
			userDataDir: path.join(directory, "browser-data"),
			executablePath: path.resolve("./Chromium"),
		});
	});
});
