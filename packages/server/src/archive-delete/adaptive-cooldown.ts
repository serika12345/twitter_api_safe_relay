import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readProgressEvents } from "./progress.ts";
import type { RateLimitSnapshot } from "./rate-limit-headers.ts";

const DELETE_TWEET_QUOTA = 200;
const DELETE_RETWEET_QUOTA = 200;
const DEFAULT_WINDOW_MS = 15 * 60_000;
const DEFAULT_SAFETY_MS = 15_000;
const DEFAULT_PROBE_MS = 15 * 60_000;
const MAX_PROBE_MS = 30 * 60_000;

type PersistedCooldownState = {
	version: 2;
	quota: number;
	windowMs: number;
	safetyMs: number;
	probeMs: number;
	nextAttemptAt?: string;
	restrictionObservedAt?: string;
	consecutiveFailures: number;
	updatedAt: string;
};

export type CooldownNotice = {
	kind: "waiting" | "limit_detected" | "recovered";
	waitMs?: number;
	message: string;
};

export type OperationCooldown = {
	beforeAttempt: () => Promise<void>;
	recordSuccess: () => Promise<void>;
	recordFailure: () => Promise<void>;
};

type CooldownOptions = {
	accountId: string;
	progressFile: string;
	signal: AbortSignal;
	serverSnapshot?: () => RateLimitSnapshot | undefined;
	onNotice?: (notice: CooldownNotice) => void;
	now?: () => number;
	wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	random?: () => number;
	stateFile?: string;
};

type CooldownModel = {
	quota: number;
	windowMs: number;
	stateFile: string;
	isSuccessfulEvent: (event: Awaited<ReturnType<typeof readProgressEvents>>[number]) => boolean;
};

const defaultState = (model: CooldownModel): PersistedCooldownState => ({
	version: 2,
	quota: model.quota,
	windowMs: model.windowMs,
	safetyMs: DEFAULT_SAFETY_MS,
	probeMs: DEFAULT_PROBE_MS,
	consecutiveFailures: 0,
	updatedAt: new Date(0).toISOString(),
});

const isState = (value: unknown): value is PersistedCooldownState => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const state = value as Partial<PersistedCooldownState>;
	return (
		state.version === 2 &&
		Number.isSafeInteger(state.quota) &&
		(state.quota ?? 0) > 0 &&
		Number.isSafeInteger(state.windowMs) &&
		(state.windowMs ?? 0) > 0 &&
		Number.isSafeInteger(state.safetyMs) &&
		(state.safetyMs ?? -1) >= 0 &&
		Number.isSafeInteger(state.probeMs) &&
		(state.probeMs ?? 0) > 0 &&
		Number.isSafeInteger(state.consecutiveFailures) &&
		(state.consecutiveFailures ?? -1) >= 0 &&
		(state.nextAttemptAt === undefined || typeof state.nextAttemptAt === "string") &&
		(state.restrictionObservedAt === undefined || typeof state.restrictionObservedAt === "string") &&
		typeof state.updatedAt === "string"
	);
};

const readState = async (file: string, model: CooldownModel) => {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
		return isState(parsed) && parsed.quota === model.quota && parsed.windowMs === model.windowMs
			? parsed
			: defaultState(model);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return defaultState(model);
		}
		throw error;
	}
};

