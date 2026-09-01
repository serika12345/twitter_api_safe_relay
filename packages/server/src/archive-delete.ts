#!/usr/bin/env node

import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, InvalidArgumentError } from "commander";
import { createTwitterBrowser } from "twitter-api-safe-request";
import { createDeleteTweetCooldown, createMutationCooldown } from "./archive-delete/adaptive-cooldown.ts";
import { assertNoApiErrors, readViewerIdentity } from "./archive-delete/api-result.ts";
import { loadArchive } from "./archive-delete/archive.ts";
import { DEFAULT_CATALOG_URL, executeOperation, loadOperationCatalog } from "./archive-delete/catalog.ts";
import { findRepeatedUnretweetPostIds, isConfirmedAbsent, readProgressEvents } from "./archive-delete/progress.ts";
import { createRateLimiter } from "./archive-delete/rate-limiter.ts";
import { createArchiveDeleteRunner, type RunnerProgress, type RunnerSummary } from "./archive-delete/runner.ts";
import { connectProfileBrowser } from "./utils/browser.ts";
import { loadCliSettings } from "./utils/cli.ts";
import { catchError } from "./utils/error.ts";
import { parseSettings } from "./utils/settings.ts";

type CliOptions = {
	archive: string;
	settings: string;
	profile?: string;
	browserExecutable?: string;
	state?: string;
	catalog: string;
	execute: boolean;
	verify: boolean;
	minDelayMs: number;
	maxDelayMs: number;
	maxAttempts: number;
	requestTimeoutMs: number;
	onlyReposts: boolean;
	onlyPosts: boolean;
	verifyOnly: boolean;
	postId?: string;
};

const positiveInteger = (value: string) => {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new InvalidArgumentError("正の整数を指定してください");
	return parsed;
};

const program = new Command()
	.name("twitter-api-safe-archive-delete")
	.description("Xのデータアーカイブに記録された全ポストを、手動ログインしたブラウザーから削除します")
	.option("--archive <directory>", "Xアーカイブのディレクトリ", "./my_archive")
	.option("--settings <file>", "ブラウザー設定ファイル", "./settings.json")
	.option("--profile <name>", "使用する設定内プロファイル")
	.option("--browser-executable <file>", "launchプロファイルで使うブラウザー実行ファイル")
	.option("--state <file>", "中断復帰用の進捗ファイル")
	.option("--catalog <url-or-file>", "Web API操作カタログ", DEFAULT_CATALOG_URL)
	.option("--execute", "確認後に削除を実行する", false)
	.option("--only-reposts", "リポスト投稿だけを削除する", false)
	.option("--only-posts", "通常ポスト削除だけを実行する", false)
	.option("--post-id <id>", "指定した投稿IDだけを対象にする")
	.option("--verify-only", "変更要求を送らず、未確定分の不存在確認だけを実行する", false)
	.option("--no-verify", "削除後の全件確認を省略する")
	.option("--min-delay-ms <milliseconds>", "API要求間隔の下限", positiveInteger, 1_050)
	.option("--max-delay-ms <milliseconds>", "API要求間隔の上限", positiveInteger, 1_350)
	.option("--max-attempts <count>", "投稿ごとの最大試行回数", positiveInteger, 2)
	.option("--request-timeout-ms <milliseconds>", "API要求1回の上限時間", positiveInteger, 30_000);

const formatDuration = (milliseconds: number) => {
	const minutes = Math.ceil(milliseconds / 60_000);
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return hours === 0 ? `${remainingMinutes}分` : `${hours}時間${remainingMinutes}分`;
};

const printProgress = ({ phase, completed, total, postId, status }: RunnerProgress) => {
	const label = phase === "delete" ? "削除" : "確認";
	console.log(`[${label} ${completed}/${total}] ${postId}: ${status}`);
};

const addSummary = (left: RunnerSummary, right: RunnerSummary): RunnerSummary => ({
	deleted: left.deleted + right.deleted,
	unretweeted: left.unretweeted + right.unretweeted,
	alreadyAbsent: left.alreadyAbsent + right.alreadyAbsent,
	failed: left.failed + right.failed,
	verifiedAbsent: left.verifiedAbsent + right.verifiedAbsent,
	verificationFailed: left.verificationFailed + right.verificationFailed,
	skipped: left.skipped + right.skipped,
	stopped: left.stopped || right.stopped,
});

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

