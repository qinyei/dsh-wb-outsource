#!/usr/bin/env node
/**
 * wb-credits.mjs —— 汇总 WorkBuddy CLI 的积分消耗
 *
 *   node wb-credits.mjs                  # 表格：每个 CLI 会话花了多少积分
 *   node wb-credits.mjs --json           # 机器可读
 *   node wb-credits.mjs --ledger         # 刷新 ~/.dsh/wb-outsource-ledger.json（供 DSH 插件显示）
 *   node wb-credits.mjs --session <id>   # 只算某个会话（wb.mjs 单次跑完时用）
 *
 * 数据来源：`~/.codebuddy/projects/<项目>/<会话id>.jsonl`
 *   每条请求的记录里带 `credit` 字段（积分，浮点）。同一请求可能在多行里重复出现
 *   → 按 conversationRequestId 去重、取该请求的 credit（不是逐行相加，否则会翻倍）。
 *
 * ⚠️ 这是**本地账本**，不是服务端账单：与 WorkBuddy 界面上显示的余额扣减可能有极小差异
 * （重试/取消/服务端返还等情况本地看不到）。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = os.homedir()
const PROJECTS = path.join(HOME, '.codebuddy', 'projects')
const DSH_HOME = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(HOME, '.dsh')
const LEDGER = path.join(DSH_HOME, 'wb-outsource-ledger.json')
const SESSION_MAP = path.join(DSH_HOME, 'wb-outsource-sessions-map.json')

/** 产物标签 → DSH 会话。由 wb.mjs 每次外包后写进映射文件；这里只读，不去猜产物目录在哪。 */
function sessionByLabel() {
  const out = new Map()
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_MAP, 'utf8'))
    for (const [label, sid] of Object.entries(raw)) if (typeof sid === 'string' && sid !== '') out.set(label, sid)
  } catch { /* 还没生成就算了（老数据只有累计口径） */ }
  return out
}

const asJson = process.argv.includes('--json')
const writeLedger = process.argv.includes('--ledger')
const onlyIdx = process.argv.indexOf('--session')
const onlySession = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null

/** 收集所有 credit 值（递归，键名恰好是 credit） */
function collectCredits(node, out) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const v of node) collectCredits(v, out)
    return
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'credit' && typeof v === 'number') out.push(v)
    else collectCredits(v, out)
  }
}

/** 解析一个 jsonl：逐行累加积分 + 找出 cwd/模型 */
function scanSession(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  // ⚠️ 千万不要按 conversationRequestId 去重 —— 它是每个「会话」一个 id，
  //    会把同一会话的多条请求折叠成一条（实测因此少算 3.4 倍：1.63 → 0.48）。
  //    实测：含 usage 的行 100% 也含 credit → 直接逐行累加。
  let credits = 0
  let cwd = ''
  let model = ''
  let requests = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let firstTs = 0
  let lastTs = 0

  for (const line of lines) {
    let j
    try { j = JSON.parse(line) } catch { continue }
    const pd = (j && j.providerData) || {}
    const creditsHere = []
    collectCredits(j, creditsHere)
    if (creditsHere.length > 0) credits += Math.max(...creditsHere) // 一行 = 一条模型请求
    if (!cwd && typeof j.cwd === 'string' && j.cwd) cwd = j.cwd
    if (!model && typeof pd.model === 'string' && pd.model) model = pd.model
    const ru = pd.rawUsage || pd.usage
    if (ru && typeof ru === 'object') {
      requests += 1
      inputTokens += Number(ru.prompt_tokens) || 0
      outputTokens += Number(ru.completion_tokens) || 0
      const d = (ru.prompt_tokens_details || {})
      cacheRead += Number(d.cached_tokens) || 0
    }
    const ts = Number(j.timestamp) || 0
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts
      if (ts > lastTs) lastTs = ts
    }
  }

  return { file, sessionId: path.basename(file, '.jsonl'), cwd, model, requests, inputTokens, outputTokens, cacheRead, credits, firstTs, lastTs, lines: lines.length }
}