const writeState = async (file: string, state: PersistedCooldownState) => {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporaryFile = `${file}.${process.pid}.tmp`;
	await fs.writeFile(temporaryFile, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
	await fs.rename(temporaryFile, file);
	await fs.chmod(file, 0o600);
};

const formatWait = (milliseconds: number) => {
	const seconds = Math.max(1, Math.ceil(milliseconds / 1_000));
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return minutes === 0 ? `${remainingSeconds}秒` : `${minutes}分${remainingSeconds}秒`;
};

const createCooldown = async (options: CooldownOptions, model: CooldownModel): Promise<OperationCooldown> => {
	const now = options.now ?? Date.now;
	const wait =
		options.wait ??
		(async (milliseconds: number, signal: AbortSignal) => {
			await sleep(milliseconds, undefined, { signal });
		});
	const random = options.random ?? Math.random;
	const stateFile = options.stateFile ?? model.stateFile;
	const state = await readState(stateFile, model);
	const history = await readProgressEvents(options.progressFile, options.accountId);
	let successfulAt = history
		.filter(model.isSuccessfulEvent)
		.map((event) => Date.parse(event.at))
		.filter(Number.isFinite)
		.sort((left, right) => left - right);
	let nextAttemptAt = state.nextAttemptAt === undefined ? 0 : Date.parse(state.nextAttemptAt);
	if (!Number.isFinite(nextAttemptAt)) nextAttemptAt = 0;
	let restrictionObservedAt =
		state.restrictionObservedAt === undefined ? undefined : Date.parse(state.restrictionObservedAt);
	if (restrictionObservedAt !== undefined && !Number.isFinite(restrictionObservedAt)) {
		restrictionObservedAt = undefined;
	}
	let consecutiveFailures = state.consecutiveFailures;

	const save = async () => {
		state.nextAttemptAt = nextAttemptAt > 0 ? new Date(nextAttemptAt).toISOString() : undefined;
		state.restrictionObservedAt =
			restrictionObservedAt === undefined ? undefined : new Date(restrictionObservedAt).toISOString();
		state.consecutiveFailures = consecutiveFailures;
		state.updatedAt = new Date(now()).toISOString();
		await writeState(stateFile, state);
	};

	const trimHistory = (time: number) => {
		const cutoff = time - Math.max(state.windowMs * 2, MAX_PROBE_MS * 2);
		successfulAt = successfulAt.filter((timestamp) => timestamp >= cutoff);
	};

	const safetyJitter = () => Math.floor(random() * Math.max(1, Math.floor(state.safetyMs / 3)));

	const activeSnapshot = (time: number) => {
		const snapshot = options.serverSnapshot?.();
		return snapshot !== undefined && snapshot.resetAt > time ? snapshot : undefined;
	};

	const snapshotReleaseAt = (snapshot: RateLimitSnapshot) => snapshot.resetAt + state.safetyMs + safetyJitter();

	const quotaReleaseAt = (time: number) => {
		trimHistory(time);
		const insideWindow = successfulAt.filter((timestamp) => timestamp > time - state.windowMs);
		if (insideWindow.length < state.quota) return 0;
		const boundary = insideWindow.at(-state.quota);
		if (boundary === undefined) return 0;
		return boundary + state.windowMs + state.safetyMs + safetyJitter();
	};

	const beforeAttempt = async () => {
		const current = now();
		const snapshot = activeSnapshot(current);
		const quotaTarget = snapshot === undefined ? quotaReleaseAt(current) : 0;
		const serverTarget = snapshot !== undefined && snapshot.remaining <= 0 ? snapshotReleaseAt(snapshot) : 0;
		const target = Math.max(nextAttemptAt, quotaTarget, serverTarget);
		if (target <= current) return;
		const waitMs = target - current;
		options.onNotice?.({
			kind: "waiting",
			waitMs,
			message:
				serverTarget >= target
					? `サーバー通知の残量0件に基づき${formatWait(waitMs)}待機します`
					: nextAttemptAt >= target
						? `制限検出後の待機として${formatWait(waitMs)}待機します`
						: `直近${Math.round(state.windowMs / 60_000)}分の成功数を基に${formatWait(waitMs)}待機します`,
		});
		await wait(waitMs, options.signal);
		nextAttemptAt = 0;
	};

	const recordFailure = async () => {
		const current = now();
		restrictionObservedAt ??= current;
		const snapshot = activeSnapshot(current);
		const probeWait = Math.min(MAX_PROBE_MS, state.probeMs * 2 ** consecutiveFailures);
		const target = (() => {
			if (snapshot !== undefined) {
				return snapshot.remaining <= 0 ? snapshotReleaseAt(snapshot) : current + probeWait;
			}
			const quotaTarget = quotaReleaseAt(current);
			return quotaTarget > current ? quotaTarget : current + probeWait;
		})();
		nextAttemptAt = Math.max(nextAttemptAt, target);
		consecutiveFailures += 1;
		options.onNotice?.({
			kind: "limit_detected",
			waitMs: nextAttemptAt - current,
			message: `削除制限の兆候を検出しました。次の探索要求まで${formatWait(nextAttemptAt - current)}待機します`,
		});
		await save();
	};

	const recordSuccess = async () => {
		const current = now();
		successfulAt.push(current);
		if (restrictionObservedAt !== undefined) {
			const observedRecoveryMs = current - restrictionObservedAt;
			const reliableProbeMs = Math.ceil((Math.ceil((observedRecoveryMs * 11) / 10) + state.safetyMs) / 1_000) * 1_000;
			state.probeMs = Math.min(MAX_PROBE_MS, Math.max(DEFAULT_PROBE_MS, state.probeMs, reliableProbeMs));
			options.onNotice?.({
				kind: "recovered",
				message: `削除成功への復帰を${formatWait(observedRecoveryMs)}で確認しました。未知の制限時は${formatWait(state.probeMs)}を待機基準にします`,
			});
			restrictionObservedAt = undefined;
			consecutiveFailures = 0;
			nextAttemptAt = 0;
			await save();
		}
	};

	return { beforeAttempt, recordSuccess, recordFailure };
};

export const createDeleteTweetCooldown = async (options: CooldownOptions): Promise<OperationCooldown> =>
	await createCooldown(options, {
		quota: DELETE_TWEET_QUOTA,
		windowMs: DEFAULT_WINDOW_MS,
		stateFile: `${options.progressFile}.cooldown.json`,
		isSuccessfulEvent: (event) => event.status === "deleted",
	});

export const createDeleteRetweetCooldown = async (options: CooldownOptions): Promise<OperationCooldown> =>
	await createCooldown(options, {
		quota: DELETE_RETWEET_QUOTA,
		windowMs: DEFAULT_WINDOW_MS,
		stateFile: `${options.progressFile}.retweet-cooldown.json`,
		isSuccessfulEvent: (event) => event.status === "unretweeted",
	});
