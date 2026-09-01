#!/usr/bin/env node

import { Command, InvalidArgumentError } from "commander";
import { DEFAULT_CATALOG_URL } from "twitter-api-safe-relay/archive-delete";
import { runDelete, runVerify } from "./commands/delete.ts";
import { runInspect } from "./commands/inspect.ts";
import { runLogin } from "./commands/login.ts";
import { runStatus } from "./commands/status.ts";
import type { JobOptions, SelectionMode } from "./job.ts";

type ProfileCliOptions = {
	settings: string;
	profile?: string;
	browserExecutable?: string;
	catalog: string;
	minDelayMs: number;
	maxDelayMs: number;
};

type SelectionCliOptions = {
	archive: string;
	state?: string;
	onlyReposts: boolean;
	onlyPosts: boolean;
	postId?: string;
};

type RunnerCliOptions = {
	maxAttempts: number;
	requestTimeoutMs: number;
	propagationWaitMs: number;
	verificationRounds: number;
};

const positiveInteger = (value: string) => {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new InvalidArgumentError("正の整数を指定してください");
	return parsed;
};

const addProfileOptions = (command: Command) =>
	command
		.option("--settings <file>", "ブラウザー設定ファイル", "./settings.json")
		.option("--profile <name>", "使用するブラウザープロファイル")
		.option("--browser-executable <file>", "launchプロファイルのブラウザー実行ファイルを上書き")
		.option("--catalog <url-or-file>", "Web API操作カタログ", DEFAULT_CATALOG_URL)
		.option("--min-delay-ms <milliseconds>", "API要求間隔の下限", positiveInteger, 1_050)
		.option("--max-delay-ms <milliseconds>", "API要求間隔の上限", positiveInteger, 1_350);

const addSelectionOptions = (command: Command) =>
	command
		.option("--archive <directory>", "Xアーカイブのディレクトリ", "./my_archive")
		.option("--state <file>", "進捗ファイルを上書き")
		.option("--only-reposts", "リポスト投稿だけを対象にする", false)
		.option("--only-posts", "通常投稿だけを対象にする", false)
		.option("--post-id <id>", "指定した投稿IDだけを対象にする");

const addRunnerOptions = (command: Command) =>
	command
		.option("--max-attempts <count>", "API操作ごとの最大試行回数", positiveInteger, 2)
		.option("--request-timeout-ms <milliseconds>", "API要求1回の上限時間", positiveInteger, 30_000)
		.option("--propagation-wait-ms <milliseconds>", "削除反映後の再確認待機時間", positiveInteger, 60_000)
		.option("--verification-rounds <count>", "不存在確認の最大巡回数", positiveInteger, 2);

const selectionOptions = (options: SelectionCliOptions): JobOptions => {
	if (options.onlyReposts && options.onlyPosts) {
		throw new Error("--only-reposts と --only-posts は同時に指定できません");
	}
	if (options.postId !== undefined && !/^\d+$/.test(options.postId)) {
		throw new Error("--post-id は数字だけで指定してください");
	}
	const mode: SelectionMode = options.onlyReposts ? "reposts" : options.onlyPosts ? "posts" : "all";
	return {
		archive: options.archive,
		state: options.state,
		mode,
		postId: options.postId,
	};
};

const abortController = new AbortController();
const onSignal = () => {
	if (abortController.signal.aborted) return;
	console.error("\n中断要求を受け付けました。現在の要求と進捗保存を終えて停止します。");
	abortController.abort(new Error("利用者が処理を中断しました"));
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

const program = new Command()
	.name("x-archive-delete")
	.description("手動ログインしたブラウザープロファイルからXアーカイブの全投稿を削除します")
	.showHelpAfterError();

addProfileOptions(program.command("login").description("専用ブラウザープロファイルへ手動ログインする")).action(
	async (options: ProfileCliOptions) => {
		await runLogin(options, abortController.signal);
	},
);

addSelectionOptions(program.command("inspect").description("アーカイブと削除対象を変更なしで検査する"))
	.option("--min-delay-ms <milliseconds>", "API要求間隔の下限", positiveInteger, 1_050)
	.option("--max-delay-ms <milliseconds>", "API要求間隔の上限", positiveInteger, 1_350)
	.action(async (options: SelectionCliOptions & { minDelayMs: number; maxDelayMs: number }) => {
		await runInspect({ ...selectionOptions(options), minDelayMs: options.minDelayMs, maxDelayMs: options.maxDelayMs });
	});

addSelectionOptions(program.command("status").description("保存済み進捗を変更なしで表示する")).action(
	async (options: SelectionCliOptions) => {
		await runStatus(selectionOptions(options));
	},
);

addRunnerOptions(
	addSelectionOptions(
		addProfileOptions(program.command("delete").description("未完了の投稿を削除して不存在を確認する")),
	),
)
	.option("--yes", "確認文字列の入力を省略する", false)
	.option("--no-verify", "削除後の不存在確認を省略する")
	.action(
		async (options: ProfileCliOptions & SelectionCliOptions & RunnerCliOptions & { yes: boolean; verify: boolean }) => {
			process.exitCode = await runDelete({ ...options, ...selectionOptions(options) }, abortController.signal);
		},
	);

addRunnerOptions(
	addSelectionOptions(addProfileOptions(program.command("verify").description("変更要求を送らず未完了分を再確認する"))),
).action(async (options: ProfileCliOptions & SelectionCliOptions & RunnerCliOptions) => {
	process.exitCode = await runVerify({ ...options, ...selectionOptions(options) }, abortController.signal);
});

try {
	await program.parseAsync();
} catch (error) {
	if (!abortController.signal.aborted) {
		console.error(error instanceof Error ? error.message : String(error));
	}
	process.exitCode = 1;
} finally {
	process.removeListener("SIGINT", onSignal);
	process.removeListener("SIGTERM", onSignal);
}
