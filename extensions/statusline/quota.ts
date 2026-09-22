// codex 订阅额度：请求 ChatGPT 的用量接口，解析出每个额度窗口的剩余百分比与重置时刻。
//
// 这是 Codex 客户端自用的内部接口（与 @pi-plugins/usage 用的是同一个），格式可能变化。
// 任何一步失败都返回 undefined，由调用方整段不显示，不向用户报错。
// fetch 与当前时间由调用方传入，测试时替换。

/** codex 在 pi 里的 provider 名。 */
export const CODEX_PROVIDER = "openai-codex";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** 单次请求的上限；超过后放弃这一次，界面保留上一次的结果。 */
export const REQUEST_TIMEOUT_MS = 10_000;

/** 两次请求之间的最小间隔。 */
export const MIN_INTERVAL_MS = 30_000;

/** 一个额度窗口。 */
export interface QuotaWindow {
	/** 显示用的名字：约一周为「周」，否则按小时写成「5h」这类。 */
	label: string;
	/** 剩余百分比，0 到 100。 */
	remaining: number;
	/** 重置时刻，毫秒时间戳；接口没给时为 undefined。 */
	resetsAt?: number;
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * 请求一次额度。
 * token 是 codex 的 access token；账号 ID 从 token 的声明里取，取不到时不带这个请求头。
 * signal 触发或超过 timeoutMs（默认 REQUEST_TIMEOUT_MS）时放弃，返回 undefined。
 */
export async function fetchQuota(token: string, fetchImpl: Fetch, now: () => number, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<QuotaWindow[] | undefined> {
	const timeout = AbortSignal.timeout(timeoutMs);
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	const accountId = accountIdFromToken(token);
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;
	try {
		const res = await fetchImpl(USAGE_URL, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
		if (!res.ok) return undefined;
		return parseQuota(await res.json(), now());
	} catch {
		// 网络错误、超时、中止、JSON 错误都按「这次没查到」处理。
		return undefined;
	}
}

/** 解析接口返回；结构不符时返回 undefined，一个窗口都没有时返回空数组。 */
export function parseQuota(body: unknown, now: number): QuotaWindow[] | undefined {
	const limit = (body as { rate_limit?: unknown } | null)?.rate_limit;
	if (limit === null) return [];
	if (!limit || typeof limit !== "object") return undefined;
	const out: QuotaWindow[] = [];
	for (const key of ["primary_window", "secondary_window"] as const) {
		const w = (limit as Record<string, unknown>)[key] as Record<string, unknown> | null | undefined;
		if (!w || typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent)) continue;
		const remaining = Math.min(100, Math.max(0, 100 - w.used_percent));
		let resetsAt: number | undefined;
		if (typeof w.reset_after_seconds === "number") resetsAt = now + w.reset_after_seconds * 1000;
		else if (typeof w.reset_at === "number") resetsAt = w.reset_at * 1000;
		out.push({ label: windowLabel(w.limit_window_seconds), remaining, resetsAt });
	}
	return out;
}

/** 窗口名：六天以上算「周」，其余按小时取整；长度未知时叫「额度」。 */
export function windowLabel(seconds: unknown): string {
	if (typeof seconds !== "number" || seconds <= 0) return "额度";
	if (seconds >= 6 * 86_400) return "周";
	if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
	return `${Math.round(seconds / 3600)}h`;
}

/** 距离重置的时长：不足 1 分钟写「1m」，不足 1 小时写分钟，不足 1 天写时分，否则写天时；已过期写 undefined。 */
export function formatCountdown(ms: number): string | undefined {
	if (ms <= 0) return undefined;
	const minutes = Math.max(1, Math.floor(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** 从 JWT 的 `https://api.openai.com/auth` 声明取 chatgpt_account_id；不是 JWT 或没有这个声明时返回 undefined。 */
export function accountIdFromToken(token: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
		const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}

/** 额度轮询的依赖，测试时替换。 */
export interface QuotaDeps {
	fetch: Fetch;
	now: () => number;
	/** 取 codex 的 access token；没登录时返回 undefined。 */
	getToken: () => Promise<string | undefined>;
	/** 有新结果时调用，用来刷新界面。 */
	onChange: () => void;
}

/**
 * 额度的缓存与查询时机：只查 codex，两次请求至少间隔 MIN_INTERVAL_MS，同一时刻只有一个请求在飞。
 * close() 中止进行中的请求并等它结束，之后不再请求、不再回调，可以重复调用。
 */
export class QuotaPoller {
	private windows: QuotaWindow[] | undefined;
	private lastAttempt = Number.NEGATIVE_INFINITY;
	private inFlight: Promise<void> | undefined;
	private readonly controller = new AbortController();
	private readonly deps: QuotaDeps;

	constructor(deps: QuotaDeps) {
		this.deps = deps;
	}

	/** 当前 provider 下要显示的窗口；不是 codex 时为 undefined。 */
	current(provider: string | undefined): QuotaWindow[] | undefined {
		return provider === CODEX_PROVIDER ? this.windows : undefined;
	}

	/** 需要时发起一次查询；返回的 Promise 只供测试等待，调用方不必等。 */
	refresh(provider: string | undefined): Promise<void> {
		if (provider !== CODEX_PROVIDER || this.controller.signal.aborted || this.inFlight) return this.inFlight ?? Promise.resolve();
		if (this.deps.now() - this.lastAttempt < MIN_INTERVAL_MS) return Promise.resolve();
		this.lastAttempt = this.deps.now();
		this.inFlight = (async () => {
			try {
				const token = await this.deps.getToken();
				if (!token || this.controller.signal.aborted) return;
				const result = await fetchQuota(token, this.deps.fetch, this.deps.now, this.controller.signal);
				// 这次没查到时保留上一次的结果，倒计时仍按原来的重置时刻走。
				if (result === undefined || this.controller.signal.aborted) return;
				this.windows = result;
				this.deps.onChange();
			} catch {
				// 取 token 失败按没登录处理。
			} finally {
				this.inFlight = undefined;
			}
		})();
		return this.inFlight;
	}

	async close(): Promise<void> {
		this.controller.abort();
		await this.inFlight;
	}
}
