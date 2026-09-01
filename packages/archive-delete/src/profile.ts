import fs from "node:fs/promises";
import path from "node:path";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import { type BrowserContext, chromium, firefox, webkit } from "playwright";
import { createTwitterBrowser, type TwitterApiProfileClient } from "twitter-api-safe-request";

type BrowserType = "chromium" | "firefox" | "webkit";

type Viewport = {
	width: number;
	height: number;
};

type Proxy = {
	server: string;
	bypass?: string;
	username?: string;
	password?: string;
};

type LaunchBrowserProfile = {
	type: "launch";
	browserType: BrowserType;
	userDataDir: string;
	headless: boolean;
	channel?: string;
	executablePath?: string;
	args: string[];
	viewport?: Viewport;
	proxy?: Proxy;
	env?: Record<string, string>;
};

type CdpBrowserProfile = {
	type: "cdp";
	browserType: "chromium";
	cdpEndpoint: string;
};

export type ResolvedProfile = {
	name: string;
	homeUrl: string;
	browser: LaunchBrowserProfile | CdpBrowserProfile;
};

export type ProfileOptions = {
	settings: string;
	profile?: string;
	browserExecutable?: string;
};

type OpenSession = {
	client: TwitterApiProfileClient;
	close: () => Promise<void>;
	profile: ResolvedProfile;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const requiredString = (value: unknown, label: string) => {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} が設定されていません`);
	return value;
};

const optionalString = (value: unknown, label: string) => {
	if (value === undefined) return undefined;
	return requiredString(value, label);
};

const resolveFromSettings = (settingsFile: string, value: string) =>
	path.isAbsolute(value) ? value : path.resolve(path.dirname(settingsFile), value);

const readViewport = (value: unknown): Viewport | undefined => {
	if (value === undefined) return undefined;
	if (!isRecord(value) || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)) {
		throw new Error("browser.viewport には正の整数の width と height が必要です");
	}
	const width = value.width as number;
	const height = value.height as number;
	if (width <= 0 || height <= 0) throw new Error("browser.viewport は正の値にしてください");
	return { width, height };
};

const readProxy = (value: unknown): Proxy | undefined => {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error("browser.proxy が不正です");
	return {
		server: requiredString(value.server, "browser.proxy.server"),
		...(optionalString(value.bypass, "browser.proxy.bypass") === undefined
			? {}
			: { bypass: optionalString(value.bypass, "browser.proxy.bypass") }),
		...(optionalString(value.username, "browser.proxy.username") === undefined
			? {}
			: { username: optionalString(value.username, "browser.proxy.username") }),
		...(optionalString(value.password, "browser.proxy.password") === undefined
			? {}
			: { password: optionalString(value.password, "browser.proxy.password") }),
	};
};

const readStringRecord = (value: unknown, label: string) => {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
		throw new Error(`${label} は文字列値のオブジェクトにしてください`);
	}
	return value as Record<string, string>;
};

const readBrowser = (
	value: unknown,
	settingsFile: string,
	browserExecutable?: string,
): LaunchBrowserProfile | CdpBrowserProfile => {
	if (!isRecord(value)) throw new Error("browser 設定がありません");
	if (value.type === "cdp") {
		return {
			type: "cdp",
			browserType: "chromium",
			cdpEndpoint: requiredString(value.cdpEndpoint, "browser.cdpEndpoint"),
		};
	}
	if (value.type !== "launch") throw new Error("browser.type は launch または cdp にしてください");
	const browserType = value.browserType ?? "chromium";
	if (browserType !== "chromium" && browserType !== "firefox" && browserType !== "webkit") {
		throw new Error("browser.browserType が不正です");
	}
	const args = value.args ?? [];
	if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
		throw new Error("browser.args は文字列の配列にしてください");
	}
	const configuredExecutable = optionalString(value.executablePath, "browser.executablePath");
	const executablePath = browserExecutable
		? path.resolve(browserExecutable)
		: configuredExecutable
			? resolveFromSettings(settingsFile, configuredExecutable)
			: undefined;
	return {
		type: "launch",
		browserType,
		userDataDir: resolveFromSettings(settingsFile, requiredString(value.userDataDir, "browser.userDataDir")),
		headless: value.headless === true,
		args,
		...(optionalString(value.channel, "browser.channel") === undefined
			? {}
			: { channel: optionalString(value.channel, "browser.channel") }),
		...(executablePath === undefined ? {} : { executablePath }),
		...(readViewport(value.viewport) === undefined ? {} : { viewport: readViewport(value.viewport) }),
		...(readProxy(value.proxy) === undefined ? {} : { proxy: readProxy(value.proxy) }),
		...(readStringRecord(value.env, "browser.env") === undefined
			? {}
			: { env: readStringRecord(value.env, "browser.env") }),
	};
};

export const loadProfile = async (options: ProfileOptions): Promise<ResolvedProfile> => {
	const settingsFile = path.resolve(options.settings);
	const errors: ParseError[] = [];
	const parsed: unknown = parse(await fs.readFile(settingsFile, "utf8"), errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		throw new AggregateError(
			errors.map((error) => new Error(`${printParseErrorCode(error.error)} at offset ${error.offset}`)),
			`${settingsFile} を解析できません`,
		);
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.profiles) || parsed.profiles.length === 0) {
		throw new Error(`${settingsFile} にブラウザープロファイルがありません`);
	}
	const profiles = parsed.profiles.filter(isRecord);
	const selected = options.profile
		? profiles.find((profile) => profile.name === options.profile)
		: profiles.length === 1
			? profiles[0]
			: undefined;
	if (!selected) {
		throw new Error(
			options.profile
				? `プロファイル ${options.profile} がありません`
				: "複数のプロファイルがあります。--profile で1つ指定してください",
		);
	}
	const name = requiredString(selected.name, "profile.name");
	const home = isRecord(selected.home) ? selected.home : undefined;
	return {
		name,
		homeUrl: typeof home?.url === "string" ? home.url : "https://x.com/home",
		browser: readBrowser(selected.browser, settingsFile, options.browserExecutable),
	};
};

const connectBrowser = async (profile: ResolvedProfile): Promise<readonly [BrowserContext, () => Promise<void>]> => {
	if (profile.browser.type === "cdp") {
		const browser = await chromium.connectOverCDP(profile.browser.cdpEndpoint);
		const context = browser.contexts()[0];
		if (!context) throw new Error("接続したブラウザーにコンテキストがありません");
		return [context, async () => await browser.close()] as const;
	}
	const browserType = { chromium, firefox, webkit }[profile.browser.browserType];
	const context = await browserType.launchPersistentContext(profile.browser.userDataDir, {
		handleSIGINT: false,
		handleSIGTERM: false,
		handleSIGHUP: false,
		headless: profile.browser.headless,
		channel: profile.browser.channel,
		executablePath: profile.browser.executablePath,
		env: profile.browser.env,
		proxy: profile.browser.proxy,
		args: ["--disable-blink-features=AutomationControlled", ...profile.browser.args],
		viewport: profile.browser.viewport,
	});
	return [context, async () => await context.close()] as const;
};

export const openProfileSession = async (options: ProfileOptions): Promise<OpenSession> => {
	const profile = await loadProfile(options);
	const [context, close] = await connectBrowser(profile);
	try {
		const page = context.pages()[0] ?? (await context.newPage());
		const client = createTwitterBrowser(page);
		await client.inject();
		await client.goto(profile.homeUrl);
		return { client, close, profile };
	} catch (error) {
		await close();
		throw error;
	}
};
