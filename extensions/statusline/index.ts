// pi-statusline：替换 pi 自带的底栏，并在输入框上方加一行，布局见 PLAN.md 第 2 节。
// 本文件是组合根：在会话开始时装上底栏与输入框上方的一行，接上刷新时机，会话结束时收尾。
//
// 生命周期：
//   - 只在交互界面（tui）里生效，`-p` 与 RPC 模式什么也不做。
//   - 每次 session_start 先收掉上一个会话的额度查询与定时器，再按新会话重新装。
//   - session_shutdown 中止进行中的额度请求并等它结束，清掉倒计时定时器与 MCP 连接的观察定时器。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, type ReadonlyFooterDataProvider, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CODEX_PROVIDER, QuotaPoller } from "./quota.ts";
import { type BottomData, renderBottom, renderTop, type TopData } from "./render.ts";
import { type EntryLike, enabledMcpServers, formatCwd, mcpShort, sanitizeStatus, sessionStats } from "./usage.ts";

/** 输入框上方那一行的组件键。 */
const WIDGET_KEY = "pi-statusline";

/**
 * pi-lsp 写状态用的键，与 pi-lsp 约定；它的状态改到右上角显示，底栏不再重复。
 * 没装 pi-lsp、非交互模式、或本机一个语言服务器都没有时，pi-lsp 不写这个键，右上角也就没有这一段，不需要另外探测。
 */
const LSP_STATUS_KEY = "zz-pi-lsp";

/** pi-openai-fast 通过标准 setStatus 写入的键，移到目录旁显示，底栏不再重复。 */
const FAST_STATUS_KEY = "openai-fast-mode";

/** 倒计时的刷新间隔；倒计时精确到分钟，一分钟刷一次就够。 */
const TICK_MS = 60_000;

/**
 * 会话开始后观察 MCP 连接数的间隔与时长：服务在后台连接，连上时界面不会自己重绘，靠观察到变化再重绘。
 * 30 秒后停止观察，之后的变化随其他刷新时机（每轮结束、倒计时）显示。
 * 不订阅 mcp_servers_change：pi 会把处理这个事件的扩展当成负责连接 MCP 的扩展。
 */
const MCP_WATCH_MS = 1000;
const MCP_WATCH_FOR_MS = 30_000;

/** pi 内置 MCP 扩展的路径；/mcp 命令来自它时才按内置 MCP 统计，被第三方扩展接管或关掉时不显示。 */
const BUILTIN_MCP_PATH = "builtin:mcp";

/** 安装环境信息行与会话底栏，复用扩展状态并在会话结束时释放资源。 */
export default function statusline(pi: ExtensionAPI) {
	let poller: QuotaPoller | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let mcpWatch: ReturnType<typeof setInterval> | undefined;
	/** 已启用的 MCP 服务（归一化后的名字），读配置文件得到，会话开始与每次 settle 时刷新。 */
	let mcpServers: string[] = [];
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

	/** 读不了或不是合法 JSON 时返回 undefined，按没有配置处理；pi 自己会报告配置错误。 */
	const readJson = (path: string): unknown => {
		try {
			return JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return undefined;
		}
	};

	const readMcpServers = (ctx: ExtensionContext) => {
		if (!pi.getCommands().some((c) => c.name === "mcp" && c.sourceInfo.path === BUILTIN_MCP_PATH)) {
			mcpServers = [];
			return;
		}
		const project = ctx.isProjectTrusted() ? readJson(join(ctx.cwd, ".pi", "mcp.json")) : undefined;
		mcpServers = enabledMcpServers(readJson(join(getAgentDir(), "mcp.json")), project, pi.getMcpServers().map((s) => s.name));
	};

	const mcpText = () => mcpShort(mcpServers, pi.getAllTools().map((t) => t.namespace?.name));

	const teardown = async () => {
		clearInterval(ticker);
		ticker = undefined;
		clearInterval(mcpWatch);
		mcpWatch = undefined;
		requestRender = undefined;
		await poller?.close();
		poller = undefined;
	};

	const topData = (ctx: ExtensionContext, data: ReadonlyFooterDataProvider, now: number): TopData => {
		const lsp = sanitizeStatus(data.getExtensionStatuses().get(LSP_STATUS_KEY) ?? "");
		return {
			cwd: formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE),
			branch: data.getGitBranch(),
			fast: sanitizeStatus(data.getExtensionStatuses().get(FAST_STATUS_KEY) ?? "") || undefined,
			mcp: mcpText(),
			lsp: lsp || undefined,
			quota: poller?.current(ctx.model?.provider),
			now,
		};
	};

	const bottomData = (ctx: ExtensionContext, data: ReadonlyFooterDataProvider): BottomData => {
		const model = ctx.model;
		const usage = ctx.getContextUsage();
		const statuses = [...data.getExtensionStatuses().entries()]
			.filter(([key]) => key !== LSP_STATUS_KEY && key !== FAST_STATUS_KEY)
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
		readMcpServers(ctx);
		let lastMcp = mcpText();
		const watchUntil = Date.now() + MCP_WATCH_FOR_MS;
		mcpWatch = setInterval(() => {
			const now = mcpText();
			if (now !== lastMcp) {
				lastMcp = now;
				requestRender?.();
			}
			if (Date.now() > watchUntil) clearInterval(mcpWatch);
		}, MCP_WATCH_MS);
		mcpWatch.unref?.();
		void current.refresh(ctx.model?.provider);
	});

	pi.on("model_select", (event) => {
		void poller?.refresh(event.model.provider);
		requestRender?.();
	});

	pi.on("agent_settled", (_event, ctx) => {
		readAutoCompact(ctx.cwd);
		readMcpServers(ctx);
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
