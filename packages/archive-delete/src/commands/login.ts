import { createInterface } from "node:readline/promises";
import { type OnlineOptions, openOnlineRuntime, readAuthenticatedViewer } from "../online.ts";

export const runLogin = async (options: OnlineOptions, signal: AbortSignal) => {
	console.log("専用ブラウザープロファイルを開いています…");
	const runtime = await openOnlineRuntime(options, signal);
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	let loginSummary: string | undefined;
	try {
		console.log(`プロファイル: ${runtime.profile.name}`);
		console.log("表示されたブラウザーでXへ手動ログインしてください。");
		await readline.question("ログイン完了後、この端末で Enter を押してください: ");
		await runtime.client.goto(runtime.profile.homeUrl);
		const viewer = await readAuthenticatedViewer(runtime);
		loginSummary = `ログイン確認完了: @${viewer.username ?? "unknown"} (${viewer.id})`;
	} finally {
		readline.close();
		await runtime.close();
	}
	console.log(loginSummary);
	console.log("ブラウザーを閉じました。続けて delete または verify コマンドを実行できます。");
};
