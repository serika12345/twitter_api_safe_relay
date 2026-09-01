import fs from "node:fs/promises";
import type { TwitterApiProfileClient } from "twitter-api-safe-request";

type JsonRecord = Record<string, unknown>;

export const DEFAULT_CATALOG_URL =
	"https://raw.githubusercontent.com/fa0311/twitter_api_safe_relay_skills/main/skills/twitter-api-relay/requests.ndjson";

export type OperationName = "DeleteRetweet" | "DeleteTweet" | "TweetResultByRestId" | "Viewer";

type GraphQlCapture = {
	method: "GET" | "POST";
	path: string;
	headers: Record<string, string>;
	params?: JsonRecord;
	data?: JsonRecord;
};

export type OperationCatalog = Record<OperationName, GraphQlCapture>;

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const readCatalogSource = async (source: string) => {
	if (!/^https?:\/\//.test(source)) return await fs.readFile(source, "utf8");

	const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) {
		throw new Error(`操作カタログを取得できません: ${response.status} ${response.statusText}`);
	}
	return await response.text();
};

const parseCapture = (value: unknown): GraphQlCapture | undefined => {
	if (!isRecord(value)) return undefined;
	const method = value.method;
	const capturePath = value.path;
	if ((method !== "GET" && method !== "POST") || typeof capturePath !== "string") return undefined;
	if (!capturePath.startsWith("/graphql/")) return undefined;

	const headers = isRecord(value.headers)
		? Object.fromEntries(
				Object.entries(value.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			)
		: {};
	return {
		method,
		path: capturePath,
		headers,
		params: isRecord(value.params) ? value.params : undefined,
		data: isRecord(value.data) ? value.data : undefined,
	};
};

const operationNameFromPath = (capturePath: string) => capturePath.split("/").at(-1);

export const loadOperationCatalog = async (source = DEFAULT_CATALOG_URL): Promise<OperationCatalog> => {
	const text = await readCatalogSource(source);
	const captures = text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line, index) => {
			try {
				return parseCapture(JSON.parse(line));
			} catch (error) {
				throw new Error(`操作カタログの${index + 1}行目を解析できません`, { cause: error });
			}
		})
		.filter((capture): capture is GraphQlCapture => capture !== undefined);

	const required: OperationName[] = ["DeleteRetweet", "DeleteTweet", "TweetResultByRestId", "Viewer"];
	const result = {} as Partial<OperationCatalog>;
	for (const operationName of required) {
		const capture = captures.find((candidate) => operationNameFromPath(candidate.path) === operationName);
		if (!capture) throw new Error(`操作カタログに ${operationName} がありません`);
		result[operationName] = capture;
	}
	return result as OperationCatalog;
};

export const executeOperation = async (
	client: TwitterApiProfileClient,
	catalog: OperationCatalog,
	operationName: OperationName,
	variables: JsonRecord,
) => {
	const capture = catalog[operationName];
	if (capture.method === "GET") {
		return await client.dispatch({
			headers: capture.headers,
			method: "GET",
			params: { ...capture.params, variables: JSON.stringify(variables) },
			path: capture.path,
		});
	}

	return await client.dispatch({
		headers: capture.headers,
		method: "POST",
		data: { ...capture.data, variables },
		path: capture.path,
	});
};
