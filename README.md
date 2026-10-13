# dsh-wb-outsource · 🥚 外包模式

> 📦 **只想下载安装包** → 本仓库根目录直接点 [`dsh-wb-outsource-v0.3.0.zip`](dsh-wb-outsource-v0.3.0.zip)；走「Code → Download ZIP」拿到的是整个源码树（一样能用，解压后跑 `node install.mjs --apply` 即可）。

把 **DSH 里耗 token 的重活**甩给本机的 **WorkBuddy**（腾讯 codebuddy CLI）去干 —— 花的是 WorkBuddy 积分，**不烧 DSH 的 token**。

装上之后：输入框右侧多一个 **🥚 外包**按钮，底部状态栏多一行 **`🥚 外包 N 次 · X 积分`**。

> 原理：它跟 DSH 的 `subagent` 工具**同构** —— agent 写一份自包含任务书 → WorkBuddy 在自己的上下文里干活 → 产物落本地 → **再由 agent 体检 + 真机验证**，通过才搬进正主目录。开关打开时，插件会往 system prompt 里注入一段「尽量外包」的说明 —— 这是**可见的**（对话流里会多一条「系统提示词」条目），不做隐形注入。
>
> ⚠️ 开关是**按会话**的：只对点它的那条会话生效，**纯内存、重启归零**（不是全局粘性开关，也不落盘）。详见「三、怎么用」。

---

## 一、先决条件（★ 必须，不然装了也没用）

1. **WorkBuddy 桌面端**（腾讯）：<https://www.workbuddy.cn/>
2. **官方 CLI**（注意：桌面端**自带**的那个是 headless 专用、**登不了**，必须单独装）

   ```bash
   npm install -g @tencent-ai/codebuddy-code
   ```

3. **登录 CLI**（只做一次）—— 终端里直接敲：

   ```bash
   codebuddy
   ```

   用方向键选 **`Log in via Chinese Site`** → 回车 → 浏览器里完成授权。
   登录态存在 `~/.codebuddy`，**跟桌面端不共享**（这是官方设计，不是 bug）。

   验证：`codebuddy -p "回复 pong" --model deepseek-v4.1-flash --tools "" --max-turns 1` 能回 `pong` 就算通了。
   （Windows 上本包附了 `tools/wb-cli-login.cmd`，双击它就等于上面这一步。）

4. 系统里有 **Node.js**（跑安装脚本与执行器用）。

---

## 二、安装

把本目录放到任意位置（例如 `~/.dsh/plugin-stash/dsh-wb-outsource`），然后：

```bash
node install.mjs --check     # 只读体检：会告诉你挂到哪个 profile、当前状态
node install.mjs --apply     # 挂载（★ 必须先完全关掉 DSH，否则它会拒绝执行）
```

装完 **重新打开 DSH**（⚠️ 不要只按 F5：客户端插件是按启动快照服务的，刷新可能拿到过期 bundle 导致页面起不来）。

**手动安装**（不想跑脚本的话，两步）：

1. `~/.dsh/profiles/<你的 profile>/package.json` 的 `dependencies` 里加一行（路径按实际改）：

   ```json
   "dsh-wb-outsource": "file:C:/Users/你/.dsh/plugin-stash/dsh-wb-outsource"
   ```

2. 同一 profile 的 `cordis.patch.yml`（**顶层数组**）末尾追加：

   ```yaml
   - insert:
       - id: wb-outsource
         name: 'dsh-wb-outsource'
   ```

3. 在该 profile 目录里跑 `pnpm install`，然后重开 DSH。

---

## 三、怎么用

1. 点一下 **🥚 外包**（变成橙色 ●）＝ **这条会话**尽量把重活交出去；再点一下就是关。
   - 这是**按会话**开关：只对点它的那条会话生效，**纯内存、重启 DSH 后全部归零**。开 A 会话不会影响 B 会话；重启后所有按钮都回到「关」。
   - 想不重启就一次性关掉**全部**会话的开关，调 `POST /api/dsh-wb-outsource/reset`（返回被清掉的会话数）。
