import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
// 直接导入 pi 自带底栏的实现做对照；这些文件不在包的公开导出里，只能按相对路径引用。
import { FooterComponent, formatCwdForFooter, formatTokens as builtinFormatTokens } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js";
import { initTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { enabledMcpServers, formatCwd, formatTokens, mcpShort, sessionStats } from "../extensions/statusline/usage.ts";

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) => ({ input, output, cacheRead, cacheWrite, cost: { total: cost } });

/** 覆盖全部累加范围的一组会话条目。 */
const ENTRIES = [
	{ type: "message", message: { role: "user" } },
	{ type: "message", message: { role: "assistant", usage: usage(1200, 300, 8000, 500, 0.012) } },
	{ type: "message", message: { role: "toolResult", usage: usage(4000, 900, 0, 0, 0.03) } },
	{ type: "message", message: { role: "toolResult" } },
	{ type: "usage", usage: usage(100, 20, 0, 0, 0.001) },
	{ type: "compaction", usage: usage(9000, 700, 0, 0, 0.05) },
	{ type: "branch_summary", usage: usage(50, 10, 0, 0, 0.0005) },
	{ type: "custom", customType: "x" },
	{ type: "message", message: { role: "assistant", usage: usage(300, 80, 91000, 0, 0.02) } },
];

test("formatTokens 与自带底栏逐字一致", () => {
	for (const n of [0, 1, 999, 1000, 1049, 9999, 10000, 99_499, 999_999, 1_000_000, 9_999_999, 10_000_000, 123_456_789]) {
		assert.equal(formatTokens(n), builtinFormatTokens(n), `n=${n}`);
	}
});

test("目录显示与自带底栏一致", () => {
	for (const [cwd, home] of [["/Users/a/p", "/Users/a"], ["/Users/a", "/Users/a"], ["/Users/ab/p", "/Users/a"], ["/tmp/x", "/Users/a"], ["/tmp/x", undefined]] as const) {
		assert.equal(formatCwd(cwd, home), formatCwdForFooter(cwd, home));
	}
});

test("会话统计：↑↓RW、缓存命中率、费用与自带底栏的输出一致", () => {
	initTheme("dark");
	const model = { id: "m", provider: "p", contextWindow: 272_000, reasoning: false };
	const session = {
		state: { model },
		sessionManager: { getEntries: () => ENTRIES, getEntryCount: () => ENTRIES.length, getSessionId: () => "s", getLeafId: () => null, getCwd: () => "/tmp", getSessionName: () => undefined },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 272_000, percent: 0.4 }),
		modelRuntime: { isUsingSubscription: () => false },
	};
	const footerData = { getGitBranch: () => null, getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1 };
	const builtin = stripVTControlCharacters(new FooterComponent(session, footerData).render(200)[1]);
	const { totals, cacheHitRate } = sessionStats(ENTRIES);
	const ours = [`↑${formatTokens(totals.input)}`, `↓${formatTokens(totals.output)}`, `R${formatTokens(totals.cacheRead)}`, `W${formatTokens(totals.cacheWrite)}`, `CH${cacheHitRate?.toFixed(1)}%`, `$${totals.cost.toFixed(3)}`].join(" ");
	assert.ok(builtin.startsWith(`${ours} `), `自带：${builtin}\n本包：${ours}`);
	assert.equal(cacheHitRate?.toFixed(1), ((91000 / 91300) * 100).toFixed(1), "命中率只看最后一条助手消息");
});

test("没有助手消息时没有缓存命中率；最后一条的提示为 0 时命中率清空", () => {
	assert.equal(sessionStats([]).cacheHitRate, undefined);
	const s = sessionStats([ENTRIES[1], { type: "message", message: { role: "assistant", usage: usage(0, 5, 0, 0, 0) } }]);
	assert.equal(s.cacheHitRate, undefined);
	assert.equal(s.totals.output, 305);
});

test("已启用的 MCP 服务：按 pi 的配置规则合并全局、项目与扩展注册的服务", () => {
	const global = { mcpServers: { docs: { url: "https://x/mcp" }, "dev-radius": { command: "r" }, off: { command: "o", enabled: false }, probe: { command: "p" } } };
	assert.deepEqual(enabledMcpServers(global, undefined, []), ["docs", "dev_radius", "probe"], "enabled 为 false 的不算，名字里的 - 归一化成 _");
	const project = { mcpServers: { probe: { enabled: false }, off: { enabled: true }, local: { command: "l" }, orphan: { enabled: true }, docs: { command: "d", enabled: false } } };
	assert.deepEqual(enabledMcpServers(global, project, []), ["dev_radius", "off", "local"], "覆盖条目只改 enabled，带 command 的条目整体替换，没有同名全局服务的覆盖条目不算");
	assert.deepEqual(enabledMcpServers(global, undefined, ["dev_radius", "jira"]), ["docs", "dev_radius", "probe", "jira"], "扩展注册的服务与配置同名时以配置为准");
	assert.deepEqual(enabledMcpServers(undefined, undefined, []), []);
	for (const bad of ["oops", [1, 2], null, { mcpServers: [] }, { mcpServers: { x: "str" } }]) assert.deepEqual(enabledMcpServers(bad, bad, []), [], `结构不对时当作没有配置：${JSON.stringify(bad)}`);
});

test("MCP 简写：有工具命名空间的已启用服务算已连接；没有启用的服务时不显示", () => {
	assert.equal(mcpShort([], ["mcp__probe"]), undefined);
	assert.equal(mcpShort(["probe", "dev_radius", "docs"], [undefined, "mcp__probe", "mcp__probe", "mcp__dev_radius", "mcp__other", "lsp"]), "MCP 2/3", "同一服务的多个工具只算一次，未启用服务的工具不算");
	assert.equal(mcpShort(["probe"], []), "MCP 0/1", "还没连上");
});