await program.parseAsync();
const options = program.opts<CliOptions>();
const abortController = new AbortController();
const onSignal = () => {
	if (!abortController.signal.aborted) {
		console.error("\n中断要求を受け付けました。現在のAPI要求と進捗保存の完了後に停止します。");
		abortController.abort(new Error("利用者が処理を中断しました"));
	}
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

let closeBrowser: (() => Promise<void>) | undefined;
let readline: ReturnType<typeof createInterface> | undefined;

try {
	if (options.minDelayMs < 1_001) throw new Error("--min-delay-ms は1001以上にしてください");
	if (options.maxDelayMs < options.minDelayMs) {
		throw new Error("--max-delay-ms は --min-delay-ms 以上にしてください");
	}
	if (options.onlyReposts && options.onlyPosts) {
		throw new Error("--only-reposts と --only-posts は同時に指定できません");
	}
	if (options.verifyOnly && !options.verify) throw new Error("--verify-only と --no-verify は同時に指定できません");
	if (options.postId !== undefined && !/^\d+$/.test(options.postId)) {
		throw new Error("--post-id は数字だけで指定してください");
	}

	const archiveDirectory = path.resolve(options.archive);
	const archive = await loadArchive(archiveDirectory);
	const modeSelectedPosts = options.onlyReposts
		? archive.posts.filter((post) => post.kind === "repost")
		: options.onlyPosts
			? archive.posts.filter((post) => post.kind !== "repost")
			: archive.posts;
	const selectedPosts = options.postId
		? modeSelectedPosts.filter((post) => post.id === options.postId)
		: modeSelectedPosts;
	if (options.postId && selectedPosts.length === 0) {
		throw new Error(`指定した投稿ID ${options.postId} は対象のアーカイブにありません`);
	}
	const progressFile = path.resolve(options.state ?? path.join(".archive-delete", `${archive.account.id}.ndjson`));
	const progressEvents = await readProgressEvents(progressFile, archive.account.id);
	const progress = new Map(progressEvents.map((event) => [event.postId, event]));
	const repostsRequiringWrapperDeletion = findRepeatedUnretweetPostIds(progressEvents);
	const hasConfirmedAbsence = (event: Parameters<typeof isConfirmedAbsent>[0]) =>
		isConfirmedAbsent(event, repostsRequiringWrapperDeletion);
	const remainingPosts = selectedPosts.filter((post) => {
		const event = progress.get(post.id);
		return !hasConfirmedAbsence(event);
	});
	const repostCount = remainingPosts.filter((post) => post.kind === "repost").length;
	const unknownCount = remainingPosts.filter((post) => post.kind === "unknown").length;
	const averageDelay = (options.minDelayMs + options.maxDelayMs) / 2;
	const estimatedCalls =
		remainingPosts.length + repostCount + unknownCount + (options.verify ? selectedPosts.length : 0);

	console.log(`アーカイブ: ${archiveDirectory}`);
	console.log(`対象アカウント: @${archive.account.username}`);
	console.log(
		options.onlyReposts
			? `対象: リポスト ${selectedPosts.length}件${options.verifyOnly ? "（確認専用）" : ""}`
			: options.onlyPosts
				? `対象: 通常ポスト ${selectedPosts.length}件${options.verifyOnly ? "（確認専用）" : ""}`
				: `対象: ${selectedPosts.length}件（リポスト ${selectedPosts.filter((post) => post.kind === "repost").length}件）`,
	);
	console.log(`完了済み: ${selectedPosts.length - remainingPosts.length}件 / 残り: ${remainingPosts.length}件`);
	console.log(`アーカイブ上で削除済み: ${archive.deletedPostCount}件`);
	console.log(`API要求間隔: ${options.minDelayMs}〜${options.maxDelayMs}ミリ秒`);
	console.log(
		`推定API要求数: ${estimatedCalls}回 / 最短所要時間の目安: ${formatDuration(estimatedCalls * averageDelay)}`,
	);
	console.log(`進捗ファイル: ${progressFile}`);

	if (!options.execute) {
		console.log("\n事前検査のみ完了しました。削除する場合は --execute を付けて再実行してください。");
		process.exitCode = 0;
	} else if (remainingPosts.length === 0 && !options.verify) {
		console.log("削除対象はすべて完了済みです。");
	} else {
		console.log("\n現行のWeb API操作カタログを読み込んでいます…");
		const catalog = await loadOperationCatalog(options.catalog);
		const settings = parseSettings(await loadCliSettings(path.resolve(options.settings)));
		const profile = (() => {
			if (options.profile) {
				const selected = settings.profiles.find((candidate) => candidate.name === options.profile);
				if (!selected) throw new Error(`設定にプロファイル ${options.profile} がありません`);
				return selected;
			}
			if (settings.profiles.length !== 1) {
				throw new Error("複数のプロファイルがあります。--profile で1つ指定してください");
			}
			const selected = settings.profiles[0];
			if (!selected) throw new Error("ブラウザープロファイルがありません");
			return selected;
		})();

		const browser = (() => {
			if (!options.browserExecutable) return profile.browser;
			if (profile.browser.type !== "launch") {
				throw new Error("--browser-executable はlaunchプロファイルでのみ使用できます");
			}
			return {
				...profile.browser,
				channel: undefined,
				executablePath: path.resolve(options.browserExecutable),
			};
		})();
		const [context, close] = await connectProfileBrowser(browser);
		closeBrowser = close;
		const page = context.pages()[0] ?? (await context.newPage());
		const client = createTwitterBrowser(page);
		await client.inject();
		await client.goto(profile.home.url);

		readline = createInterface({ input: process.stdin, output: process.stdout });
		console.log("\nブラウザーで削除対象のXアカウントへ手動ログインしてください。");
		await readline.question("ログイン完了後、この端末で Enter を押してください: ");
		await client.goto(profile.home.url);

		const rateLimiter = createRateLimiter(options.minDelayMs, options.maxDelayMs, abortController.signal);
		const viewerResponse = await rateLimiter.schedule(
			async () => await executeOperation(client, catalog, "Viewer", { withCommunitiesMemberships: true }),
		);
		assertNoApiErrors(viewerResponse, "Viewer");
		const viewer = readViewerIdentity(viewerResponse);
		if (!viewer) throw new Error("ログイン中のアカウントを確認できません");
		if (viewer.id !== archive.account.id) {
			throw new Error(
				`ログイン中のアカウント (@${viewer.username ?? "unknown"}) とアーカイブ (@${archive.account.username}) が一致しません`,
			);
		}
		console.log(`ログイン確認: @${viewer.username ?? archive.account.username}`);

		if (remainingPosts.length > 0 && !options.verifyOnly) {
			const confirmation = `DELETE ${remainingPosts.length} @${archive.account.username}`;
			const answer = await readline.question(
				`削除は元に戻せません。続行するには「${confirmation}」と入力してください: `,
			);
			if (answer !== confirmation) throw new Error("確認文字列が一致しないため、削除を開始しませんでした");
		}

		const runner = createArchiveDeleteRunner({
			accountId: archive.account.id,
			client,
			catalog,
			rateLimiter,
			progressFile,
			progress,
			maximumAttempts: options.maxAttempts,
			requestTimeoutMs: options.requestTimeoutMs,
			mutationCooldown: await createMutationCooldown({
				accountId: archive.account.id,
				progressFile,
				signal: abortController.signal,
				onNotice: ({ message }) => console.log(`[変更操作制限] ${message}`),
			}),
			deleteTweetCooldown: await createDeleteTweetCooldown({
				accountId: archive.account.id,
				progressFile,
				signal: abortController.signal,
				onNotice: ({ message }) => console.log(`[通常ポスト制限] ${message}`),
			}),
			isPostCompleted: hasConfirmedAbsence,
			recoverAfterTimeout: async () => {
				console.warn("API要求が時間切れになったため、ページを再読み込みして再試行します。");
				await client.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
				await client.waitStartup();
			},
			signal: abortController.signal,
			onProgress: printProgress,
		});
		let summary =
			remainingPosts.length > 0 && !options.verifyOnly ? await runner.deletePosts(selectedPosts) : emptySummary();
		if (options.verify && !abortController.signal.aborted) {
			console.log("\n全対象の削除確認を開始します。");
			summary = addSummary(summary, await runner.verifyPosts(selectedPosts));
		}

		console.log("\n実行結果");
		console.log(`削除: ${summary.deleted}件 / リポスト解除: ${summary.unretweeted}件`);
		console.log(`既に不存在: ${summary.alreadyAbsent}件 / 完了済みを省略: ${summary.skipped}件`);
		if (options.verify) {
			console.log(`確認済み不存在: ${summary.verifiedAbsent}件 / 確認失敗: ${summary.verificationFailed}件`);
		}
		console.log(`失敗: ${summary.failed}件`);
		if (summary.failed > 0 || summary.verificationFailed > 0 || summary.stopped) process.exitCode = 1;
	}
} catch (error) {
	if (!abortController.signal.aborted) console.error(catchError(error));
	process.exitCode = 1;
} finally {
	readline?.close();
	if (closeBrowser) {
		try {
			await closeBrowser();
		} catch (error) {
			console.error(catchError(error));
			process.exitCode = 1;
		}
	}
	process.removeListener("SIGINT", onSignal);
	process.removeListener("SIGTERM", onSignal);
}
