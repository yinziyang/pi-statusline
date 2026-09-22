import assert from "node:assert/strict";
import { test } from "node:test";
import { accountIdFromToken, fetchQuota, formatCountdown, MIN_INTERVAL_MS, parseQuota, QuotaPoller, windowLabel } from "../extensions/statusline/quota.ts";

const NOW = 1_790_000_000_000;

/** 真实接口返回的结构（数值是示意），只有周窗口。 */
const WEEKLY_ONLY = {
	plan_type: "pro",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: { used_percent: 22, limit_window_seconds: 604800, reset_after_seconds: 455153, reset_at: 1790526268 },
		secondary_window: null,
	},
};

/** 造一个带账号声明的 JWT，签名部分随便填。 */
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

test("解析：只有周窗口时只得到一个窗口，剩余与重置时刻正确", () => {
	assert.deepEqual(parseQuota(WEEKLY_ONLY, NOW), [{ label: "周", remaining: 78, resetsAt: NOW + 455153_000 }]);
});

test("解析：两个窗口都有；缺 reset_after_seconds 时用 reset_at；越界的百分比截到 0 到 100", () => {
	const body = {
		rate_limit: {
			primary_window: { used_percent: 36, limit_window_seconds: 18000, reset_at: 1790001000 },
			secondary_window: { used_percent: 130, limit_window_seconds: 604800 },
		},
	};
	assert.deepEqual(parseQuota(body, NOW), [
		{ label: "5h", remaining: 64, resetsAt: 1790001000_000 },
		{ label: "周", remaining: 0, resetsAt: undefined },
	]);
	assert.equal(parseQuota({ rate_limit: { primary_window: { used_percent: -5 } } }, NOW)?.[0].remaining, 100);
});

test("解析：格式不符返回 undefined，rate_limit 为 null 返回空数组，坏窗口跳过", () => {
	assert.equal(parseQuota(null, NOW), undefined);
	assert.equal(parseQuota({}, NOW), undefined);
	assert.equal(parseQuota({ rate_limit: "x" }, NOW), undefined);
	assert.deepEqual(parseQuota({ rate_limit: null }, NOW), []);
	assert.deepEqual(parseQuota({ rate_limit: { primary_window: { used_percent: "22" }, secondary_window: { used_percent: Number.NaN } } }, NOW), []);
});

test("窗口名与倒计时的写法", () => {
	assert.equal(windowLabel(604800), "周");
	assert.equal(windowLabel(18000), "5h");
	assert.equal(windowLabel(172800), "2d");
	assert.equal(windowLabel(undefined), "额度");
	assert.equal(formatCountdown(59_000), "1m");
	assert.equal(formatCountdown(59 * 60_000), "59m");
	assert.equal(formatCountdown((5 * 60 + 13) * 60_000), "5h13m");
	assert.equal(formatCountdown((5 * 24 + 6) * 3600_000 + 59_000), "5d6h");
	assert.equal(formatCountdown(0), undefined, "已过期");
	assert.equal(formatCountdown(-1), undefined);
});

test("账号 ID 从 token 的声明里取，不是 JWT 时返回 undefined", () => {
	assert.equal(accountIdFromToken(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } })), "acc-1");
	assert.equal(accountIdFromToken(jwt({})), undefined);
	assert.equal(accountIdFromToken("not-a-jwt"), undefined);
});

test("请求：带上 token 与账号 ID；非 200、网络错误、JSON 错误都返回 undefined", async () => {
	const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } });
	let seen: Record<string, string> = {};
	const ok = await fetchQuota(token, async (_url, init) => ((seen = init.headers), { ok: true, json: async () => WEEKLY_ONLY }), () => NOW);
	assert.equal(ok?.[0].remaining, 78);
	assert.equal(seen.Authorization, `Bearer ${token}`);
	assert.equal(seen["ChatGPT-Account-Id"], "acc-1");
	assert.equal(await fetchQuota(token, async () => ({ ok: false, json: async () => WEEKLY_ONLY }), () => NOW), undefined);
	assert.equal(await fetchQuota(token, async () => Promise.reject(new Error("net")), () => NOW), undefined);
	assert.equal(await fetchQuota(token, async () => ({ ok: true, json: async () => Promise.reject(new SyntaxError("bad json")) }), () => NOW), undefined);
});

