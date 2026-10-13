/**
 * dsh-wb-outsource — host 半边
 *
 * 做四件事，**故意不做第五件**：
 *   ① 按「会话」记「外包模式」开关（内存 Map，**重启即全部归零**）—— 见下方「状态模型」
 *   ② 给浏览器半边两个路由：读状态 / 切开关（都要带 sessionId）
 *   ③ 仅当**该会话**开着时，往它的 system prompt 塞一段说明（注入段全局注册，
 *      但 text 回调拿得到 assembly context → 按 context.agent.id 逐会话判定）
 *   ④ 记录「当前活跃会话」，供 wb.mjs 把每次外包归到某条会话上
 *   ⑤ 【故意不做】不提供"执行外包"的路由 —— 自注册路由免鉴权，若暴露
 *      "跑 CLI"的能力，等于给本机任何进程一个烧积分+执行命令的洞。
 *      真正执行只走插件自带的 tools/wb.mjs（由 agent 用 bash 工具调用）。
 *
 * ── 状态模型（2026-10-13 改为按会话）─────────────────────────────
 *   旧版：一个全局粘性开关落盘 ~/.dsh/outsource-state.json —— 两个毛病：
 *     · 重启后仍是「开」，而新进程还没构建过 prompt → promptReads=0
 *       → 自检误判成 INJECT_NEVER_READ → 按钮变红报假警（发一条消息才自愈）
 *     · 在 A 会话打开的开关，会凭空管到 B 会话（注入段是全局的）
 *   新版：sessions: Map<归一化 sessionId, {enabled, updatedAt, updatedBy}>，
 *     **纯内存**——不落盘，所以重启 = 全部关闭；开关只对「点它的那条会话」生效。
 *   ⚠️ 归一化：宿主侧 agent.id 形如 `session-<uuid>`，浏览器侧 props.sessionId
 *      是同一个串；一律用 normSid() 去掉 `session-` 前缀再当 key，两边才碰得上。
 *
 * 生效方式：host 改完要重启 DSH；client 改完要重启应用（官方端按启动快照发 bundle）。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-wb-outsource'

/**
 * 只硬依赖这两个服务（都在 0.2.0 内核里，且已被 dsh-raw-html / dsh-memory-lite
 * 实证可用）。⚠️ 数组式 inject 只要有一个不可用，回调就静默不执行 —— 所以下面
 * 仍然每处都做了存在性判断，宁可功能降级也不要拖垮加载。
 */
export const inject = ['webServer', 'systemPrompt']

const BASE = '/api/dsh-wb-outsource'
const SECTION_NAME = 'wb-outsource'
// ① 插件自带工具/手册的位置：用**自身文件位置**解析，不依赖任何安装到 ~/.dsh 的副本（便于打包分发）
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')
const EXEC = resolveFirst([
  path.join(PLUGIN_ROOT, 'tools', 'wb.mjs'),
  path.join(DSH_HOME, 'tools', 'wb.mjs'),
])
const SKILL = resolveFirst([
  path.join(PLUGIN_ROOT, 'skills', 'workbuddy-outsource', 'SKILL.md'),
  path.join(DSH_HOME, 'skills', 'workbuddy-outsource', 'SKILL.md'),
  path.join(DSH_HOME, 'plugin-stash', name, 'skills', 'workbuddy-outsource', 'SKILL.md'),
])

/**
 * ⚠️ 2026-10-13 实证的坑：官方端 profile 里那份插件副本**只有 lib/**（pnpm 的 file: 依赖
 * 只把被硬链接的文件带过去，`tools/` `skills/` 这类目录没跟过去），于是
 * `PLUGIN_ROOT/tools/wb.mjs` 根本不存在 —— 而插件却把这条**死路径**写进了 system prompt
 * （模型照抄执行 → `Cannot find module`，实测复现）。
 * 所以这里按候选表挑**第一个真实存在**的；一个都不存在时退回首选，让上层照旧报出来。
 */
function resolveFirst(candidates) {
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch { /* 忽略 */ }
  }
  return candidates[0]
}

// ② 账本 + 当前活跃会话（跟具体机器无关，放 DSH 家目录）
const LEDGER_FILE = path.join(DSH_HOME, 'wb-outsource-ledger.json')
const ACTIVE_FILE = path.join(DSH_HOME, 'wb-outsource-active.json')
const SESSION_LOG = path.join(DSH_HOME, 'wb-outsource-sessions.jsonl')
// ③ 旧版全局状态文件：只读来做提示，不再写（留着不动，见 README）
const LEGACY_STATE_FILE = path.join(DSH_HOME, 'outsource-state.json')

