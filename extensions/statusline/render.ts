// 把各段数据排成行：输入框上方的一行与底栏。纯函数，不碰 pi 的会话对象，颜色经传入的主题取。
//
// 窄屏时按固定顺序省略次要信息，任何一行的可见宽度都不超过终端宽度：
//   - 输入框上方：先从开头省略目录（保留末尾的项目名与分支）；仍放不下时先省略额度的「后重置」，再省略 LSP 状态，再省略 MCP。
//   - 底栏第 1 行：先省略费用，再省略 token 统计，再省略思考等级；仍放不下时截断并加「...」。

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCountdown, type QuotaWindow } from "./quota.ts";
import { formatTokens, type SessionStats } from "./usage.ts";

/** 主题里本模块用到的部分；颜色名是 pi 主题的语义颜色，未知颜色会抛错。 */
export interface ThemeLike {
	fg(color: string, text: string): string;
}

/** 输入框上方一行的数据。 */
export interface TopData {
	/** 已经换成 `~` 开头的目录。 */
	cwd: string;
	branch: string | null;
	/** MCP 简写，例如 `MCP 0/1`；没配 MCP 时为 undefined。 */
	mcp?: string;
	/** pi-lsp 写入的状态，已带它自己的颜色，例如绿色的 `LSP gopls ✓`；没装 pi-lsp 时为 undefined。 */
	lsp?: string;
	/** codex 额度窗口；不是 codex 模型或没查到时为 undefined。 */
	quota?: QuotaWindow[];
	now: number;
}

/** 底栏的数据。 */
export interface BottomData {
	model?: { id: string; reasoning: boolean };
	thinking: string;
	/** 上下文；percent 或 tokens 为 null 表示未知（例如刚压缩完）。 */
	context?: { percent: number | null; tokens: number | null; window: number };
	autoCompact: boolean;
	stats: SessionStats;
	/** 订阅登录时费用只是折算，后面加 `sub`。 */
	subscription: boolean;
	/** 其他扩展的状态，已按键名排好、去掉了换行。 */
	statuses: string[];
}

/** 上下文条的格数。 */
const BAR_CELLS = 10;

/** 左右两段之间至少留的空格数。 */
const MIN_GAP = 2;

/** 左侧至少保留的列数，再窄就开始省略右侧；分支名很长时至少还要给路径留 PATH_KEEP 列。 */
const MIN_LEFT = 16;
const PATH_KEEP = 10;

export function renderTop(d: TopData, width: number, t: ThemeLike): string[] {
	const branch = d.branch ? ` (${d.branch})` : "";
	const left = (room: number) => t.fg("dim", shortenPath(d.cwd, room - visibleWidth(branch)) + branch);
	const minLeft = Math.min(visibleWidth(d.cwd + branch), Math.max(MIN_LEFT, visibleWidth(branch) + PATH_KEEP));
	const sep = t.fg("borderMuted", " │ ");
	const quota = (withReset: boolean) =>
		(d.quota ?? []).length
			? t.fg("dim", "codex ") +
				(d.quota ?? [])
					.map((w) => {
						const countdown = w.resetsAt === undefined ? undefined : formatCountdown(w.resetsAt - d.now);
						const reset = countdown ? t.fg("dim", ` · ${countdown}${withReset ? " 后重置" : ""}`) : "";
						return t.fg("dim", `${w.label}余 `) + t.fg(quotaColor(w.remaining), `${Math.round(w.remaining)}%`) + reset;
					})
					.join(sep)
			: "";
	const join = (...parts: string[]) => parts.filter(Boolean).join(sep);
	const mcp = d.mcp ? t.fg("dim", d.mcp) : "";
	// pi-lsp 的状态自带颜色（运行中的服务器是绿色），原样放在最前；窄屏时先于 MCP 省略。
	const lsp = d.lsp ?? "";
	const candidates = [join(lsp, mcp, quota(true)), join(lsp, mcp, quota(false)), join(mcp, quota(false)), quota(false), ""];
	for (const right of candidates) {
		if (!right) return [truncateToWidth(left(width), width, t.fg("dim", "..."))];
		const room = width - visibleWidth(right) - MIN_GAP;
		if (room >= minLeft) return [spread(truncateToWidth(left(room), room, t.fg("dim", "...")), right, width)];
	}
	return [];
}

