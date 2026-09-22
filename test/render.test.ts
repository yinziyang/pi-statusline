import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type BottomData, contextColor, quotaColor, renderBottom, renderTop, shortenPath, type TopData } from "../extensions/statusline/render.ts";

/** 假主题：每个颜色名对应一个 256 色号，未知颜色抛错，与 pi 的 Theme 行为一致；没有 thinkingMax，用来测退回。 */
const COLORS = ["dim", "borderMuted", "accent", "success", "warning", "error", "muted", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh"];
const theme = {
	fg(color: string, text: string) {
		const i = COLORS.indexOf(color);
		if (i < 0) throw new Error(`Unknown theme color: ${color}`);
		return `\x1b[38;5;${i}m${text}\x1b[39m`;
	},
};

/** text 在 line 里出现时用的颜色名。 */
function colorOf(line: string, text: string): string | undefined {
	const at = line.indexOf(text);
	if (at < 0) return undefined;
	const codes = [...line.slice(0, at).matchAll(/\x1b\[38;5;(\d+)m/g)];
	return COLORS[Number(codes.at(-1)?.[1])];
}

const plain = (lines: string[]) => lines.map((l) => stripVTControlCharacters(l));
const NOW = 1_790_000_000_000;
const DAY = 86_400_000;

const top = (over: Partial<TopData> = {}): TopData => ({ cwd: "~/Project/piagent", branch: "main", mcp: "MCP 0/1", quota: [{ label: "周", remaining: 78, resetsAt: NOW + 5 * DAY + 6 * 3_600_000 + 60_000 }], now: NOW, ...over });
const bottom = (over: Partial<BottomData> = {}): BottomData => ({
	model: { id: "gpt-5.6-sol", reasoning: true },
	thinking: "medium",
	context: { percent: 38.9, tokens: 106_000, window: 272_000 },
	autoCompact: true,
	stats: { totals: { input: 107_000, output: 3_600, cacheRead: 853_000, cacheWrite: 0, cost: 1.07 }, cacheHitRate: 97.3 },
	subscription: true,
	statuses: [],
	...over,
});

test("宽屏：输入框上方与底栏的内容与设计稿方案 C 一致", () => {
	assert.deepEqual(plain(renderTop(top(), 120, theme)).map((l) => l.replace(/ {2,}/, " | ")), ["~/Project/piagent (main) | MCP 0/1 │ codex 周余 78% · 5d6h 后重置"]);
	const [line] = plain(renderBottom(bottom(), 140, theme));
	assert.equal(line.replace(/ {3,}/, " | "), "◆ gpt-5.6-sol  ⚡medium │ ▓▓▓▓░░░░░░ 38.9% 106k/272k auto | ↑107k ↓3.6k R853k CH97.3%  $1.070 sub");
	assert.equal(visibleWidth(renderTop(top(), 120, theme)[0]), 120, "右段顶到最右边");
	assert.equal(visibleWidth(renderBottom(bottom(), 140, theme)[0]), 140);
});

test("窄屏：底栏先省略费用，再省略 token，再省略思考等级，最后截断", () => {
	const at = (w: number) => plain(renderBottom(bottom(), w, theme))[0];
	// 右段靠右时中间是一长串空格，压回两个空格就是刚好放得下的宽度。
	const full = visibleWidth(at(200).replace(/ {3,}/, "  "));
	assert.ok(at(full).includes("$1.070 sub"), "刚好放得下时什么都不省");
	const noCost = at(full - 5);
	assert.ok(!noCost.includes("$") && noCost.includes("↑107k"), noCost);
	const noStats = at(70);
	assert.ok(!noStats.includes("↑") && noStats.includes("⚡medium"), noStats);
	const noThinking = at(50);
	assert.ok(!noThinking.includes("⚡") && noThinking.includes("38.9%"), noThinking);
	assert.ok(at(30).endsWith("..."), at(30));
	for (const w of [160, 100, 76, 60, 40, 20]) for (const l of renderBottom(bottom(), w, theme)) assert.ok(visibleWidth(l) <= w, `宽 ${w}：${stripVTControlCharacters(l)}`);
});

test("窄屏：上方一行先从开头省略目录，保留项目名与分支；再省略「后重置」，再省略 MCP", () => {
	const long = top({ cwd: "~/very/long/path/to/some/nested/Project/piagent" });
	const at = (w: number) => plain(renderTop(long, w, theme))[0];
	// 左侧至少保留 max(16, 分支宽度 + 10) 列、左右至少隔 2 列；右段在这之前放不下时才开始省略右段。
	const threshold = (right: string) => visibleWidth(right) + 2 + Math.max(16, visibleWidth(" (main)") + 10);
	const a = at(threshold("MCP 0/1 │ codex 周余 78% · 5d6h 后重置"));
	assert.ok(a.startsWith("…") && a.includes("piagent (main)") && a.includes("后重置"), a);
	const b = at(threshold("MCP 0/1 │ codex 周余 78% · 5d6h 后重置") - 1);
	assert.ok(!b.includes("后重置") && b.includes("MCP 0/1") && b.includes("5d6h"), b);
	const c = at(threshold("MCP 0/1 │ codex 周余 78% · 5d6h") - 1);
	assert.ok(!c.includes("MCP") && c.includes("周余 78%"), c);
	const longBranch = plain(renderTop(top({ branch: "feature/statusline" }), 60, theme))[0];
	assert.ok(longBranch.includes("(feature/statusline)") && !longBranch.includes("MCP"), `分支很长时先省略右侧，不截断分支：${longBranch}`);
	for (const w of [160, 100, 76, 60, 40, 20, 8]) for (const l of renderTop(long, w, theme)) assert.ok(visibleWidth(l) <= w, `宽 ${w}：${stripVTControlCharacters(l)}`);
});

test("没有的信息整段不显示：没配 MCP、非 codex、没有 git 分支、非推理模型、零费用的 API key", () => {
	assert.equal(plain(renderTop(top({ mcp: undefined, quota: undefined, branch: null }), 100, theme))[0], "~/Project/piagent");
	assert.equal(plain(renderTop(top({ mcp: undefined }), 100, theme))[0].includes("│"), false, "只有额度时没有分隔符");
	const [line] = plain(renderBottom(bottom({ model: { id: "deepseek-v4-flash", reasoning: false }, subscription: false, stats: { totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } } }), 120, theme));
	assert.equal(line.trimEnd(), "◆ deepseek-v4-flash │ ▓▓▓▓░░░░░░ 38.9% 106k/272k auto");
});

test("上下文未知（刚压缩完）时显示问号；关掉自动压缩时没有 auto", () => {
	const [line] = plain(renderBottom(bottom({ context: { percent: null, tokens: null, window: 272_000 }, autoCompact: false }), 140, theme));
	assert.ok(line.includes("░░░░░░░░░░ ? ?/272k") && !line.includes("auto"), line);
});

test("重置时刻已过时只显示剩余，不显示倒计时", () => {
	assert.equal(plain(renderTop(top({ mcp: undefined, quota: [{ label: "周", remaining: 50, resetsAt: NOW - 1 }] }), 100, theme))[0].trimEnd().endsWith("codex 周余 50%"), true);
});

test("其他扩展的状态单独占第二行，没有时底栏只有一行", () => {
	assert.equal(renderBottom(bottom(), 140, theme).length, 1);
	assert.deepEqual(plain(renderBottom(bottom({ statuses: ["◎ /goal active", "/agents 查看 subagent"] }), 140, theme)).slice(1), ["◎ /goal active  /agents 查看 subagent"]);
});

test("配色：阈值与颜色", () => {
	assert.equal(contextColor(70), "success");
	assert.equal(contextColor(70.1), "warning");
	assert.equal(contextColor(90), "warning");
	assert.equal(contextColor(90.1), "error");
	assert.equal(quotaColor(30), "muted");
	assert.equal(quotaColor(29), "warning");
	assert.equal(quotaColor(10), "warning");
	assert.equal(quotaColor(9), "error");
	const b = renderBottom(bottom({ context: { percent: 93.6, tokens: 255_000, window: 272_000 } }), 140, theme)[0];
	assert.equal(colorOf(b, "93.6%"), "error");
	assert.equal(colorOf(b, "◆ gpt"), "accent");
	assert.equal(colorOf(b, "⚡medium"), "thinkingMedium");
	assert.equal(colorOf(b, "↑107k"), "dim");
	const t = renderTop(top({ quota: [{ label: "周", remaining: 6, resetsAt: NOW + DAY }] }), 120, theme)[0];
	assert.equal(colorOf(t, "6%"), "error");
	assert.equal(colorOf(t, "MCP"), "dim");
	assert.equal(colorOf(renderBottom(bottom({ thinking: "max" }), 140, theme)[0], "⚡max"), "thinkingXhigh", "主题没有 thinkingMax 时退回");
});

test("shortenPath 保留末尾", () => {
	assert.equal(shortenPath("~/a/b/piagent", 20), "~/a/b/piagent");
	assert.equal(shortenPath("~/a/b/piagent", 9), "…/piagent");
	assert.equal(shortenPath("~/a/b/piagent", 1), "…");
});
