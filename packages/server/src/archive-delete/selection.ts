import fs from "node:fs/promises";
import type { ArchivePost } from "./archive.ts";

export type ArchiveExclusion = {
	postIds?: readonly string[];
	minFavoriteCount?: number;
	minRetweetCount?: number;
	excludeMedia?: boolean;
	excludeReplies?: boolean;
};

export const isExcludedPost = (post: ArchivePost, exclusion: ArchiveExclusion) => {
	if (exclusion.postIds?.includes(post.id)) return true;
	if (exclusion.excludeMedia === true && post.hasMedia !== false) return true;
	if (exclusion.excludeReplies === true && post.isReply !== false) return true;
	if (
		exclusion.minFavoriteCount !== undefined &&
		(post.favoriteCount === undefined || post.favoriteCount >= exclusion.minFavoriteCount)
	) {
		return true;
	}
	if (
		exclusion.minRetweetCount !== undefined &&
		(post.retweetCount === undefined || post.retweetCount >= exclusion.minRetweetCount)
	) {
		return true;
	}
	return false;
};

export const excludePosts = (posts: readonly ArchivePost[], exclusion: ArchiveExclusion) =>
	posts.filter((post) => !isExcludedPost(post, exclusion));

export const readExcludedPostIds = async (file: string): Promise<string[]> => {
	const text = await fs.readFile(file, "utf8");
	const ids: string[] = [];
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		const value = line.trim();
		if (value === "" || value.startsWith("#")) continue;
		if (!/^\d{1,19}$/.test(value)) {
			throw new Error(`除外IDファイルの${index + 1}行目が投稿IDではありません`);
		}
		ids.push(value);
	}
	return ids;
};