export function renderBottom(d: BottomData, width: number, t: ThemeLike): string[] {
	const sep = t.fg("borderMuted", " │ ");
	const model = t.fg("accent", `◆ ${d.model?.id ?? "no-model"}`);
	const thinking = d.model?.reasoning ? t.fg(thinkingColor(d.thinking, t), `⚡${d.thinking}`) : "";
	const ctx = contextSegment(d, t);
	const { totals, cacheHitRate } = d.stats;
	const statParts: string[] = [];
	if (totals.input) statParts.push(`↑${formatTokens(totals.input)}`);
	if (totals.output) statParts.push(`↓${formatTokens(totals.output)}`);
	if (totals.cacheRead) statParts.push(`R${formatTokens(totals.cacheRead)}`);
	if (totals.cacheWrite) statParts.push(`W${formatTokens(totals.cacheWrite)}`);
	if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && cacheHitRate !== undefined) statParts.push(`CH${cacheHitRate.toFixed(1)}%`);
	const stats = statParts.length ? t.fg("dim", statParts.join(" ")) : "";
	const cost = totals.cost || d.subscription ? t.fg("dim", `$${totals.cost.toFixed(3)}${d.subscription ? " sub" : ""}`) : "";

	const leftWith = (withThinking: boolean) => (withThinking && thinking ? `${model}  ${thinking}` : model) + sep + ctx;
	const attempts: Array<[string, string]> = [
		[leftWith(true), [stats, cost].filter(Boolean).join("  ")],
		[leftWith(true), stats],
		[leftWith(true), ""],
		[leftWith(false), ""],
	];
	let line: string | undefined;
	for (const [left, right] of attempts) {
		const need = visibleWidth(left) + (right ? MIN_GAP + visibleWidth(right) : 0);
		if (need <= width) {
			line = right ? spread(left, right, width) : left;
			break;
		}
	}
	const lines = [line ?? truncateToWidth(leftWith(false), width, t.fg("dim", "..."))];
	if (d.statuses.length) lines.push(truncateToWidth(t.fg("dim", d.statuses.join("  ")), width, t.fg("dim", "...")));
	return lines;
}

function contextSegment(d: BottomData, t: ThemeLike): string {
	const window = d.context?.window ?? 0;
	const pct = d.context?.percent ?? null;
	const tokens = d.context?.tokens ?? null;
	const auto = d.autoCompact ? t.fg("dim", " auto") : "";
	const usage = t.fg("dim", ` ${tokens === null ? "?" : formatTokens(tokens)}/${formatTokens(window)}`);
	if (pct === null) return t.fg("borderMuted", "░".repeat(BAR_CELLS)) + t.fg("dim", " ?") + usage + auto;
	const color = contextColor(pct);
	const filled = Math.min(BAR_CELLS, Math.max(0, Math.round((pct / 100) * BAR_CELLS)));
	return t.fg(color, "▓".repeat(filled)) + t.fg("borderMuted", "░".repeat(BAR_CELLS - filled)) + t.fg(color, ` ${pct.toFixed(1)}%`) + usage + auto;
}

/** 上下文颜色，阈值与自带底栏一致：超过 90% 红，超过 70% 黄。 */
export function contextColor(percent: number): string {
	if (percent > 90) return "error";
	if (percent > 70) return "warning";
	return "success";
}

/** 额度颜色：剩余低于 10% 红，低于 30% 黄，其余不上色。 */
export function quotaColor(remaining: number): string {
	if (remaining < 10) return "error";
	if (remaining < 30) return "warning";
	return "muted";
}

/** 思考等级的颜色，用主题里各等级自带的颜色；`max` 在主题没有定义 thinkingMax 时退回 thinkingXhigh。 */
function thinkingColor(level: string, t: ThemeLike): string {
	const name = `thinking${level.charAt(0).toUpperCase()}${level.slice(1)}`;
	try {
		t.fg(name, "");
		return name;
	} catch {
		return level === "max" ? "thinkingXhigh" : "dim";
	}
}

/** 路径放不下时从开头省略，保留末尾，例如 `…/piagent/e2e`；room 太小时只保留末尾能放下的部分。 */
export function shortenPath(path: string, room: number): string {
	if (visibleWidth(path) <= room) return path;
	if (room <= 1) return "…";
	const chars = [...path];
	let tail = "";
	for (let i = chars.length - 1; i >= 0 && visibleWidth(`…${chars[i]}${tail}`) <= room; i--) tail = chars[i] + tail;
	return `…${tail}`;
}

/** 左段靠左、右段靠右，中间用空格填满到 width。调用方保证两段放得下。 */
function spread(left: string, right: string, width: number): string {
	const pad = Math.max(MIN_GAP, width - visibleWidth(left) - visibleWidth(right));
	return `${left}${" ".repeat(pad)}${right}`;
}
