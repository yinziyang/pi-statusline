import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import statusline from "../extensions/statusline/index.ts";

const theme = { fg: (_color: string, text: string) => text };
const tui = { requestRender() {} };
type Factory = (ui: typeof tui, palette: typeof theme, data: ReadonlyFooterDataProvider) => Component;

test("Fast 标准状态实时进入目录行，不在底栏重复，其他扩展不受影响", async (t) => {
  t.mock.method(SettingsManager, "create", () => ({ getCompactionEnabled: () => true }));
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const statuses = new Map([["openai-fast-mode", "Fast 关"], ["other", "/goal active"]]);
  const widgets = new Map<string, Component>();
  let footer: Component | undefined;
  const data = {
    getExtensionStatuses: () => statuses,
    getGitBranch: () => null,
    onBranchChange: () => () => {},
  } as unknown as ReadonlyFooterDataProvider;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
    getCommands: () => [],
    getAllTools: () => [],
    getMcpServers: () => [],
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    cwd: "/project",
    model: { provider: "test", id: "test", contextWindow: 100 },
    getContextUsage: () => undefined,
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: { getCwd: () => "/project", getEntries: () => [] },
    ui: {
      setFooter: (factory: Factory) => { footer = factory(tui, theme, data); },
      setWidget: (key: string, factory: Factory) => widgets.set(key, factory(tui, theme, data)),
    },
  } as unknown as ExtensionContext;
  statusline(pi);
  try {
    await handlers.get("session_start")?.({}, ctx);
    assert.equal(widgets.size, 1);
    const top = widgets.get("pi-statusline");
    assert.ok(top);
    assert.ok(footer);
    assert.deepEqual(top.render(100), ["/project │ Fast 关"]);
    const bottom = footer.render(100).join("\n");
    assert.equal(bottom.includes("Fast"), false);
    assert.ok(bottom.includes("/goal active"));
    statuses.set("openai-fast-mode", "Fast 开");
    assert.deepEqual(top.render(100), ["/project │ Fast 开"]);
    statuses.delete("openai-fast-mode");
    assert.deepEqual(top.render(100), ["/project"]);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
  }
});
