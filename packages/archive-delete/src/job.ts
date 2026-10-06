import path from "node:path";
import {
	type ArchiveExclusion,
	excludePosts,
	findRepeatedUnretweetPostIds,
	isConfirmedAbsent,
	loadArchive,
	type ProgressEvent,
	readExcludedPostIds,
	readProgressEvents,
} from "twitter-api-safe-relay/archive-delete";

export type SelectionMode = "all" | "posts" | "reposts";

export type JobOptions = {
	archive: string;
	state?: string;
	mode: SelectionMode;
	postId?: string;
	excludePostIds?: string[];
	excludePostIdsFile?: string;
	excludeMinFavorites?: number;
	excludeMinRetweets?: number;
	excludeMedia?: boolean;
	excludeReplies?: boolean;
};

export type ArchiveDeleteJob = Awaited<ReturnType<typeof loadJob>>;

const resolveExclusion = async (options: JobOptions): Promise<ArchiveExclusion> => {
	const postIds = [...(options.excludePostIds ?? [])];
	if (options.excludePostIdsFile !== undefined) {
		postIds.push(...(await readExcludedPostIds(path.resolve(options.excludePostIdsFile))));
	}
	return {
		postIds,
		excludeMedia: options.excludeMedia === true,
		excludeReplies: options.excludeReplies === true,
		...(options.excludeMinFavorites === undefined ? {} : { minFavoriteCount: options.excludeMinFavorites }),
		...(options.excludeMinRetweets === undefined ? {} : { minRetweetCount: options.excludeMinRetweets }),
	};
};

export const loadJob = async (options: JobOptions) => {
	const archiveDirectory = path.resolve(options.archive);
	const archive = await loadArchive(archiveDirectory);
	const modePosts =
		options.mode === "reposts"
			? archive.posts.filter((post) => post.kind === "repost")
			: options.mode === "posts"
				? archive.posts.filter((post) => post.kind !== "repost")
				: archive.posts;
	const exclusion = await resolveExclusion(options);
	const filteredPosts = excludePosts(modePosts, exclusion);
	const selectedPosts = options.postId ? filteredPosts.filter((post) => post.id === options.postId) : filteredPosts;
	if (options.postId && selectedPosts.length === 0) {
		throw new Error(
			modePosts.some((post) => post.id === options.postId)
				? `指定した投稿ID ${options.postId} は除外条件により対象から外れています`
				: `指定した投稿ID ${options.postId} は選択範囲のアーカイブにありません`,
		);
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
			excluded: modePosts.length - filteredPosts.length,
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
	if (job.counts.excluded > 0) console.log(`除外: ${job.counts.excluded}件`);
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