// ───────────────────────── 状态（按会话，纯内存） ─────────────────────────

/** 归一化 sid → { enabled: true, updatedAt, updatedBy }；**只存开着的会话**（关掉即删） */
const sessions = new Map()
let logger = undefined
let lastActiveSid = ''
// 注入自证：段被注册 / 被内核读过几次 / 最近一次什么时候读的
let injectError = ''
let statCache = { at: 0, sid: '', runs: 0, credits: 0 }
let promptRegistered = false
let sectionCalls = 0
let promptReads = 0
let lastPromptRead = 0
/** 逐会话自证：这一条会话的说明**真的**进过它的 system prompt 几次 */
const readsBySession = new Map()
const lastReadBySession = new Map()
let lastActiveWrite = 0

/** 会话 id 在不同层里带不带 `session-` 前缀不一致（agent.id 有、账本没有）→ 比较前归一化。 */
function normSid(v) {
  return String(v || '').replace(/^session-/, '')
}

function getRec(sid) {
  const key = normSid(sid)
  return key === '' ? undefined : sessions.get(key)
}

function isEnabled(sid) {
  const rec = getRec(sid)
  return rec !== undefined && rec.enabled === true
}

/** 切一条会话的开关；返回是否落定（sid 为空 → false）。关掉时连自证计数一起清。 */
function setEnabled(sid, enabled, by = 'button') {
  const key = normSid(sid)
  if (key === '') return false
  if (enabled === true) {
    sessions.set(key, { enabled: true, updatedAt: Date.now(), updatedBy: by })
  } else {
    sessions.delete(key)
    // 关掉 = 这条会话的注入不再存在，自证计数留着只会让人误解
    readsBySession.delete(key)
    lastReadBySession.delete(key)
  }
  return true
}

function enabledSessions() {
  return [...sessions.entries()].map(([sessionId, rec]) => ({
    sessionId,
    updatedAt: rec.updatedAt,
    updatedBy: rec.updatedBy,
    reads: readsBySession.get(sessionId) || 0,
  }))
}

/** 没带 sessionId 时用「当前活跃会话」兜底（curl 手测方便；浏览器半边总会带）。 */
function resolveSid(asked) {
  return normSid(asked) || normSid(lastActiveSid) || normSid(readActiveSession())
}

/** 读「当前活跃会话」（host 每步写的那个文件）。 */
function readActiveSession() {
  try {
    const rec = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'))
    if (rec && typeof rec.sessionId === 'string') return rec.sessionId
  } catch { /* 读不到就算了 */ }
  return ''
}

/** 旧版全局状态文件还在、且是开的时候提示一次（不影响运行，纯提示）。 */
function legacyStateHint() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, 'utf8'))
    return raw && raw.enabled === true
      ? 'legacy-global-state-ignored（旧全局开关 enabled=true 已不再生效；新版按会话、重启归零。可删 ' + LEGACY_STATE_FILE + '）'
      : null
  } catch {
    return null
  }
}

// ───────────────────────── 注入给模型的说明 ─────────────────────────