2. 也可以直接对 DSH 说：**「外包：把 XXX 做完」**。
3. 干完的活会落在 `~/.dsh/wb-outsource/`（可用环境变量 `WB_OUT_ROOT` 改），里面有产物、`_runs/<时间戳>/run.json`（含本次 token 与**积分**）、stdout 日志。

> **为什么改成「按会话 + 纯内存」？** 旧的「全局粘性 + 落盘」有两个毛病：① **重启后报假警** —— 开关落盘后重启仍是「开」，可新进程还没构建过 system prompt，旧自检把「还没读过」误判成 `INJECT_NEVER_READ` → 按钮变红、发一条消息才自愈；② **跨会话串味** —— 注入段是**全局注册**的，在 A 会话打开的开关会凭空管到 B 会话。改成「按会话 + 纯内存」后：重启 = 全部关闭（没有假警），开关又只对点它的那条会话生效（不串味）。

**适合外包**：大段编码、批量改造、写文档/README、搬砖式重构、独立小工具。
**绝不要外包**：需要当前对话上下文的活、涉及密钥/隐私的、需要真机验证才敢下结论的、直接改 profile 的活。

---

## 四、验证装好了

| 检查 | 期望 |
|---|---|
| 探针 | `GET http://127.0.0.1:19387/api/dsh-wb-outsource/probe` → `{"ok":true,...}`（端口按你的 DSH 实际端口） |
| 按钮 | 输入框右侧出现 **🥚 外包** |
| 底部 | 出现 **`🥚 外包 N 次 · X 积分`**（跑过一次外包后才有数字） |
| 开关状态 | 看 `GET .../state?sessionId=<你的会话id>`：**纯内存、按会话**，不落盘。旧全局文件 `~/.dsh/outsource-state.json` **已退役**（不再读写） |
| 离线自检 | `node verify-offline.mjs`（**静态结构**：安全 / 插槽 / 打包 / 文案存在性，0 失败） |
| 行为自检 | `node verify-persession.mjs`（把 host 真跑起来，**68 项断言**全绿） |

**两个自检脚本各管什么**：`verify-offline.mjs` **只做静态结构检查**（grep 源码/清单，不启动任何东西）；行为语义 —— 按会话开关、重启归零、注入按会话判定、`/reset`、路径回退 …… 全部交给 `verify-persession.mjs`（它造一个假 ctx 把 host 真正跑起来，用临时目录隔离 `DSH_HOME`）。两者不重复。

> **旧状态文件已退役**：`~/.dsh/outsource-state.json`（本机已改名为 `outsource-state.json.retired-20261013`）**不再被读写**。插件只在它还残留、且仍是 `{"enabled":true}` 时，于 probe 的 `legacy` 字段给一条提示（`legacy-global-state-ignored`，附带回可删路径），**不会**因此让任何会话变成「开」。可以直接删掉它。

**积分怎么看**：底部那行**只统计本会话** —— 0 次就显示「本会话外包 0 次 · 0.00 积分」；悬停列出本会话历次外包各花了多少积分（**没有"累计"这个口径了**）；`node tools/wb-credits.mjs` 列出每个 CLI 会话的积分，`--ledger` 把汇总（含 `totals.bySession` 分会话小计）写进 `~/.dsh/wb-outsource-ledger.json`。

> ⚠️ 插槽 props 的真相（2026-10-13 实测更正）：`renderSlot(key, {})` 里那个空对象是**插槽自有 props**，**和标准 props 不是一回事** —— `conversation.composer.dock` 与 `conversation.input.right` 的 scope 都是 `session`，两者都会从 session scope 拿到 `props.sessionId`（CDP 读 fiber 实测：`props.sessionId = "session-…"`，与宿主 `agent.id` 同源）。所以底部那行**本来就能自己拿到** sessionId；旧版注释里"dock 拿不到 sessionId"是误判，代码里的 `knownSession()` 只是历史兜底。若真拿不到会话，这一行**直接不显示**（不会瞎猜是哪条会话）。
>
> 口径说明：**本会话**的统计依赖 host 在每步记录的「活跃会话」→ `wb.mjs` 给产物盖会话戳；所以**装上之前**跑过的外包没有会话戳，不会被算进任何一条会话的本会话统计。
数据来源是 CLI 的会话记录 `~/.codebuddy/projects/*/*.jsonl` 里每条请求的 `credit` 字段，属于**本地账本**，可能比服务端账单略小（重试/取消/返还未记）。

