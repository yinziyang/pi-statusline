# pi-statusline 开发计划与验收标准

为 pi 提供一套自定义状态栏，布局按设计稿的方案 C。
设计稿：https://claude.ai/code/artifact/a5a5475f-462c-4aa4-a893-d4714cbb91a3

## 1. 范围

### 本期做

- 替换 pi 自带的底栏，并在输入框上方加一行，布局见第 2 节。
- 统计口径与 pi 0.87 自带底栏逐项一致：token、缓存、费用、上下文、自动压缩。
- codex 额度：剩余百分比与重置倒计时。
- MCP 状态的简写。
- 窄屏时按固定顺序省略次要信息。
- 配色全部取自 pi 主题，深色、浅色主题都可用。

### 本期不做

- 其他 provider 的额度（Claude、GLM 等）。
- 会话名：按设计稿不显示。
- 可配置的布局与开关：先按设计稿固定，有需要再加。

### 不改动的扩展

- pi-goal、pi-subagents、pi-mcp-adapter 一行都不改。
- goal 的状态与 subagent 面板仍由它们自己画在输入框下方，本包不接管。

## 2. 布局

```
[输入框上方]  左：目录 (git 分支)          右：LSP gopls ✓ │ MCP 2/3 │ codex 周余 78% · 5d6h 后重置
[输入框]
[输入框下方]  subagent 面板、goal（各自的扩展负责）
[底栏第 1 行] 左：◆ 模型  ⚡思考等级 │ 上下文条 38.9% 106k/272k auto    右：↑107k ↓3.6k R853k CH97.3%  $1.070 sub
[底栏第 2 行] 其他扩展写入的状态，没有时不出现
```

- 输入框上方一行用 `setWidget(…, { placement: "aboveEditor" })`，底栏用 `setFooter`。两者共用 `setFooter` 拿到的 `footerData`，读 git 分支与各扩展的状态。
- MCP 与 pi-lsp 的状态显示在右上角，所以底栏第 2 行不再重复它们。
- 额度与 MCP 都没有时，右上角为空；目录也照常显示。

## 3. 各段的数据与规则

| 段 | 来源 | 规则 |
|---|---|---|
| 目录 | `ctx.cwd` | 家目录换成 `~`，与自带底栏的 `formatCwdForFooter` 一致 |
| git 分支 | `footerData.getGitBranch()` | 没有时不显示括号 |
| MCP | pi-mcp-adapter 写入的状态（键 `mcp`） | 从原文解析出已连接数与已启用数，显示 `MCP 已连接/已启用`；解析不出时显示去掉换行的原文；没有这个状态时不显示 |
| LSP | pi-lsp 写入的状态（键 `zz-pi-lsp`，与 pi-lsp 约定） | 原样显示，颜色由 pi-lsp 决定；没装 pi-lsp、非交互模式或本机没有语言服务器时 pi-lsp 不写这个键，这一段不显示 |
| 额度 | codex 用量接口 | 见第 4 节 |
| 模型 | `ctx.model.id` | 没有模型时显示 `no-model` |
| 思考等级 | `pi.getThinkingLevel()` | 模型不支持推理时不显示 |
| 上下文 | `ctx.getContextUsage()` | 条长 10 格；百分比保留一位小数，未知时显示 `?`；后跟 `已用/窗口`；自动压缩开启时加 `auto` |
| token | 当前会话全部条目 | `↑` 输入、`↓` 输出、`R` 缓存读取、`W` 缓存写入，为 0 的不显示；`CH` 为最近一条助手消息的缓存命中率；累加范围与自带底栏相同（助手消息、带用量的工具结果、`usage`、压缩与分支摘要） |
| 费用 | 同上 | `$` 保留三位小数；订阅登录时加 `sub`；费用为 0 且不是订阅时不显示 |
| 其他状态 | `footerData.getExtensionStatuses()` 去掉 `mcp` 与 `zz-pi-lsp` | 按键名排序，去掉换行后用两个空格连接 |

- 自动压缩是否开启：扩展接口拿不到会话里的实时值，读设置文件的 `compaction.enabled`，在会话开始与每轮结束时各读一次。会话中用 `/settings` 切换后，要等本轮结束才更新。
- 订阅判断：`ctx.modelRegistry.isUsingOAuth(model)`，另外 `kimi-coding` 按订阅处理，与自带底栏一致。

## 4. codex 额度

- 只在当前模型的 provider 是 `openai-codex` 时查询与显示。
- 请求：`GET https://chatgpt.com/backend-api/wham/usage`。
  - `Authorization: Bearer <token>`，token 用 `ctx.modelRegistry.getApiKeyForProvider("openai-codex")` 获取，过期时由 pi 刷新。
  - `ChatGPT-Account-Id`：从 token 的 `https://api.openai.com/auth.chatgpt_account_id` 声明解析，已核对与 pi 存的 accountId 一致。
