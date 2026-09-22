import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
// 直接导入 pi 自带底栏的实现做对照；这些文件不在包的公开导出里，只能按相对路径引用。
import { FooterComponent, formatCwdForFooter, formatTokens as builtinFormatTokens } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js";
import { initTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { formatCwd, formatTokens, mcpShort, sessionStats } from "../extensions/statusline/usage.ts";

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
		sessionManager: { getEntries: () => ENTRIES, getCwd: () => "/tmp", getSessionName: () => undefined },
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

test("MCP 简写：认得 pi-mcp-adapter 的完整与 compact 写法，认不出时返回整理过的原文", () => {
	assert.equal(mcpShort("🔌 MCP: 1 server enabled"), "MCP 0/1");
	assert.equal(mcpShort("MCP: 3 servers enabled (2 connected)"), "MCP 2/3");
	assert.equal(mcpShort("MCP: 2 servers enabled (1 connected) (1 disabled)"), "MCP 1/2");
	assert.equal(mcpShort("\x1b[38;5;110m🔌 MCP: 4 servers enabled (4 connected)\x1b[39m"), "MCP 4/4", "带颜色码");
	assert.equal(mcpShort("MCP 1/2"), "MCP 1/2", "compact 原文");
	assert.equal(mcpShort("MCP: connecting to probe...\n"), "MCP: connecting to probe...", "认不出时不猜数字");
});