---

### 怎么确认「注入真的生效」（不是只亮灯）

> 血泪教训（v0.2.2）：把 systemPrompt 从静态 inject 数组改成动态 ctx.inject 之后，回调根本不触发，注入彻底失效 —— 而按钮照样亮着。静态数组是这个 DSH 版本里唯一实证可用的形式，别改。
>
> 血泪教训（v0.3.0）：段是**全局注册**的，但 `text` 回调拿得到 assembly context（用 `context.agent.id` 取会话），所以现在**按会话**判定 —— 没开（或取不到会话）就注入空串，绝不串味。

开关亮 ≠ 生效。本插件为此做了两件事：

1. **按会话自证计数**：`GET /api/dsh-wb-outsource/probe`（或带 `sessionId` 的 `/state`）会返回：
   - `promptRegistered`：注入段是否注册成功；
   - `sectionCalls`：内核为**任意**会话构建 prompt 时触发的次数（每次构建 +1，含没注入的）；
   - `promptReads`：全局硬证据 —— 真正返回过非空文本的次数；`sessionReads`：**这条会话**的说明真的进过它的 system prompt 几次。
     **`sessionReads > 0` 就是「那段说明确实进了这条会话的 system prompt」的硬证据。**
   - **`pending` 与 `warning` 的区别（关键）**：
     - `pending: true` = 开关开着，但这条会话**还没构建过 system prompt**（正常：还没发过消息）。**中性提示，不是故障**，附带 `pendingNote`；发一条消息后 `sessionReads` 就会 > 0。
     - `warning` = **真故障**，只会是 `INJECT_NOT_REGISTERED`（注入段根本没注册成功，开关等于没用）。
       ⚠️ 旧版的 `INJECT_NEVER_READ`（"从没被读过"）**已删除**：它在重启后必现（新进程还没构建过 prompt），只会报假警；这种情况现在降级为上面的 `pending`。
   - `legacy`：旧全局状态文件残留提示（见上）。
   - probe 还会返回：`mode`（模式串，标明「按会话 / 内存 / 重启归零」）、`activeSessionId`（当前活跃会话）、`enabledSessions`（当前开着的会话清单，含每条的 `reads`）、`runner`/`runnerExists` 与 `skill`/`skillExists`（注入里用到的 `wb.mjs` / `SKILL.md` 最终落定的绝对路径，以及它**是否真实存在** —— 这就是「候选表回退」的结果）。
     - **一次踩过的坑（路径回退的由来）**：官方端 profile 里那份插件副本**只有 `lib/`** —— pnpm 的 `file:` 依赖只把被**硬链接**的文件带过去，`tools/`、`skills/` 这类目录没跟过去。于是写死的 `PLUGIN_ROOT/tools/wb.mjs` 在那份副本里**根本不存在**，插件却会把它写进 system prompt → 模型照抄执行直接 `Cannot find module`（本机实测复现）。现在按候选表挑**第一个真实存在**的：`PLUGIN_ROOT/tools/wb.mjs` → `$DSH_HOME/tools/wb.mjs`（本机这份与插件自带那份 md5 相同）；SKILL 再兜一层 `$DSH_HOME/plugin-stash/<插件名>/skills/…`。`runnerExists` / `skillExists` 就是这件事的指示灯 —— **false 说明注入里那条路径是死的**。
2. **日志自检工具**：`node tools/check-inject.mjs <会话日志> 外包模式：本会话已开启`
   （看**更早**的会话日志时，标记要换成旧文案 `外包模式：已开启`。）
   会话日志在 `~/.dsh/sessions/--<cwd>--/<会话id>/session.v4.jsonl.zstd`。它会数 `system/message` 事件，直接告诉你注入有没有真的出现在 prompt 里。