function buildPromptText(sid) {
  const st = sessionStat(sid)
  return [
  '【外包模式：本会话已开启 · 已外包 ' + st.runs + ' 次' + (st.runs > 0 ? ' / ' + st.credits.toFixed(2) + ' 积分' : '') + '（开关在输入框右侧 🥚；只对这条会话生效，重启后默认关）】',
  '',
  '🔴 **默认全外包：不用等主人开口，更不要每次问「要不要外包」** —— 主人在本会话把这个开关打开就是授权。',
  '💰 **成本口径：WorkBuddy 积分不算成本，DSH token 才算** → 判断标准只剩「能不能外包」：能就派，别再权衡划不划算；小活（十几行、读几个文件、写文档、跑核对）也派。',
  '🧠 省 token 纪律：派回来的产物**别整份读进上下文**（抽检 + 真机跑即可）；要通读大文件/大目录的活先派出去，只拿结论回来。',
  '非平凡活直接派单，**事后一句话汇报**（件数 / 积分 / 产物路径 / 验证结果），不要事前请示。',
  '',
  '⚡ 直接派单（别再自问「算不算小活」）：',
  '· 任何要写或改代码的活（十几行也算）、新建脚本/工具/文件',
  '· 批量改造 / 重构 / 搬砖替换 / 正则替换 / 按规范整理目录',
  '· 写文档 / 总结 / 说明 / 变更清单 / 生成测试 / 数据清洗 / 调研汇总 / 逐文件审计',
  '· 需要反复试错的活；只要「读文件 + 产出文件」能自包含，就派单（宁可多派，派错只花点积分）',
  '',
  '🚫 只有这三条红线自己干（并且要说明理由）：',
  '① 需要本会话对话上下文或主人偏好判断 ② 涉及密钥/凭据/隐私文件 ③ 必须真机验证（重启 DSH / 看界面 / 跑 GUI / CDP 摸页面）',
  '',
  '标准动作（一条命令）：',
  '  node "' + EXEC + '" "<5 行任务书>" --dir "<沙箱目录>" --include <相关文件或目录>',
  '· 任务书 = 目标 / 输入 / 输出 / 约束 / 验收 五段，自包含（它看不到本会话）；别把代码粘进去，用 --include 拷文件。',
  '· 长任务后台跑：`nohup node … > run.log 2>&1 &`（pwsh 起的会被文件沙箱拦）；怕它死就看 ~/.codebuddy/projects/<项目>/*.jsonl 的写入时间与条目数。',
  '· 产物一律先落沙箱（D:\\dsh-work\\wb-outsource\\）：**先体检（抽 3 条复核行号 / node --check / 试跑）再搬正主**，搬运与备份由你来。',
  '· 改 DSH 自身配置（profiles / ~/.dsh）可以在沙箱里改好，但搬运与备份由你来。',
  '',
  '完整手册（动手前先读）：' + SKILL,
  ].join('\n')
}

// ───────────────────────── 小工具 ─────────────────────────

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/** 状态快照（供路由与自检复用）。 */
export function snapshot(sid) {
  const key = normSid(sid)
  const rec = getRec(key)
  return {
    sessionId: key || null,
    enabled: rec !== undefined && rec.enabled === true,
    updatedAt: rec ? rec.updatedAt : 0,
    updatedBy: rec ? rec.updatedBy : 'none',
    sessions: enabledSessions(),
  }
}

/** 供离线自检使用：不依赖 ctx，直接切状态。 */
export function setEnabledForTest(sid, enabled, by = 'test') {
  setEnabled(sid, enabled, by)
  return snapshot(sid)
}

/** 本会话已外包几次/多少积分 —— 注入文本用它自报，让模型看得到自己有没有在偷懒。带 5 秒缓存。 */
function sessionStat(sid) {
  const key = normSid(sid)
  const now = Date.now()
  if (statCache.at !== 0 && now - statCache.at < 5000 && statCache.sid === key) return statCache
  let runs = 0
  let credits = 0
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'))
    for (const r of j.runs || []) {
      if (key !== '' && normSid(r.dshSession) === key) { runs += 1; credits += Number(r.credits) || 0 }
    }
  } catch { /* 账本还没生成 */ }
  statCache = { at: now, sid: key, runs: runs, credits: Math.round(credits * 100) / 100 }
  return statCache
}

/**
 * 注入健康度。⚠️ 2026-10-13 改：**`promptReads === 0` 不再算故障**。
 * 新进程在「发第一条消息之前」本来就没构建过 system prompt，旧版把它判成
 * INJECT_NEVER_READ → 按钮变红报假警（重启后必现，发一条消息才自愈）。
 * 现在只把**真注册失败**当 warning；「还没读过」降级成 pending（中性提示）。
 */
export function health(sid) {
  const key = normSid(sid)
  const enabled = isEnabled(key)
  const reads = enabled && key !== '' ? readsBySession.get(key) || 0 : 0
  const warning = enabled && promptRegistered === false ? 'INJECT_NOT_REGISTERED' : null
  return {
    promptRegistered: promptRegistered,
    injectError: injectError || null,
    promptReads: promptReads,
    sectionCalls: sectionCalls,
    lastPromptReadAt: lastPromptRead || null,
    sessionReads: reads,
    lastSessionReadAt: (key !== '' && lastReadBySession.get(key)) || null,
    pending: enabled && reads === 0,
    pendingNote: enabled && reads === 0
      ? '开关已开，但这条会话还没构建过 system prompt（正常：还没发过消息）。发一条消息后 sessionReads 会 > 0。'
      : null,
    legacy: legacyStateHint(),
    warning: warning,
  }
}

