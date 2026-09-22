// 会话统计与状态文字的整理，全部是纯函数。
// token、缓存、费用的累加范围与格式照 pi 0.87 自带底栏（modes/interactive/components/footer.js），两边的数值必须一致。

import { isAbsolute, relative, resolve, sep } from "node:path";

/** 一次会话累计的用量。 */
export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** 按 API 标价折算的美元。 */
	cost: number;
}

/** 会话统计：累计用量与最近一次请求的缓存命中率（百分比，没有时为 undefined）。 */
export interface SessionStats {
	totals: UsageTotals;
	cacheHitRate?: number;
}

/** 用量字段的最小结构，与 pi 的 Usage 兼容。 */
interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

/** 会话条目里用到的最小结构，与 pi 的 SessionEntry 兼容。 */
export interface EntryLike {
	type: string;
	usage?: UsageLike;
	message?: { role: string; usage?: UsageLike };
}

/**
 * 从全部会话条目累加用量，范围与自带底栏一致：
 *   - 助手消息与带用量的工具结果（前台 subagent 的用量记在工具结果上）。
 *   - `usage` 条目。
 *   - 带用量的压缩与分支摘要。
 * 缓存命中率只看最后一条助手消息。
 */
export function sessionStats(entries: readonly EntryLike[]): SessionStats {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let cacheHitRate: number | undefined;
	const add = (u: UsageLike | undefined) => {
		if (!u) return;
		totals.input += u.input;
		totals.output += u.output;
		totals.cacheRead += u.cacheRead;
		totals.cacheWrite += u.cacheWrite;
		totals.cost += u.cost.total;
	};
	for (const e of entries) {
		if (e.type === "usage") add(e.usage);
		else if (e.type === "message" && e.message?.role === "assistant" && e.message.usage) {
			const u = e.message.usage;
			add(u);
			const prompt = u.input + u.cacheRead + u.cacheWrite;
			cacheHitRate = prompt > 0 ? (u.cacheRead / prompt) * 100 : undefined;
		} else if (e.type === "message" && e.message?.role === "toolResult") add(e.message.usage);
		else if (e.type === "branch_summary" || e.type === "compaction") add(e.usage);
	}
	return { totals, cacheHitRate };
}

/** token 数的短写法，与自带底栏的 formatTokens 逐字一致。 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** 目录显示：家目录内的路径换成 `~` 开头，与自带底栏的 formatCwdForFooter 一致。 */
export function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

/** 去掉换行、制表符与多余空格，与自带底栏处理扩展状态的方式一致。 */
export function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

// 匹配终端颜色控制序列，解析状态原文前先去掉。
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * pi-mcp-adapter 状态文字的简写：`MCP 已连接/已启用`。
 * 能识别它的两种原文：完整写法「N server(s) enabled (M connected) (K disabled)」与 compact 写法「MCP M/N」。
 * 认不出时返回整理过的原文，不猜数字。
 */
export function mcpShort(text: string): string {
	const plain = sanitizeStatus(text.replace(ANSI, ""));
	const compact = /\bMCP (\d+)\/(\d+)\b/.exec(plain);
	if (compact) return `MCP ${compact[1]}/${compact[2]}`;
	const enabled = /(\d+) servers? enabled/.exec(plain);
	if (!enabled) return plain;
	const connected = /\((\d+) connected\)/.exec(plain);
	return `MCP ${connected ? connected[1] : "0"}/${enabled[1]}`;
}