function collectSessions() {
  const out = []
  let dirs = []
  try { dirs = fs.readdirSync(PROJECTS, { withFileTypes: true }) } catch { return out }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dir = path.join(PROJECTS, d.name)
    let files = []
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) {
      const sid = path.basename(f, '.jsonl')
      if (onlySession !== null && sid !== onlySession) continue
      try { out.push(scanSession(path.join(dir, f))) } catch { /* skip */ }
    }
  }
  out.sort((a, b) => a.firstTs - b.firstTs)
  return out
}

/** 把 CLI 会话 cwd 跟我们的外包 run 目录对上（cwd 形如 d:\dsh-work\wb-outsource\<标签>） */
function matchRunLabel(cwd) {
  if (!cwd) return null
  const norm = cwd.replace(/\\/g, '/').toLowerCase()
  const i = norm.indexOf('/wb-outsource/')
  if (i < 0) return null
  return norm.slice(i + '/wb-outsource/'.length)
}

const sessions = collectSessions()
const fmt = (n, d = 2) => Number(n).toFixed(d)

if (asJson) {
  console.log(JSON.stringify({ generatedAt: Date.now(), sessions }, null, 2))
} else {
  console.log('== WorkBuddy CLI 会话积分账本（本地）==')
  console.log('')
  let total = 0
  for (const s of sessions) {
    total += s.credits
    const when = s.firstTs ? new Date(s.firstTs).toLocaleString('zh-CN', { hour12: false }) : '-'
    console.log(`[${when}] ${s.sessionId}`)
    console.log(`   cwd    : ${s.cwd || '-'}`)
    console.log(`   模型   : ${s.model || '-'}   请求数: ${s.requests}   行数: ${s.lines}`)
    console.log(`   token  : in=${s.inputTokens} out=${s.outputTokens} cacheRead=${s.cacheRead}`)
    console.log(`   积分   : ${fmt(s.credits)}`)
    console.log('')
  }
  console.log(`合计：${sessions.length} 个会话，${fmt(total)} 积分`)
}

if (writeLedger) {
  const sessionMap = sessionByLabel()
  const byLabel = {}
  let total = 0
  for (const s of sessions) {
    const label = matchRunLabel(s.cwd)
    total += s.credits
    const key = label || s.sessionId
    const sid = sessionMap.get(key) || null
    if (!byLabel[key]) byLabel[key] = { label: key, dshSession: sid, sessions: 0, credits: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, firstTs: s.firstTs, lastTs: s.lastTs }
    const b = byLabel[key]
    b.sessions += 1
    b.credits += s.credits
    b.inputTokens += s.inputTokens
    b.outputTokens += s.outputTokens
    b.cacheRead += s.cacheRead
    b.firstTs = Math.min(b.firstTs || s.firstTs || 0, s.firstTs || Infinity) || s.firstTs
    b.lastTs = Math.max(b.lastTs || 0, s.lastTs || 0)
  }
  const ledger = {
    updatedAt: Date.now(),
    source: 'wb-credits.mjs（本地 CLI 会话 jsonl 的 credit 字段汇总）',
    note: '本地账本，可能与 WorkBuddy 服务端账单有极小差异（重试/取消/返还本地看不到）',
    totals: {
      sessions: sessions.length,
      credits: Math.round(total * 100) / 100,
      runs: Object.keys(byLabel).length,
      bySession: Object.values(byLabel).reduce((acc, r) => {
        if (!r.dshSession) return acc
        const key = String(r.dshSession).replace(/^session-/, '')
        const b = acc[key] || (acc[key] = { runs: 0, credits: 0 })
        b.runs += 1
        b.credits = Math.round((b.credits + r.credits) * 100) / 100
        return acc
      }, {}),
    },
    runs: Object.values(byLabel).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)),
  }
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true })
  fs.writeFileSync(LEDGER + '.tmp', JSON.stringify(ledger, null, 2), 'utf8')
  fs.renameSync(LEDGER + '.tmp', LEDGER)
  if (!asJson) console.log(`\n已写入账本：${LEDGER}`)
}
