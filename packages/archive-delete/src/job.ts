import path from "node:path";
import {
	findRepeatedUnretweetPostIds,
	isConfirmedAbsent,
	loadArchive,
	type ProgressEvent,
	readProgressEvents,
} from "twitter-api-safe-relay/archive-delete";

export type SelectionMode = "all" | "posts" | "reposts";

export type JobOptions = {
	archive: string;
	state?: string;
	mode: SelectionMode;
	postId?: string;
};

export type ArchiveDeleteJob = Awaited<ReturnType<typeof loadJob>>;

export const loadJob = async (options: JobOptions) => {
	const archiveDirectory = path.resolve(options.archive);
	const archive = await loadArchive(archiveDirectory);
	const modePosts =
		options.mode === "reposts"
			? archive.posts.filter((post) => post.kind === "repost")
			: options.mode === "posts"
				? archive.posts.filter((post) => post.kind !== "repost")
				: archive.posts;
	const selectedPosts = options.postId ? modePosts.filter((post) => post.id === options.postId) : modePosts;
	if (options.postId && selectedPosts.length === 0) {
		throw new Error(`指定した投稿ID ${options.postId} は選択範囲のアーカイブにありません`);
	}
	const progressFile = path.resolve(options.state ?? path.join(".archive-delete", `${archive.account.id}.ndjson`));
	const progressEvents = await readProgressEvents(progressFile, archive.account.id);
	const progress = new Map(progressEvents.map((event) => [event.postId, event]));
	const legacyRepostCandidates = findRepeatedUnretweetPostIds(progressEvents);
	const hasConfirmedAbsence = (event: ProgressEvent | undefined) => isConfirmedAbsent(event, legacyRepostCandidates);
	const remainingPosts = selectedPosts.filter((post) => !hasConfirmedAbsence(progress.get(post.id)));
	const latestEvents = remainingPosts.map((post) => progress.get(post.id));
	const awaitingPropagation = latestEvents.filter(
		(event) => event?.status === "deleted" || event?.status === "unretweeted",
	).length;
	const verificationFailed = latestEvents.filter((event) => event?.status === "verification_failed").length;
	const failed = latestEvents.filter((event) => event?.status === "failed").length;
	const pending = remainingPosts.length - awaitingPropagation - verificationFailed - failed;

	return {
		archiveDirectory,
		archive,
		selectedPosts,
		progressFile,
		progressEvents,
		progress,
		legacyRepostCandidates,
		hasConfirmedAbsence,
		remainingPosts,
		counts: {
			total: selectedPosts.length,
			completed: selectedPosts.length - remainingPosts.length,
			remaining: remainingPosts.length,
			pending,
			awaitingPropagation,
			verificationFailed,
			failed,
			reposts: selectedPosts.filter((post) => post.kind === "repost").length,
			posts: selectedPosts.filter((post) => post.kind !== "repost").length,
		},
	};
};

export const formatDuration = (milliseconds: number) => {
	const minutes = Math.ceil(milliseconds / 60_000);
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return hours === 0 ? `${minutes}分` : `${hours}時間${remainingMinutes}分`;
};

export const printJobHeader = (job: ArchiveDeleteJob) => {
	console.log(`アーカイブ: ${job.archiveDirectory}`);
	console.log(`対象アカウント: @${job.archive.account.username} (${job.archive.account.id})`);
	console.log(`対象: ${job.counts.total}件（通常 ${job.counts.posts} / リポスト ${job.counts.reposts}）`);
	console.log(`完了済み: ${job.counts.completed}件 / 残り: ${job.counts.remaining}件`);
	console.log(`進捗ファイル: ${job.progressFile}`);
};

export const printJobStatus = (job: ArchiveDeleteJob) => {
	printJobHeader(job);
	console.log(
		`未完了内訳: 未処理 ${job.counts.pending} / 反映確認待ち ${job.counts.awaitingPropagation} / 確認失敗 ${job.counts.verificationFailed} / 操作失敗 ${job.counts.failed}`,
	);
	console.log(`アーカイブ記録上で削除済み: ${job.archive.deletedPostCount}件`);
};