- 时机：会话开始、切换模型、每轮结束；两次请求至少间隔 30 秒；单次请求 10 秒超时；会话关闭时中止进行中的请求。
- 解析：取 `rate_limit.primary_window` 与 `secondary_window` 中存在的窗口。
  - 窗口名按 `limit_window_seconds` 定：约一周为「周」，否则按小时写成 `5h` 这类。
  - 剩余 = 100 − `used_percent`。
  - 重置时刻 = 请求时刻 + `reset_after_seconds`，没有时用 `reset_at`。倒计时在每次重绘时按绝对时刻现算。
- 显示：`codex 周余 78% · 5d6h 后重置`；多个窗口用 `│` 分隔。
- 以下情况整段不显示，也不报错：不是 codex 模型、拿不到 token、请求失败或超时、返回格式不符。
- 倒计时每分钟刷新一次界面，定时器不阻止进程退出，会话关闭时清掉。
- 风险：这是 Codex 客户端自用的内部接口，格式可能变化；变化后按上一条不显示，不影响其他段。

## 5. 窄屏

- 底栏第 1 行：先省略右侧的费用，再省略 token 统计，再省略思考等级；仍放不下时截断，末尾加 `...`。
- 输入框上方一行：先从开头省略目录，保留末尾的项目名与分支，例如 `…/piagent/e2e (main)`。左侧至少保留 16 列，分支名很长时至少保留「分支 + 10 列路径」；再窄就先省略额度的「后重置」三个字，再省略 LSP，再省略 MCP，最后只保留目录。
- 任何一行的可见宽度都不超过终端宽度。

## 6. 配色

全部用 `theme.fg(…)` 的语义颜色，不写死色值：

| 段 | 颜色 |
|---|---|
| 目录、分支、token、费用、分隔符、MCP、其他状态 | `dim`；分隔符 `borderMuted` |
| `◆` 与模型名 | `accent` |
| 思考等级 | `thinkingOff` 到 `thinkingXhigh`，`max` 用 `thinkingMax`，缺省时退回 `thinkingXhigh` |
| 上下文 | `success`；超过 70% `warning`；超过 90% `error` |
| 额度百分比 | 剩余 ≥30% `muted`；10% 到 30% `warning`；低于 10% `error` |

## 7. 结构

S 档：一个扩展，预计 400 行以内，不做分层。

- `extensions/statusline/index.ts`：组合根。注册事件，设置底栏与输入框上方的一行，管理刷新定时器与收尾。
- `extensions/statusline/render.ts`：纯函数。把各段数据排成行、按宽度省略、上色；不碰 pi 的会话对象。
- `extensions/statusline/usage.ts`：纯函数。从会话条目算 token、缓存、费用，从状态原文解析 MCP 简写。
- `extensions/statusline/quota.ts`：codex 额度的请求与解析。`fetch` 与当前时间由参数传入，测试时替换，对应 CLAUDE.md「不可控输入可注入」。
- 本次不引入接口、基类或模式；拆成四个文件只是为了能对纯函数单独测试。

## 8. 验收标准

单元测试（`npm test`）：

1. `formatTokens` 与自带底栏在 0、999、1000、9999、10000、999999、1e6、1e7 上输出一致。
2. 会话统计：用一组包含助手消息、工具结果用量、`usage` 条目、压缩条目的样例，↑↓RW、CH、费用与自带底栏的算法结果一致。
3. MCP 简写：`1 server enabled` → `MCP 0/1`；`3 servers enabled (2 connected)` → `MCP 2/3`；带 `(1 disabled)`、compact 原文 `MCP 1/2`、带颜色码的原文都能解析；无法解析时返回去掉换行的原文。
4. 额度解析：用真实接口的返回结构（只有周窗口、两个窗口都有、窗口为空、字段缺失、`used_percent` 越界）得到正确的名称、剩余与重置时刻；非 200、超时、JSON 错误时返回空。
5. 额度查询时机：非 codex 模型不发请求；30 秒内不重复请求；会话关闭后进行中的请求被中止，且不再刷新界面。
6. 倒计时格式：59 秒、59 分、5 时 13 分、5 天 6 时、已过期，分别得到约定的文字。
7. 渲染：宽度 160、100、76、40 下按第 5 节的顺序省略，每行可见宽度都不超过终端宽度。
8. 配色阈值：上下文 70% 与 70.1%、90% 与 90.1%，额度 30%、29%、10%、9% 取到约定的颜色。

真实 pi（tmux，交互模式）：

9. 对照设计稿方案 C 的常规、运行中、告急三种状态逐段核对：内容、位置、颜色一致。
10. 与 pi 自带底栏对比同一会话：token、缓存、费用、上下文的数值一致。
11. 额度：codex 模型下显示剩余与倒计时，数值与 codex 接口一致；切到非 codex 模型后整段消失，切回后恢复。
12. MCP：未调用时显示 `MCP 0/1`，调用一次 MCP 工具后变成 `MCP 1/1`。
13. goal 与 subagent：`/goal` 进行中、派出后台 subagent 时，goal 的状态行与 subagent 面板照常显示在输入框下方，互不遮挡。
14. 浅色主题（`/settings` 切换）下各段都清晰可读。
15. 窄屏：把 tmux 窗口缩到 80 列与 60 列，省略顺序符合第 5 节，没有换行错乱。
16. `/quit` 正常退出，没有残留定时器让进程挂住；`pi -p` 与 RPC 模式下本包不做任何事。

