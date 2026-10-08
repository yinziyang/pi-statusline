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

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** 服务名的归一化写法：pi 把只差 `-` 与 `_` 的名字当成同一个服务，工具命名空间 `mcp__<服务>` 也按这个写法。 */
function mcpKey(name: string): string {
	return name.replace(/-/g, "_");
}

/** mcp.json 内容里的服务条目；结构不对（文件损坏、字段类型不对）时当作没有条目，pi 自己会报告配置错误。 */
function mcpEntries(config: unknown): Array<[string, JsonObject]> {
	const servers = isObject(config) ? config.mcpServers : undefined;
	if (!isObject(servers)) return [];
	return Object.entries(servers).filter((entry): entry is [string, JsonObject] => isObject(entry[1]));
}

/**
 * 按 pi 文档 mcp.md 的配置规则，算出已启用的 MCP 服务，返回归一化后的名字。
 * - global、project 是两份 mcp.json 解析后的内容，项目文件只在项目受信任时传入。
 * - 项目条目带 command、url 或 type 时替换同名的全局服务。
 * - 项目条目不带这些字段时只覆盖同名全局服务的 enabled，没有同名全局服务时不算服务。
 * - registered 是扩展用 pi.registerMcpServer 注册的服务名，与配置文件同名时以配置文件为准。
 * - enabled 为 false 的不算。
 */
export function enabledMcpServers(global: unknown, project: unknown, registered: readonly string[]): string[] {
	const servers = new Map<string, JsonObject>();
	for (const [name, entry] of mcpEntries(global)) servers.set(mcpKey(name), entry);
	for (const [name, entry] of mcpEntries(project)) {
		const key = mcpKey(name);
		const base = servers.get(key);
		if ("command" in entry || "url" in entry || "type" in entry) servers.set(key, entry);
		else if (base && "enabled" in entry) servers.set(key, { ...base, enabled: entry.enabled });
	}
	for (const name of registered) if (!servers.has(mcpKey(name))) servers.set(mcpKey(name), {});
	return [...servers].filter(([, entry]) => entry.enabled !== false).map(([key]) => key);
}

/**
 * 右上角的 MCP 简写 `MCP 已连接/已启用`，没有启用的服务时返回 undefined，整段不显示。
 * pi 内置的 MCP 在服务连上之后才注册它的工具，工具的命名空间是 `mcp__<服务>`，所以有工具的服务算已连接。
 * 简化：连上但一个工具都没有的服务算未连接，断线后工具仍保留时算已连接；pi 公开连接状态的接口后改为直接读状态。
 * @param namespaces 当前全部工具的命名空间名，没有命名空间的工具传 undefined。
 */
export function mcpShort(enabled: readonly string[], namespaces: Iterable<string | undefined>): string | undefined {
	if (enabled.length === 0) return undefined;
	const connected = new Set<string>();
	for (const name of namespaces) if (name?.startsWith("mcp__")) connected.add(name.slice("mcp__".length));
	return `MCP ${enabled.filter((key) => connected.has(key)).length}/${enabled.length}`;
}