test("请求：超时后放弃，返回 undefined", async () => {
	const hang = (_url: string, init: { signal: AbortSignal }) => new Promise<never>((_r, reject) => init.signal.addEventListener("abort", () => reject(new Error("timeout"))));
	const started = Date.now();
	assert.equal(await fetchQuota("t", hang, () => NOW, undefined, 20), undefined);
	assert.ok(Date.now() - started < 1_000);
});

/** 可控的轮询环境：时间手动推进，记录请求次数，请求可以挂起。 */
function pollerEnv(opts: { hang?: boolean; fail?: () => boolean } = {}) {
	const env = { now: NOW, calls: 0, changes: 0, aborted: false };
	const poller = new QuotaPoller({
		now: () => env.now,
		getToken: async () => "t",
		onChange: () => env.changes++,
		fetch: (_url, init) => {
			env.calls++;
			if (opts.fail?.()) return Promise.resolve({ ok: false, json: async () => ({}) });
			if (!opts.hang) return Promise.resolve({ ok: true, json: async () => WEEKLY_ONLY });
			return new Promise((_resolve, reject) =>
				init.signal.addEventListener("abort", () => {
					env.aborted = true;
					reject(new Error("aborted"));
				}),
			);
		},
	});
	return { env, poller };
}

test("查询时机：非 codex 不请求；30 秒内不重复；非 codex 模型不显示缓存的结果", async () => {
	const { env, poller } = pollerEnv();
	await poller.refresh("anthropic");
	assert.equal(env.calls, 0);
	await poller.refresh("openai-codex");
	assert.equal(env.calls, 1);
	assert.equal(env.changes, 1);
	assert.equal(poller.current("openai-codex")?.[0].remaining, 78);
	assert.equal(poller.current("anthropic"), undefined);
	env.now += MIN_INTERVAL_MS - 1;
	await poller.refresh("openai-codex");
	assert.equal(env.calls, 1, "30 秒内不重复请求");
	env.now += 1;
	await poller.refresh("openai-codex");
	assert.equal(env.calls, 2);
	await poller.close();
});

test("查询失败时保留上一次的结果", async () => {
	let fail = false;
	const { env, poller } = pollerEnv({ fail: () => fail });
	await poller.refresh("openai-codex");
	fail = true;
	env.now += MIN_INTERVAL_MS;
	await poller.refresh("openai-codex");
	assert.equal(env.calls, 2);
	assert.equal(poller.current("openai-codex")?.[0].remaining, 78);
	await poller.close();
});

test("收尾：close 中止进行中的请求并等它结束，之后不再请求、不再回调；可以重复调用", async () => {
	const { env, poller } = pollerEnv({ hang: true });
	void poller.refresh("openai-codex");
	await new Promise((r) => setImmediate(r));
	assert.equal(env.calls, 1);
	await poller.close();
	assert.equal(env.aborted, true);
	assert.equal(env.changes, 0);
	env.now += MIN_INTERVAL_MS * 2;
	await poller.refresh("openai-codex");
	assert.equal(env.calls, 1, "关闭后不再请求");
	await poller.close();
});

test("没登录（拿不到 token）时不请求", async () => {
	let calls = 0;
	const poller = new QuotaPoller({ now: () => NOW, getToken: async () => undefined, onChange: () => {}, fetch: async () => (calls++, { ok: true, json: async () => WEEKLY_ONLY }) });
	await poller.refresh("openai-codex");
	assert.equal(calls, 0);
	assert.equal(poller.current("openai-codex"), undefined);
	await poller.close();
});
