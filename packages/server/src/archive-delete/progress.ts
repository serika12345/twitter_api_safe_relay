import fs from "node:fs/promises";
import path from "node:path";
import type { ArchivePostKind } from "./archive.ts";

export type ProgressStatus =
	| "already_absent"
	| "deleted"
	| "failed"
	| "unretweeted"
	| "verification_failed"
	| "verified_absent";

export type ProgressEvent = {
	version: 1;
	at: string;
	accountId: string;
	postId: string;
	kind: ArchivePostKind;
	status: ProgressStatus;
	attempts: number;
	detail?: string;
};

export const REPOST_WRAPPER_ABSENT_DETAIL = "repost_wrapper_absent";

const successfulStatuses = new Set<ProgressStatus>(["already_absent", "deleted", "unretweeted", "verified_absent"]);

const isProgressEvent = (value: unknown): value is ProgressEvent => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Partial<ProgressEvent>;
	return (
		candidate.version === 1 &&
		typeof candidate.accountId === "string" &&
		typeof candidate.postId === "string" &&
		typeof candidate.status === "string"
	);
};

export const readProgressEvents = async (file: string, accountId: string) => {
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}

	const result: ProgressEvent[] = [];
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			if (index === lines.length - 1) break;
			throw new Error(`進捗ファイルの${index + 1}行目を解析できません`, { cause: error });
		}
		if (!isProgressEvent(parsed)) throw new Error(`進捗ファイルの${index + 1}行目が不正です`);
		if (parsed.accountId !== accountId) {
			throw new Error(`進捗ファイルは別アカウント (${parsed.accountId}) のものです`);
		}
		result.push(parsed);
	}
	return result;
};

export const readProgress = async (file: string, accountId: string) => {
	const result = new Map<string, ProgressEvent>();
	for (const event of await readProgressEvents(file, accountId)) result.set(event.postId, event);
	return result;
};

export const isCompleted = (event: ProgressEvent | undefined) =>
	event !== undefined && successfulStatuses.has(event.status);

export const findRepeatedUnretweetPostIds = (events: ProgressEvent[]) => {
	const counts = new Map<string, number>();
	for (const event of events) {
		if (event.kind !== "repost" || event.status !== "unretweeted") continue;
		counts.set(event.postId, (counts.get(event.postId) ?? 0) + 1);
	}
	return new Set([...counts.entries()].filter(([, count]) => count >= 2).map(([postId]) => postId));
};

export const isConfirmedAbsent = (
	event: ProgressEvent | undefined,
	repostsRequiringWrapperDeletion: ReadonlySet<string> = new Set(),
) => {
	if (event?.status !== "verified_absent" && event?.status !== "already_absent") return false;
	if (!repostsRequiringWrapperDeletion.has(event.postId)) return true;
	return event.detail === REPOST_WRAPPER_ABSENT_DETAIL;
};

export const appendProgress = async (file: string, event: ProgressEvent) => {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await fs.appendFile(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
	await fs.chmod(file, 0o600);
};

export const sanitizeDetail = (value: unknown) => {
	const message = value instanceof Error ? value.message : String(value);
	return message.replaceAll(/[\r\n\t]+/g, " ").slice(0, 500);
};
