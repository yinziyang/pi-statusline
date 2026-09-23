# pi-statusline

给 pi 换一套状态栏：输入框上方显示环境信息（目录、MCP、codex 额度），底栏显示本次会话（模型、上下文、token 与费用）。

```
~/Project/piagent (main)                                  MCP 0/1 │ codex 周余 78% · 5d6h 后重置
──────────────────────────────────────────────────────────────────────────────────────────────
  输入框
──────────────────────────────────────────────────────────────────────────────────────────────
◆ gpt-5.6-sol  ⚡medium │ ▓▓▓▓░░░░░░ 38.9% 106k/272k auto     ↑107k ↓3.6k R853k CH97.3%  $1.070 sub
```

## 安装

```bash
pi install git:https://github.com/yinziyang/pi-statusline.git
```

需要 pi 0.87.0 或更高版本。
安装后新开一个 pi 会话，启动信息的 Extensions 列表里会出现 `yinziyang/pi-statusline:statusline`。
只在交互界面里生效，`pi -p` 与 RPC 模式不受影响。

- MCP 那一段需要装 [pi-mcp-adapter](https://www.npmjs.com/package/pi-mcp-adapter)，没装时不显示，其余照常。
- 更新到最新提交：`pi update --extensions`。
- 只对当前项目生效：加 `-l`，写入项目的 `.pi/settings.json`。
- 临时试用、不写入设置：`pi -e git:https://github.com/yinziyang/pi-statusline.git`。
- 卸载：`pi remove git:https://github.com/yinziyang/pi-statusline.git`。

## 各段的含义

输入框上方：

| 段 | 含义 |
|---|---|
| `~/Project/piagent (main)` | 当前目录与 git 分支；太长时从开头省略，保留项目名与分支 |
| `MCP 0/1` | MCP 服务的已连接数/已启用数，来自 [pi-mcp-adapter](https://www.npmjs.com/package/pi-mcp-adapter)；服务按需连接，没用到时是 `0/N`，属正常 |
| `codex 周余 78% · 5d6h 后重置` | codex 订阅额度的剩余百分比与重置倒计时，见下面「codex 额度」 |

底栏：

| 段 | 含义 |
|---|---|
| `◆ gpt-5.6-sol` | 当前模型 |
| `⚡medium` | 思考等级；模型不支持推理时不显示 |
| `▓▓▓▓░░░░░░ 38.9% 106k/272k` | 当前上下文占模型窗口的比例；刚压缩完、还不知道时显示 `?` |
| `auto` | 自动压缩已开启 |
| `↑107k` | 本会话累计输入 token，不含命中缓存的部分 |
| `↓3.6k` | 本会话累计输出 token |
| `R853k` | 本会话累计从缓存读取的 token |
| `W…` | 本会话累计写入缓存的 token；为 0 时不显示，codex 不报告这个数 |
| `CH97.3%` | 最近一次请求的缓存命中率 |
| `$1.070` | 按 API 标价折算的本会话累计费用 |
| `sub` | 订阅登录，费用只是折算，不实际扣费 |

- 这些数字的算法与 pi 自带底栏逐项一致；前台 subagent 的用量计入，后台 subagent 的不计入。
- 其他扩展用 `setStatus` 写入的状态，有的时候会在底栏下面多出一行。

## codex 额度

- 只在当前模型的 provider 是 `openai-codex` 时显示。
- 数据来自 ChatGPT 的用量接口 `backend-api/wham/usage`，凭据用 pi 里已经登录的 codex 账号，不需要另外配置。
- 按接口实际返回的窗口显示：现在的 Pro 套餐只有周额度；接口返回 5 小时窗口时会自动多出一段。
- 会话开始、切换模型、每轮结束时查询；两次之间至少隔 30 秒，单次最多等 10 秒；倒计时每分钟刷新。
- 查不到时整段不显示，不报错，例如：换成别的 provider、没登录 codex、网络出错。
- 这个接口是 Codex 客户端自用的内部接口，格式以后可能变化；变了也只是这一段不显示。

## 配色

全部取自 pi 主题的语义颜色，深色、浅色主题都能用：

- 参考信息（目录、MCP、token、费用）是灰色。
- 模型名用主题的强调色，思考等级用主题里各等级自带的颜色。
- 上下文超过 70% 变黄，超过 90% 变红，与 pi 自带底栏一致。
- 额度剩余低于 30% 变黄，低于 10% 变红。

## 窄屏

- 底栏先省略费用，再省略 token 统计，再省略思考等级，仍放不下时截断。
- 输入框上方先从开头省略目录，再省略「后重置」三个字，再省略 MCP；还放不下时只保留目录。

## 与其他扩展的关系

- pi 同一时间只能有一个扩展替换底栏，装了别的替换底栏的扩展时，后加载的那个生效。
- [pi-goal](https://github.com/yinziyang/pi-goal) 的状态与 [pi-subagents](https://github.com/yinziyang/pi-subagents) 的面板画在输入框下方，不受影响。
- pi-mcp-adapter 写入的完整状态文字不再出现在底栏，改成右上角的简写。

## 与 pi 自带底栏的差异

- 不显示会话名（`/name` 设置的那个）。
- 右侧不再重复显示模型名与 provider。
- 自动压缩的 `auto` 读的是设置文件；会话中用 `/settings` 切换后，要等这一轮结束才更新。

## 开发

- `npm test`：单元测试；token、缓存、费用的统计直接与 pi 自带底栏的实现对比。
- `npm run typecheck`：类型检查。
- 开发时不用安装，`pi -e <本目录>` 加载即可。

源码在 `extensions/statusline/`：

- `index.ts`：组合根，装上底栏与输入框上方的一行，管理刷新时机与收尾。
- `render.ts`：把各段排成行、按宽度省略、上色。
- `usage.ts`：会话统计、目录显示、MCP 简写。
- `quota.ts`：codex 额度的请求、解析与查询时机。
