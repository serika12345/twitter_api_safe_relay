import { createInterface } from "node:readline/promises";
import {
	createArchiveDeleteRunner,
	createDeleteRetweetCooldown,
	createDeleteTweetCooldown,
	type RunnerProgress,
	type RunnerSummary,
} from "twitter-api-safe-relay/archive-delete";
import { type ArchiveDeleteJob, type JobOptions, loadJob, printJobHeader } from "../job.ts";
import { assertExpectedAccount, type OnlineOptions, openOnlineRuntime } from "../online.ts";
import { runVerificationPasses } from "../verification.ts";

type RunnerOptions = {
	maxAttempts: number;
	requestTimeoutMs: number;
	propagationWaitMs: number;
	verificationRounds: number;
};

export type DeleteOptions = JobOptions &
	OnlineOptions &
	RunnerOptions & {
		yes: boolean;
		verify: boolean;
	};

export type VerifyOptions = JobOptions & OnlineOptions & RunnerOptions;

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

const printProgress = ({ phase, completed, total, postId, status }: RunnerProgress) => {
	console.log(`[${phase === "delete" ? "削除" : "確認"} ${completed}/${total}] ${postId}: ${status}`);
};

const unresolvedPosts = (job: ArchiveDeleteJob) =>
	job.selectedPosts.filter((post) => !job.hasConfirmedAbsence(job.progress.get(post.id)));

const printSummary = (summary: RunnerSummary, remaining: number) => {
	console.log("\n実行結果");
	console.log(`削除要求成功: ${summary.deleted}件 / 既に不存在: ${summary.alreadyAbsent}件`);
	console.log(
		`確認済み不存在: ${summary.verifiedAbsent}件 / 確認失敗: ${summary.verificationFailed}件 / 操作失敗: ${summary.failed}件`,
	);
	console.log(`現在の未完了: ${remaining}件`);
};

const runVerificationRounds = async (
	runner: ReturnType<typeof createArchiveDeleteRunner>,
	job: ArchiveDeleteJob,
	options: RunnerOptions,
	signal: AbortSignal,
) => {
	const summaries = await runVerificationPasses({
		rounds: options.verificationRounds,
		waitMs: options.propagationWaitMs,
		signal,
		remainingCount: () => unresolvedPosts(job).length,
		onWait: (remaining, waitMs) => {
			console.log(`\n反映待ちの${remaining}件を再確認するため${Math.ceil(waitMs / 1_000)}秒待機します。`);
		},
		verify: async (round) => {
			const remaining = unresolvedPosts(job).length;
			console.log(`\n不存在確認 ${round}/${options.verificationRounds}: ${remaining}件`);
			return await runner.verifyPosts(job.selectedPosts);
		},
	});
	return summaries.reduce(addSummary, emptySummary());
};

const createRunner = async (
	runtime: Awaited<ReturnType<typeof openOnlineRuntime>>,
	job: ArchiveDeleteJob,
	options: RunnerOptions,
	signal: AbortSignal,
	withMutationCooldown: boolean,
) =>
	createArchiveDeleteRunner({
		accountId: job.archive.account.id,
		client: runtime.client,
		catalog: runtime.catalog,
		rateLimiter: runtime.rateLimiter,
		progressFile: job.progressFile,
		progress: job.progress,
		maximumAttempts: options.maxAttempts,
		requestTimeoutMs: options.requestTimeoutMs,
		deleteRetweetCooldown: withMutationCooldown
			? await createDeleteRetweetCooldown({
					accountId: job.archive.account.id,
					progressFile: job.progressFile,
					signal,
					serverSnapshot: () => runtime.rateLimitHeaders.get("DeleteRetweet"),
					onNotice: ({ message }) => console.log(`[リポスト解除制限] ${message}`),
				})
			: undefined,
		deleteTweetCooldown: withMutationCooldown
			? await createDeleteTweetCooldown({
					accountId: job.archive.account.id,
					progressFile: job.progressFile,
					signal,
					serverSnapshot: () => runtime.rateLimitHeaders.get("DeleteTweet"),
					onNotice: ({ message }) => console.log(`[通常ポスト制限] ${message}`),
				})
			: undefined,
		isPostCompleted: job.hasConfirmedAbsence,
		recoverAfterTimeout: async () => {
			console.warn("API要求が時間切れになったため、ページを再読み込みして1回だけ再試行します。");
			await runtime.client.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
			await runtime.client.waitStartup();
		},
		signal,
		onProgress: printProgress,
	});

const confirmDeletion = async (job: ArchiveDeleteJob) => {
	const confirmation = `DELETE ${job.counts.remaining} @${job.archive.account.username}`;
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await readline.question(`削除は元に戻せません。続行するには「${confirmation}」と入力してください: `);
		if (answer !== confirmation) throw new Error("確認文字列が一致しないため、削除を開始しませんでした");
	} finally {
		readline.close();
	}
};

export const runDelete = async (options: DeleteOptions, signal: AbortSignal) => {
	const job = await loadJob(options);
	printJobHeader(job);
	if (job.counts.remaining === 0) {
		console.log("全対象の不存在確認が完了済みです。");
		return 0;
	}

	console.log("保存済みのログインセッションを確認しています…");
	const runtime = await openOnlineRuntime(options, signal);
	try {
		const viewer = await assertExpectedAccount(runtime, job.archive.account.id);
		console.log(`ログイン確認: @${viewer.username ?? job.archive.account.username} (${viewer.id})`);
		if (!options.yes) await confirmDeletion(job);
		const runner = await createRunner(runtime, job, options, signal, true);
		let summary = await runner.deletePosts(job.selectedPosts);
		if (options.verify && !signal.aborted) {
			summary = addSummary(summary, await runVerificationRounds(runner, job, options, signal));
		}
		const remaining = unresolvedPosts(job).length;
		printSummary(summary, remaining);
		if (!options.verify) {
			console.log("削除後の不存在確認を省略しました。verify コマンドで確認してください。");
			return 0;
		}
		return remaining === 0 && !summary.stopped ? 0 : 1;
	} finally {
		await runtime.close();
	}
};

export const runVerify = async (options: VerifyOptions, signal: AbortSignal) => {
	const job = await loadJob(options);
	printJobHeader(job);
	if (job.counts.remaining === 0) {
		console.log("全対象の不存在確認が完了済みです。");
		return 0;
	}

	console.log("保存済みのログインセッションを確認しています…");
	const runtime = await openOnlineRuntime(options, signal);
	try {
		const viewer = await assertExpectedAccount(runtime, job.archive.account.id);
		console.log(`ログイン確認: @${viewer.username ?? job.archive.account.username} (${viewer.id})`);
		const runner = await createRunner(runtime, job, options, signal, false);
		const summary = await runVerificationRounds(runner, job, options, signal);
		const remaining = unresolvedPosts(job).length;
		printSummary(summary, remaining);
		return remaining === 0 && !summary.stopped ? 0 : 1;
	} finally {
		await runtime.close();
	}
};