/** 供离线自检使用：返回注入给模型的文本（该会话关时为 ''）。 */
export function promptTextForTest(sid) {
  return isEnabled(sid) ? buildPromptText(sid) : ''
}

// ───────────────────────── 插件主体 ─────────────────────────

export function apply(ctx) {
  logger = ctx.logger
  // 重启即归零 —— 这里就是「每次重启关掉外包」的实现点
  sessions.clear()
  // 自证计数归本次注册所有（同一进程里 HMR 重挂时也要从 0 起，否则会沿用旧记录骗自己）
  promptRegistered = false
  injectError = ''
  sectionCalls = 0
  promptReads = 0
  lastPromptRead = 0
  readsBySession.clear()
  lastReadBySession.clear()

  // ① systemPrompt 段：text 用「函数」形式，开关一变内容就跟着变
  //    （raw-html 的实证写法；DSH 会把 system prompt 的变化显示成一条
  //     「系统提示词」条目 —— 这是**有意为之**的可见性，不做隐形注入）
  // ⚠️ 实证结论（2026-10-12）：**systemPrompt 必须留在静态 inject 数组里**。
  //    改成动态 ctx.inject(['systemPrompt'], …) 之后回调根本不触发（实测 promptRegistered=false、
  //    按钮报警）；而静态数组 + ctx.get 是已验证可用形式（会话日志里有 6 条 system prompt 含注入段）。
  // ⚠️ 实证结论（2026-10-13）：text 回调收到的是 **assembly context**，
  //    `context.agent` = 正在构建 prompt 的那条会话（= assembleContextFor(agent, signal)，
  //    见 @deepseek-ai/dsh-agent）。段本身是全局注册的，但用 agent.id 就能逐会话判定。
  const registerPrompt = (sp) => {
    if (sp === undefined || sp === null || typeof sp.section !== 'function') {
      injectError = 'systemPrompt.section 不可用（typeof=' + typeof sp + '）'
      ctx.logger?.warn?.('[wb-outsource] ' + injectError + ' → 开关能切但不会生效（/probe 报 INJECT_NOT_REGISTERED）')
      return false
    }
    ctx.effect(
      () =>
        sp.section({
          name: SECTION_NAME,
          order: 150,
          text: (context) => {
            // 被调用 = 内核正在为某条会话构建 system prompt。
            sectionCalls += 1
            const sid = normSid(context && context.agent && context.agent.id)
            // 拿不到会话 / 该会话没开 → 不注入（宁可少注入，也不要在别人的会话里乱说）
            if (sid === '' || !isEnabled(sid)) return ''
            // 返回了非空文本 = 这段说明**真的**进了这条会话的 prompt。这条计数就是硬证据。
            promptReads += 1
            lastPromptRead = Date.now()
            readsBySession.set(sid, (readsBySession.get(sid) || 0) + 1)
            lastReadBySession.set(sid, lastPromptRead)
            return buildPromptText(sid)
          },
        }),
      'dsh-wb-outsource.prompt',
    )
    promptRegistered = true
    ctx.logger?.info?.('[wb-outsource] system prompt 注入段已注册（按会话生效）')
    return true
  }
  if (!registerPrompt(ctx.get('systemPrompt'))) {
    // 兜底：万一以后内核行为又变，动态再等一次（可能不触发，但不会更糟）
    try { ctx.inject(['systemPrompt'], (sp) => { registerPrompt(sp) }) } catch (error) { /* 忽略 */ }
  }

  // ② 路由：只读状态 + 切开关，**没有**执行能力
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('[wb-outsource] webServer 不可用，未挂载任何路由')
    return
  }

  const routes = [
    {
      kind: 'exact',
      path: `${BASE}/state`,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          if (req.method === 'POST' || req.method === 'PUT') {
            const body = await readJson(req)
            if (body === undefined || typeof body.enabled !== 'boolean') {
              sendJson(res, 400, { ok: false, error: '需要 body: {"sessionId":"…","enabled":true|false}' })
              return
            }
            const sid = resolveSid(body.sessionId)
            if (sid === '') {
              sendJson(res, 400, { ok: false, error: '拿不到 sessionId（按会话记账的开关必须带会话）' })
              return
            }
            setEnabled(sid, body.enabled, typeof body.by === 'string' ? body.by : 'button')
            ctx.logger?.info?.(`[wb-outsource] 会话 ${sid} 外包模式 → ${body.enabled ? '开' : '关'}`)
            sendJson(res, 200, { ok: true, persisted: false, ...snapshot(sid), ...health(sid) })
            return
          }
          const sid = resolveSid(url.searchParams.get('sessionId'))
          sendJson(res, 200, { ok: true, ...snapshot(sid), ...health(sid) })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorText(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${BASE}/reset`,
      // 全部关掉（运维/脚本用：重启天然就是全关，这条方便不重启也清零）
      handler: (_req, res) => {
        const before = enabledSessions()
        sessions.clear()
        readsBySession.clear()
        lastReadBySession.clear()
        sendJson(res, 200, { ok: true, cleared: before.length, sessions: [] })
      },
    },
    {
      kind: 'exact',
      path: `${BASE}/ledger`,
      handler: (req, res) => {
        // 只读本地账本文件 —— 本插件不 spawn 任何进程、不联网
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          // 没带 sessionId 时回退到「当前活跃会话」，这样本会话那行照样对
          const asked = url.searchParams.get('sessionId') || ''
          const sid = normSid(asked) || normSid(lastActiveSid) || normSid(readActiveSession())
          const j = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'))
          const runs = j.runs || []
          const mine = sid === '' ? [] : runs.filter((r) => normSid(r.dshSession) === sid)
          const session = sid === ''
            ? null
            : { runs: mine.length, credits: Math.round(mine.reduce((a, r) => a + (Number(r.credits) || 0), 0) * 100) / 100, sessionId: sid }
          sendJson(res, 200, { ok: true, updatedAt: j.updatedAt, totals: j.totals || null, sessionId: sid || null, session, runs: (sid === '' ? runs : mine).slice(0, 10) })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: errorText(error), totals: null, runs: [] })
        }
      },
    },
    {
      kind: 'exact',
      path: `${BASE}/probe`,
      handler: (_req, res) => {
        const active = normSid(lastActiveSid) || normSid(readActiveSession())
        sendJson(res, 200, {
          ok: true,
          plugin: name,
          route: BASE,
          mode: 'per-session-memory（重启归零；开关只对点它的会话生效）',
          activeSessionId: active || null,
          enabledSessions: enabledSessions(),
          ...snapshot(active),
          ...health(active),
          runner: EXEC,
          runnerExists: fs.existsSync(EXEC),
          skill: SKILL,
          skillExists: fs.existsSync(SKILL),
          note: '只读探针。本插件不暴露任何"执行外包"的路由（避免免鉴权路由变成烧积分/执行命令的洞）。',
        })
      },
    },
  ]

  for (const route of routes) {
    ctx.effect(() => webServer.register(route), `wb-outsource: ${route.path}`)
  }
  // ④ 记录「当前活跃会话」：agent/pre-step 是 agent-scoped 事件，顶层插件收得到
  //    （dsh-brake 同款写法已验证）。节流 2 秒 + 换会话立刻写。
  //    ⚠️ 这里绝不能抛错、也不能 await 太久，否则会拖慢 agent 的每一步。
  ctx.effect(() => ctx.on('agent/pre-step', (payload, next) => {
    try {
      const sid = payload && payload.agent && payload.agent.id
      if (typeof sid === 'string' && sid !== '') {
        const now = Date.now()
        if (sid !== lastActiveSid || now - lastActiveWrite > 2000) {
          lastActiveSid = sid
          lastActiveWrite = now
          const rec = { sessionId: sid, at: now }
          fs.mkdirSync(DSH_HOME, { recursive: true })
          fs.writeFileSync(ACTIVE_FILE + '.tmp', JSON.stringify(rec), 'utf8')
          fs.renameSync(ACTIVE_FILE + '.tmp', ACTIVE_FILE)
          fs.appendFileSync(SESSION_LOG, JSON.stringify(rec) + '\n', 'utf8')
        }
      }
    } catch (error) { /* 记账失败绝不打扰 agent */ }
    return next()
  }), 'dsh-wb-outsource.active')

  const legacy = legacyStateHint()
  if (legacy !== null) ctx.logger?.warn?.('[wb-outsource] ' + legacy)
  ctx.logger?.info?.(`[wb-outsource] 路由已挂载 ${routes.length} 条（${BASE}）；模式=按会话（重启归零），当前开着 ${sessions.size} 条会话`)
}
