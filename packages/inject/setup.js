// ref: https://github.com/tsukumijima/KonomiTV/blob/master/server/static/zendriver_setup.js

(async () => {
	if (globalThis.elonmusk_114514_wait_startup) {
		return;
	}
	globalThis.elonmusk_114514_wait_startup = (() => {
		let resolveStartup;
		return {
			resolve: () => {
				if (resolveStartup) {
					resolveStartup();
					resolveStartup = null;
				}
			},
			promise: new Promise((resolve) => {
				resolveStartup = resolve;
			}),
		};
	})();

	const objectMocker = async (target, name) => {
		let value = target[name];

		return await new Promise((resolve) => {
			Object.defineProperty(target, name, {
				configurable: true,
				get: () => value,
				set(nextValue) {
					value = nextValue;
					Object.defineProperty(target, name, {
						configurable: true,
						writable: true,
						value: nextValue,
					});
					resolve(nextValue);
				},
			});
		});
	};

	let client = null;
	let stopInstrumentation = () => {};

	// リクエスト送信の直前に呼ばれるため、ここで API クライアントのインスタンスを確定する。
	// モジュールのエクスポートを差し替える方式と違い、アプリ側のオブジェクトを書き換えないため
	// webpack のモジュール解決に影響を与えない。
	const captureClient = (instance) => {
		if (client !== null) return;
		if (typeof instance?.graphQL !== "function" || typeof instance?.graphQLFullResponse !== "function") {
			return;
		}
		client = instance;
		globalThis.elonmusk_114514_wait_startup.resolve();
		stopInstrumentation();
		console.log("Twitter API client found");
	};

	globalThis.elonmusk_114514_request = async ({ property, query }) => {
		console.log(`Requesting ${property} with query:`, query);
		return client[property].apply(client, query);
	};

	const isClientClass = (candidate) =>
		typeof candidate === "function" &&
		candidate.prototype !== undefined &&
		typeof candidate.prototype.dispatch === "function" &&
		typeof candidate.prototype.get === "function" &&
		typeof candidate.prototype.post === "function" &&
		typeof candidate.prototype.delete === "function";

	const patchedClasses = new Set();
	const patchClientClass = (clientClass) => {
		if (patchedClasses.has(clientClass)) return;
		patchedClasses.add(clientClass);

		const prototype = clientClass.prototype;

		// dispatch は中継側のフックにも使うため、呼び出しの前後を包んで通知する。
		const originalDispatch = prototype.dispatch;
		prototype.dispatch = async function (...args) {
			captureClient(this);
			const requestAt = Date.now();
			const result = await originalDispatch.apply(this, args);
			const receivedAt = Date.now();
			if (globalThis.elonmusk_114514_hook) {
				const data = {
					request: args[0],
					response: result,
					requestAt,
					receivedAt,
				};
				return ((await globalThis.elonmusk_114514_hook(data)) ?? data).response;
			}
			return result;
		};

		// インスタンスの確定だけを目的に、残りの公開メソッドを素通しで包む。
		for (const method of ["graphQL", "graphQLFullResponse", "get", "post", "delete"]) {
			const original = prototype[method];
			if (typeof original !== "function") continue;
			prototype[method] = function (...args) {
				captureClient(this);
				return original.apply(this, args);
			};
		}
	};

	const chunkArray = await objectMocker(window, "webpackChunk_twitter_responsive_web");

	const originalPush = chunkArray.push;
	chunkArray.push = (chunk) => {
		const modules = chunk[1];
		if (modules && typeof modules === "object") {
			for (const moduleId of Object.keys(modules)) {
				const originalFactory = modules[moduleId];
				if (typeof originalFactory !== "function") continue;
				modules[moduleId] = function (module, _exports, _require) {
					const result = originalFactory.apply(this, arguments);
					try {
						if (module.exports === null || module.exports === undefined) return result;
						for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(module.exports))) {
							if (!descriptor.get) continue;
							let candidate;
							try {
								candidate = descriptor.get.call(module.exports);
							} catch {
								continue;
							}
							if (isClientClass(candidate)) patchClientClass(candidate);
						}
						if (isClientClass(module.exports)) patchClientClass(module.exports);
					} catch {}
					return result;
				};
			}
		}
		return originalPush(chunk);
	};
	stopInstrumentation = () => {
		chunkArray.push = originalPush;
	};
})();
