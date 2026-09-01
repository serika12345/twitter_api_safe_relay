import { formatDuration, type JobOptions, loadJob, printJobStatus } from "../job.ts";

export type InspectOptions = JobOptions & {
	minDelayMs: number;
	maxDelayMs: number;
};

export const runInspect = async (options: InspectOptions) => {
	const job = await loadJob(options);
	printJobStatus(job);
	const averageDelay = (options.minDelayMs + options.maxDelayMs) / 2;
	const remainingReposts = job.remainingPosts.filter((post) => post.kind === "repost").length;
	const remainingUnknown = job.remainingPosts.filter((post) => post.kind === "unknown").length;
	const estimatedDeleteCalls = job.counts.remaining + remainingReposts + remainingUnknown;
	const estimatedVerificationCalls = job.counts.remaining;
	const estimatedCalls = estimatedDeleteCalls + estimatedVerificationCalls;
	console.log(`API要求間隔: ${options.minDelayMs}〜${options.maxDelayMs}ミリ秒`);
	console.log(
		`推定API要求数: 約${estimatedCalls}回 / 待機制限を除く所要時間: 約${formatDuration(estimatedCalls * averageDelay)}`,
	);
};