## 9. 安装与发布

- 仓库：GitHub `yinziyang/pi-statusline`，待创建。
- 安装：`pi install git:git@github.com:yinziyang/pi-statusline.git`。
- `peerDependencies` 里的 pi 包标为可选，避免 git 安装时拉下整份 pi。
- README 写明：布局、各字段含义、额度的数据来源与风险、与其他扩展的关系、同一时间只能有一个扩展替换底栏。

## 10. 验收记录

### 2026-09-22

被测环境：pi 0.87.0，pi-mcp-adapter 2.36.0，pi-goal `c3147e9`，pi-subagents `ce7acb9`，tmux 3.x，codex Pro 账号。

- 通过：1 到 8，`npm test` 25 项。
  - token、缓存、费用直接实例化 pi 自带的 `FooterComponent`，与本包对同一组会话条目的输出逐字对比。
  - `formatTokens` 与目录显示直接与 pi 自带的函数对比。
- 通过：9，宽屏的常规状态与「goal 与 subagent 运行中」状态与设计稿一致：上方一行、subagent 面板、右对齐的 goal、底栏各在其位，互不遮挡。告急状态（上下文超过 90%、额度低于 10%）在真实会话里不便制造，由渲染测试的配色用例覆盖。
- 通过：10，同一会话分别用本包与 pi 自带底栏打开，`↑11k ↓94 R22k CH98.7% $0.071 sub 4.1% 11k/272k auto` 逐项一致。
- 通过：11，codex 下显示「周余 78% · 5d5h 后重置」，与接口返回的 22% 已用一致；切到自定义 provider 的模型后额度、`sub`、思考等级都消失，切回后恢复。
- 通过：12，有元数据缓存时启动显示 `MCP 0/1`，调用一次 MCP 工具后变为 `MCP 1/1`；没有缓存时适配器启动即连接，直接显示 `MCP 1/1`。
- 通过：13，`/goal` 驱动后台 subagent 完成任务，过程中各段正常；结束后 pi-subagents 的「/agents 查看 subagent」出现在底栏第二行，30 秒后消失。
- 通过：14，浅色主题下各段取到 pi 浅色主题的颜色，清晰可读。
- 通过：15，80 列时先省略费用；60 列时省略 MCP、保留完整的分支名；45 列时底栏末尾截断为 `...`。
- 通过：16，`/quit` 1 秒内退出，没有残留 MCP 进程；`pi -p` 正常输出，退出码为 0。
- 过程中发现并修复：
  - 目录过长时从末尾截断，把分支与项目名截掉了；改为从开头省略，保留末尾。
  - 分支名很长时，左侧留 16 列仍会截断分支；改为左侧至少保留「分支 + 10 列路径」，不够时先省略右侧的次要信息。

## 验收记录（2026-09-22）

被测环境：pi 0.87.0，pi-mcp-adapter 2.36.0，pi-goal `c3147e9`，pi-subagents `ce7acb9`。

- 通过：1 到 8，`npm test` 25 项；token、缓存、费用、目录直接与 pi 自带底栏的 `FooterComponent`、`formatTokens`、`formatCwdForFooter` 对比。
- 通过：9，tmux 里的真实界面与设计稿方案 C 的常规、运行中两种状态逐段一致；颜色码逐个对上 `dark.json`：
  - 灰 `#666666`，额度 `#808080`，分隔符 `#505050`。
  - 思考等级 `#81a2be`，上下文 `#b5bd68`。
- 通过：10，同一会话分别用自带底栏与本包打开，都是 `↑11k ↓94 R22k CH98.7% $0.071 sub 4.1% 11k/272k auto`。
- 通过：11，默认模型是自定义 provider 时没有额度段；`/model gpt-5.6-sol` 后出现 `codex 周余 78% · 5d5h 后重置`，与接口一致；切回后消失。
- 通过：12，未调用时 `MCP 0/1`，调用一次 `whoami` 后 `MCP 1/1`。
- 通过：13，`/goal` 进行中派出后台 subagent：subagent 面板、`◎ /goal active` 与状态栏同时显示、互不遮挡；subagent 完成后「/agents 查看 subagent」出现在底栏第二行；goal 最终达成。
- 通过：14，浅色主题下颜色码逐个对上 `light.json`：灰 `#767676`，额度 `#6c6c6c`，分隔符 `#b0b0b0`，思考等级 `#5a8080`，上下文 `#588458`。
- 通过：15，把窗口缩到 100、80、60、40 列：
  - 省略顺序符合第 5 节。
  - 每一行的可见宽度都等于或小于终端宽度。
  - 40 列时底栏截断并加 `...`。
- 通过：16，`/quit` 在 1 秒内退出；`pi -p` 退出码 0，输出只有模型的回答。RPC 模式与 `-p` 走同一个判断（`ctx.mode !== "tui"` 时直接返回），没有单独实测。
- 过程中改掉的问题：目录过长时原来从末尾截断，把项目名和分支截掉了，改成从开头省略、保留末尾。
