// pi-statusline：替换 pi 自带的底栏，并在输入框上方加一行，布局见 PLAN.md 第 2 节。
// 本文件是组合根：在会话开始时装上底栏与输入框上方的一行，接上刷新时机，会话结束时收尾。
//
// 生命周期：
//   - 只在交互界面（tui）里生效，`-p` 与 RPC 模式什么也不做。
//   - 每次 session_start 先收掉上一个会话的额度查询与定时器，再按新会话重新装。
//   - session_shutdown 中止进行中的额度请求并等它结束，清掉倒计时定时器。

import { type ExtensionAPI, type ExtensionContext, getAgentDir, type ReadonlyFooterDataProvider, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CODEX_PROVIDER, QuotaPoller } from "./quota.ts";
import { type BottomData, renderBottom, renderTop, type TopData } from "./render.ts";
import { type EntryLike, formatCwd, mcpShort, sanitizeStatus, sessionStats } from "./usage.ts";

/** 输入框上方那一行的组件键。 */
const WIDGET_KEY = "pi-statusline";

/** pi-mcp-adapter 写状态用的键；它的状态改到右上角显示，底栏不再重复。 */
const MCP_STATUS_KEY = "mcp";

/** 倒计时的刷新间隔；倒计时精确到分钟，一分钟刷一次就够。 */
const TICK_MS = 60_000;

export default function statusline(pi: ExtensionAPI) {
	let poller: QuotaPoller | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let requestRender: (() => void) | undefined;
	/** 自动压缩是否开启。扩展接口拿不到会话里的实时值，只能读设置文件，见 PLAN.md 第 3 节。 */
	let autoCompact = true;

	const readAutoCompact = (cwd: string) => {
		try {
			autoCompact = SettingsManager.create(cwd, getAgentDir()).getCompactionEnabled();
		} catch {
			// 设置文件读不了时沿用上一次的值，只影响 auto 标记。
		}
	};

	const teardown = async () => {
		clearInterval(ticker);
		ticker = undefined;
		requestRender = undefined;
		await poller?.close();
		poller = undefined;
	};

	const topData = (ctx: ExtensionContext, data: ReadonlyFooterDataProvider, now: number): TopData => {
		const mcp = data.getExtensionStatuses().get(MCP_STATUS_KEY);
		return {
			cwd: formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE),
			branch: data.getGitBranch(),
			mcp: mcp ? mcpShort(mcp) : undefined,
			quota: poller?.current(ctx.model?.provider),
			now,
		};
	};

	const bottomData = (ctx: ExtensionContext, data: ReadonlyFooterDataProvider): BottomData => {
		const model = ctx.model;
		const usage = ctx.getContextUsage();
		const statuses = [...data.getExtensionStatuses().entries()]
			.filter(([key]) => key !== MCP_STATUS_KEY)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatus(text))
			.filter(Boolean);
		return {
			model: model ? { id: model.id, reasoning: Boolean(model.reasoning) } : undefined,
			thinking: pi.getThinkingLevel(),
			context: { percent: usage?.percent ?? null, tokens: usage?.tokens ?? null, window: usage?.contextWindow ?? model?.contextWindow ?? 0 },
			autoCompact,
			stats: sessionStats(ctx.sessionManager.getEntries() as unknown as EntryLike[]),
			// 与自带底栏一致：Kimi Coding 用 API key 认证，但也是订阅。
			subscription: model ? model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(model) : false,
			statuses,
		};
	};

	/** 渲染出错时返回空行：会话被替换后旧的 ctx 会失效，界面在收尾前可能还会重绘一次。 */
	const safe = (fn: () => string[]): string[] => {
		try {
			return fn();
		} catch {
			return [];
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		await teardown();
		if (ctx.mode !== "tui") return;
		readAutoCompact(ctx.cwd);
		const current = new QuotaPoller({
			fetch: (url, init) => fetch(url, init),
			now: Date.now,
			getToken: () => ctx.modelRegistry.getApiKeyForProvider(CODEX_PROVIDER),
			onChange: () => requestRender?.(),
		});
		poller = current;
		let footerData: ReadonlyFooterDataProvider | undefined;
		ctx.ui.setFooter((tui, theme, data) => {
			footerData = data;
			requestRender = () => tui.requestRender();
			const unsubscribe = data.onBranchChange(() => tui.requestRender());
			return {
				render: (width: number) => safe(() => renderBottom(bottomData(ctx, data), width, theme)),
				invalidate() {},
				dispose: unsubscribe,
			};
		});
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => ({
				render: (width: number) => safe(() => (footerData ? renderTop(topData(ctx, footerData, Date.now()), width, theme) : [])),
				invalidate() {},
			}),
			{ placement: "aboveEditor" },
		);
		ticker = setInterval(() => requestRender?.(), TICK_MS);
		ticker.unref?.();
		void current.refresh(ctx.model?.provider);
	});

	pi.on("model_select", (event) => {
		void poller?.refresh(event.model.provider);
		requestRender?.();
	});

	pi.on("agent_settled", (_event, ctx) => {
		readAutoCompact(ctx.cwd);
		void poller?.refresh(ctx.model?.provider);
		requestRender?.();
	});

	// 这几个时刻底栏的数字会变，界面不一定自己重绘。
	const rerender = () => requestRender?.();
	pi.on("message_end", rerender);
	pi.on("turn_end", rerender);
	pi.on("thinking_level_select", rerender);
	pi.on("session_compact", rerender);

	pi.on("session_shutdown", async () => {
		await teardown();
	});
}