只有 `warning` 非空时按钮才显示 **⚠️**（此时开关等于没用）→ 请重启 DSH；仍不行就把 probe 输出发出来。`pending` 不会让按钮变红。

---

## 五、卸载

```bash
node install.mjs --uninstall     # 同样要先关掉 DSH
```
或手动删掉上面那两处（依赖行 + `- insert:` 那两行），再 `pnpm install`、重开。

---

## 六、安全说明（有意为之的取舍）

- 自注册的 HTTP 路由**不受 DSH 鉴权**，所以本插件**故意只提供** `/state`（读/切开关，GET/POST 都要带 `sessionId`）、`/reset`（POST，清空全部会话开关）、`/probe`、`/ledger`（只读账本文件）—— **没有任何"执行"路由**。真正的执行永远由 agent 用 bash 调 `tools/wb.mjs`，受正常工具链约束。
- host 半边**不 spawn 任何进程、不联网**；它只在 `~/.dsh/` 下读写账本 / 活跃会话 / 会话时间线这几个文件。旧的 `outsource-state.json` 只**读**来做提示，**不再写**。
- 执行器默认**禁用 Bash 工具**（只允许 WorkBuddy 读写文件），要放开得显式加 `--allow-bash`。

## 七、常见问题

| 症状 | 处理 |
|---|---|
| 按钮/底部一行不出现 | 装完**必须重开** DSH（不是刷新） |
| 提示 `Authentication required` | CLI 没登录 → 见「先决条件」第 3 条 |
| `NOT_FOUND_CLI` | 没装官方 CLI → `npm i -g @tencent-ai/codebuddy-code`；或设 `WB_CLI=<codebuddy 路径>` |
| 模型报不支持 | 换 `--model auto` |
| 装了之后 DSH 起不来 | 关掉 → 跑 `node install.mjs --uninstall` → 重开（install 脚本会先把改过的文件备份成 `*.bak-wboutsource-*`，也可以直接回滚备份） |
| 外包很慢/超时 | 拆小任务，或 `--timeout 900` 加大；产物仍在工作目录里 |

## 八、目录结构

```
lib/index.js      host 半边（按会话的内存开关 + 只读路由 + 按会话注入说明）
lib/client.js     client 半边（🥚 按钮 + 底部一行）
tools/wb.mjs      外包执行器（调 codebuddy 无头模式，落 run.json）
tools/wb-credits.mjs  积分账本汇总
tools/check-inject.mjs 注入自检（读会话日志，证明注入真进了 prompt）
tools/wb-cli-login.cmd 一键登录 CLI（Windows）
docs/插件开发规范_给外部AI.md   喂给外部 AI 的「DSH 插件规范」（写插件时用 --context 传）
skills/workbuddy-outsource/SKILL.md  给 agent 的外包手册
install.mjs       挂载/卸载脚本
verify-offline.mjs 静态结构自检（安全 / 插槽 / 打包完整性 / 文案存在性）
verify-persession.mjs 行为级自检（造假 ctx 把 host 真跑起来，68 项断言）
```

## 九、版本历史

| 版本 | 变化 |
|---|---|
| **v0.3.0**（就是你手上这包） | 开关改为 **按会话 + 纯内存**（重启归零、不落盘、不串味）；新增 `POST /reset` 一键关全部；注入按会话判定；`runner`/`skill` 改**候选表回退**（修「官方端 profile 副本里只有 `lib/`，写死的 `tools/wb.mjs` 是死路径」这个实测坑）；底部积分改「本会话」口径；新增行为自检 `verify-persession.mjs`（68 项断言）。 |
| v0.2.9 | 首个外发包：**全局粘性**开关，落盘 `~/.dsh/outsource-state.json`。⚠️ 与 v0.3.0 **版本号不同、内容不同**；若你手上的包 `package.json` 描述写的是「**粘性开关**」，那就是这一版，请换成 v0.3.0。 |
| v0.2.2 | 注入从动态 `ctx.inject` 改回静态数组（动态回调在这个 DSH 版本里根本不触发；按钮照样亮着，是假活）。 |

MIT © 2026
