import {
	assertNoApiErrors,
	createRateLimiter,
	DEFAULT_CATALOG_URL,
	executeOperation,
	loadOperationCatalog,
	readViewerIdentity,
} from "twitter-api-safe-relay/archive-delete";
import { openProfileSession, type ProfileOptions } from "./profile.ts";

export type OnlineOptions = ProfileOptions & {
	catalog: string;
	minDelayMs: number;
	maxDelayMs: number;
};

export const defaultOnlineOptions = {
	settings: "./settings.json",
	catalog: DEFAULT_CATALOG_URL,
	minDelayMs: 1_050,
	maxDelayMs: 1_350,
};

export const openOnlineRuntime = async (options: OnlineOptions, signal: AbortSignal) => {
	if (options.minDelayMs < 1_001) throw new Error("--min-delay-ms は1001以上にしてください");
	if (options.maxDelayMs < options.minDelayMs) {
		throw new Error("--max-delay-ms は --min-delay-ms 以上にしてください");
	}
	const catalog = await loadOperationCatalog(options.catalog);
	const session = await openProfileSession(options);
	const rateLimiter = createRateLimiter(options.minDelayMs, options.maxDelayMs, signal);
	return { ...session, catalog, rateLimiter };
};

export const readAuthenticatedViewer = async (runtime: Awaited<ReturnType<typeof openOnlineRuntime>>) => {
	const response = await runtime.rateLimiter.schedule(
		async () =>
			await executeOperation(runtime.client, runtime.catalog, "Viewer", {
				withCommunitiesMemberships: true,
			}),
	);
	assertNoApiErrors(response, "Viewer");
	const viewer = readViewerIdentity(response);
	if (!viewer) throw new Error("ログイン中のXアカウントを確認できません。login コマンドを再実行してください");
	return viewer;
};

export const assertExpectedAccount = async (
	runtime: Awaited<ReturnType<typeof openOnlineRuntime>>,
	expectedAccountId: string,
) => {
	const viewer = await readAuthenticatedViewer(runtime);
	if (viewer.id !== expectedAccountId) {
		throw new Error(
			`ログイン中のアカウント (@${viewer.username ?? "unknown"}, ${viewer.id}) とアーカイブのアカウントID (${expectedAccountId}) が一致しません`,
		);
	}
	return viewer;
};
