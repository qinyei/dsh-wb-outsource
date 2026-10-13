// dsh-wb-outsource · 按会话版的行为级离线自检
//
// 用法：  node verify-persession.mjs [lib/index.js 路径]
//
// 它不 grep 源码字符串，而是**把 host 真跑起来**：造一个假 ctx（webServer /
// systemPrompt / effect / on / inject）、假 req/res，然后直接调用路由与
// systemPrompt 段的 text 回调，检查按会话的开关与注入是否真的按预期工作。
//
// 重点回归：**重启（= 新进程 apply 一次）之后，任何会话都不许报 warning。**
// 旧版把「新进程还没构建过 prompt」误判成 INJECT_NEVER_READ → 按钮变红报假警。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const target = path.resolve(process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'lib', 'index.js'))

// 隔离 DSH_HOME：绝不要碰真实的 ~/.dsh 文件
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wbo-verify-'))
process.env.DSH_HOME = TMP
// 造出「本机真实形状」：$DSH_HOME/tools/wb.mjs 与 $DSH_HOME/skills/… 存在
// （必须在 import 目标模块**之前**建好 —— 路径回退是模块加载时解析的）
fs.mkdirSync(path.join(TMP, 'tools'), { recursive: true })
fs.mkdirSync(path.join(TMP, 'skills', 'workbuddy-outsource'), { recursive: true })
fs.writeFileSync(path.join(TMP, 'tools', 'wb.mjs'), '// fake runner\n', 'utf8')
fs.writeFileSync(path.join(TMP, 'skills', 'workbuddy-outsource', 'SKILL.md'), '// fake skill\n', 'utf8')

let pass = 0
let fail = 0
function ok(label, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ok   ${label}${extra ? '  ' + extra : ''}`) }
  else { fail += 1; console.log(`  FAIL ${label}${extra ? '  ' + extra : ''}`) }
}
function section(title) { console.log(`\n── ${title}`) }

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v },
    end(t) { this.body = String(t ?? '') },
  }
}
function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    [Symbol.asyncIterator]() {
      let i = 0
      return { next: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }
    },
  }
}

/** 造一个假插件 ctx，返回 { ctx, routes, sections, events } */
function makeCtx({ systemPrompt = true } = {}) {
  const routes = []
  const sections = []
  const events = []
  const webServer = { register: (route) => { routes.push(route); return () => {} } }
  const sp = systemPrompt
    ? { section: (s) => { sections.push(s); return () => {} } }
    : undefined
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    get: (name) => (name === 'webServer' ? webServer : name === 'systemPrompt' ? sp : undefined),
    inject: () => {},
    on: (name, handler) => { events.push({ name, handler }); return () => {} },
  }
  return { ctx, routes, sections, events }
}

async function callRoute(routes, p, method = 'GET', body, query = '') {
  const route = routes.find((r) => r.path === p)
  if (!route) throw new Error('route not mounted: ' + p)
  const res = fakeRes()
  await route.handler(fakeReq(method, p + query, body), res)
  let json = null
  try { json = JSON.parse(res.body) } catch { /* 非 JSON */ }
  return { status: res.statusCode, json }
}

const A = 'session-aaaa-1111'
const B = 'session-bbbb-2222'
const A_NORM = 'aaaa-1111'
const B_NORM = 'bbbb-2222'

section('1. 模块形状')
const mod = await import(pathToFileURL(target).href)
ok('导出 name / inject / apply', mod.name === 'dsh-wb-outsource' && Array.isArray(mod.inject) && typeof mod.apply === 'function')
ok('inject 仍含 webServer + systemPrompt', mod.inject.join(',') === 'webServer,systemPrompt')

section('2. 重启后（新进程）不许报假警')
const h1 = makeCtx()
mod.apply(h1.ctx)
{
  const st = await callRoute(h1.routes, '/api/dsh-wb-outsource/state', 'GET', undefined, '?sessionId=' + A)
  ok('GET /state → ok', st.status === 200 && st.json.ok === true)
  ok('重启后该会话默认关', st.json.enabled === false, `enabled=${st.json.enabled}`)
  ok('★ 重启后 warning 必须是 null（核心回归）', st.json.warning === null, `warning=${JSON.stringify(st.json.warning)}`)
  ok('重启后 pending 也是 false（没开就没什么可 pending）', st.json.pending === false)
  ok('注入段已注册', st.json.promptRegistered === true)
  ok('promptReads 起始为 0', st.json.promptReads === 0)
  const probe = await callRoute(h1.routes, '/api/dsh-wb-outsource/probe')
  ok('probe 报 mode=按会话', typeof probe.json.mode === 'string' && probe.json.mode.includes('per-session'), probe.json.mode)
  ok('probe 的 enabledSessions 为空', Array.isArray(probe.json.enabledSessions) && probe.json.enabledSessions.length === 0)
  ok('probe 无 warning', probe.json.warning === null)
}

section('3. 开一条会话 = 只影响这一条')
{
  const on = await callRoute(h1.routes, '/api/dsh-wb-outsource/state', 'POST', { sessionId: A, enabled: true, by: 'button' })
  ok('POST 开 A → enabled true', on.status === 200 && on.json.enabled === true)
  ok('刚开、还没构建过 prompt → pending true（中性，不是 warning）', on.json.pending === true && on.json.warning === null, `pending=${on.json.pending}`)
  ok('sessionId 已归一化', on.json.sessionId === A_NORM, `sessionId=${on.json.sessionId}`)

  const getA = await callRoute(h1.routes, '/api/dsh-wb-outsource/state', 'GET', undefined, '?sessionId=' + A)
  ok('GET A → 开', getA.json.enabled === true)
  const getB = await callRoute(h1.routes, '/api/dsh-wb-outsource/state', 'GET', undefined, '?sessionId=' + B)
  ok('★ GET B → 关（不串会话）', getB.json.enabled === false)

  mod.setEnabledForTest(A, true, 'test')
  ok('注入文本：开着的会话非空', mod.promptTextForTest(A).includes('外包模式'))
  ok('注入文本：开着的会话含"本会话已开启"', mod.promptTextForTest(A).includes('本会话已开启'))
  ok('注入文本：没开的会话为空串', mod.promptTextForTest(B) === '')
  ok('注入文本：前缀不同也认（session- 前缀无关）', mod.promptTextForTest('session-' + A_NORM).includes('外包模式'))
}

section('4. systemPrompt 段的 text 回调按会话判定')
{
  ok('已注册 1 个 section', h1.sections.length === 1, `count=${h1.sections.length}`)
  const s = h1.sections[0]
  ok('section.name 正确', s.name === 'wb-outsource')
  ok('text 是函数（getter）', typeof s.text === 'function')

  const tA = s.text({ agent: { id: A } })
  ok('★ 为 A 构建 prompt → 注入文本', typeof tA === 'string' && tA.includes('外包模式'), JSON.stringify(String(tA).slice(0, 40)))
  const tB = s.text({ agent: { id: B } })
  ok('★ 为 B 构建 prompt → 空串（不注入）', tB === '', JSON.stringify(tB))
  const tNo = s.text(undefined)
  ok('没有 context.agent 时不抛错、返回空串', tNo === '')
  const tGarbage = s.text({ agent: {} })
  ok('agent 没有 id 时返回空串', tGarbage === '')

  const after = await callRoute(h1.routes, '/api/dsh-wb-outsource/state', 'GET', undefined, '?sessionId=' + A)
  ok('A 的 sessionReads 计数 = 1', after.json.sessionReads === 1, `sessionReads=${after.json.sessionReads}`)
  ok('读了之后 pending 变 false', after.json.pending === false)
  ok('promptReads（硬证据）只统计真正返回过文本的', after.json.promptReads === 1, `promptReads=${after.json.promptReads}`)
  ok('sectionCalls 统计所有构建（含没注入的）', after.json.sectionCalls === 4, `sectionCalls=${after.json.sectionCalls}`)
  const getB2 = await callRoute(h1.routes, '/api/dsh-wb-outsource/state', 'GET', undefined, '?sessionId=' + B)
  ok('B 的 sessionReads 仍是 0', getB2.json.sessionReads === 0)
  ok('B 没开 → pending false', getB2.json.pending === false)
}

section('5. 关掉 / 全关')
{
  const off = await callRoute(h1.routes, '/api/dsh-wb-outsource/state', 'POST', { sessionId: A, enabled: false })
  ok('POST 关 A → enabled false', off.json.enabled === false)
  ok('关掉后 sessionReads 归零（不再有该会话的记录）', off.json.sessionReads === 0)
  ok('关掉后注入文本为空', mod.promptTextForTest(A) === '')
  const s = h1.sections[0]
  ok('关掉后为 A 构建 prompt → 空串', s.text({ agent: { id: A } }) === '')

  await callRoute(h1.routes, '/api/dsh-wb-outsource/state', 'POST', { sessionId: A, enabled: true })
  await callRoute(h1.routes, '/api/dsh-wb-outsource/state', 'POST', { sessionId: B, enabled: true })
  const probe = await callRoute(h1.routes, '/api/dsh-wb-outsource/probe')
  ok('两条会话同时开着 → enabledSessions=2', probe.json.enabledSessions.length === 2)
  const reset = await callRoute(h1.routes, '/api/dsh-wb-outsource/reset', 'POST', {})
  ok('POST /reset 清掉全部', reset.json.ok === true && reset.json.cleared === 2)
  const afterReset = await callRoute(h1.routes, '/api/dsh-wb-outsource/probe')
  ok('reset 后 enabledSessions 为空', afterReset.json.enabledSessions.length === 0)
}

section('6. 真故障仍然要报（不能修成"永远不报警"）')
{
  const h2 = makeCtx({ systemPrompt: false }) // 内核没给 systemPrompt 服务
  mod.apply(h2.ctx)
  await callRoute(h2.routes, '/api/dsh-wb-outsource/state', 'POST', { sessionId: A, enabled: true })
  const st = await callRoute(h2.routes, '/api/dsh-wb-outsource/state', 'GET', undefined, '?sessionId=' + A)
  ok('★ 注册失败 → warning = INJECT_NOT_REGISTERED', st.json.warning === 'INJECT_NOT_REGISTERED', `warning=${JSON.stringify(st.json.warning)}`)
  ok('注册失败时有 injectError 说明', typeof st.json.injectError === 'string' && st.json.injectError.length > 0)
  ok('没注册成功 → 没有 section 可调（sections 为空）', h2.sections.length === 0)
  // 关掉之后不该再报
  await callRoute(h2.routes, '/api/dsh-wb-outsource/state', 'POST', { sessionId: A, enabled: false })
  const st2 = await callRoute(h2.routes, '/api/dsh-wb-outsource/state', 'GET', undefined, '?sessionId=' + A)
  ok('关掉后即使注册失败也不报警', st2.json.warning === null)
}

section('7. 参数与兜底')
{
  const h3 = makeCtx()
  mod.apply(h3.ctx)
  const bad = await callRoute(h3.routes, '/api/dsh-wb-outsource/state', 'POST', { enabled: true }) // 没带 sessionId 且无活跃会话
  ok('不带 sessionId 且无活跃会话 → 400', bad.status === 400, `status=${bad.status}`)
  const bad2 = await callRoute(h3.routes, '/api/dsh-wb-outsource/state', 'POST', { sessionId: A, enabled: 'yes' })
  ok('enabled 不是布尔 → 400', bad2.status === 400)
  // 写一个假的「活跃会话」文件，验证不带参数时能兜底
  fs.mkdirSync(TMP, { recursive: true })
  fs.writeFileSync(path.join(TMP, 'wb-outsource-active.json'), JSON.stringify({ sessionId: B, at: Date.now() }), 'utf8')
  await callRoute(h3.routes, '/api/dsh-wb-outsource/state', 'POST', { sessionId: B, enabled: true })
  const noSid = await callRoute(h3.routes, '/api/dsh-wb-outsource/state', 'GET')
  ok('不带 sessionId → 回退到当前活跃会话', noSid.json.sessionId === B_NORM && noSid.json.enabled === true, JSON.stringify(noSid.json.sessionId))
  const ledger = await callRoute(h3.routes, '/api/dsh-wb-outsource/ledger')
  ok('ledger 在没账本文件时也不炸（ok:false 或 ok:true）', typeof ledger.json.ok === 'boolean')
  // 假活跃会话文件能让不带 sid 的 POST 走通
  const noSidPost = await callRoute(h3.routes, '/api/dsh-wb-outsource/state', 'POST', { enabled: false })
  ok('不带 sessionId 的 POST 用活跃会话兜底', noSidPost.json.enabled === false)
}

section('8. agent/pre-step 记账（仍要能写活跃会话）')
{
  const h4 = makeCtx()
  mod.apply(h4.ctx)
  const ev = h4.events.find((e) => e.name === 'agent/pre-step')
  ok('挂上了 agent/pre-step', ev !== undefined)
  let called = 0
  if (ev) ev.handler({ agent: { id: 'session-cccc-3333' } }, () => { called += 1 })
  ok('pre-step 调了 next()', called === 1)
  const rec = JSON.parse(fs.readFileSync(path.join(TMP, 'wb-outsource-active.json'), 'utf8'))
  ok('活跃会话落盘正确', rec.sessionId === 'session-cccc-3333', JSON.stringify(rec))
  ok('会话时间线也写了', fs.readFileSync(path.join(TMP, 'wb-outsource-sessions.jsonl'), 'utf8').includes('cccc-3333'))
}

section('9. 不碰旧状态文件（只提示）')
{
  fs.writeFileSync(path.join(TMP, 'outsource-state.json'), JSON.stringify({ enabled: true, updatedAt: Date.now(), updatedBy: 'button' }), 'utf8')
  const h5 = makeCtx()
  mod.apply(h5.ctx)
  const st = await callRoute(h5.routes, '/api/dsh-wb-outsource/state', 'GET', undefined, '?sessionId=' + A)
  ok('★ 旧全局 enabled=true 不再让任何会话变开', st.json.enabled === false)
  ok('★ 旧状态存在时 warning 仍为 null（提示放 legacy 字段）', st.json.warning === null)
  ok('legacy 字段有提示', typeof st.json.legacy === 'string' && st.json.legacy.includes('legacy-global-state-ignored'), String(st.json.legacy))
  ok('提示里点名了旧文件路径', String(st.json.legacy).includes('outsource-state.json'))
}

section('10. 注入给模型的路径必须是活的')
{
  const pluginRoot = path.dirname(path.dirname(target))
  const h6 = makeCtx()
  mod.apply(h6.ctx)
  const probe = await callRoute(h6.routes, '/api/dsh-wb-outsource/probe')
  ok('★ probe.runnerExists = true', probe.json.runnerExists === true, String(probe.json.runner))
  ok('runner 确实是个文件', fs.existsSync(probe.json.runner) && fs.statSync(probe.json.runner).isFile())
  ok('★ probe.skillExists = true', probe.json.skillExists === true, String(probe.json.skill))
  mod.setEnabledForTest(A, true, 'test')
  const text = mod.promptTextForTest(A)
  const m = /node "([^"]+wb\.mjs)"/.exec(text)
  ok('注入文本里有 wb.mjs 命令行', m !== null)
  ok('★ 注入文本里那条路径真实存在（本机踩过的坑）', m !== null && fs.existsSync(m[1]), m ? m[1] : 'n/a')
  const skillLine = /完整手册（动手前先读）：(.+)$/m.exec(text)
  ok('注入文本里的 SKILL 路径真实存在', skillLine !== null && fs.existsSync(skillLine[1].trim()), skillLine ? skillLine[1].trim() : 'n/a')
  // 插件自带 tools/ 时优先用它自己那份（可分发性）
  if (fs.existsSync(path.join(pluginRoot, 'tools', 'wb.mjs'))) {
    ok('自带 tools/ 存在时优先用插件自己那份', probe.json.runner.startsWith(pluginRoot), String(probe.json.runner))
  } else {
    console.log('  skip 自带 tools/ 不存在（说明目标是临时副本）→ 跳过"优先用自己那份"断言')
  }

  // 模拟「官方端 profile 里那份副本」：只有 lib/，没有 tools/ 与 skills/
  const fakeRoot = path.join(TMP, 'fakeprofile')
  fs.mkdirSync(path.join(fakeRoot, 'lib'), { recursive: true })
  fs.copyFileSync(target, path.join(fakeRoot, 'lib', 'index.js'))
  const modFake = await import(pathToFileURL(path.join(fakeRoot, 'lib', 'index.js')).href)
  const h7 = makeCtx()
  modFake.apply(h7.ctx)
  const probeFake = await callRoute(h7.routes, '/api/dsh-wb-outsource/probe')
  ok('★ 没有自带 tools/ 时回退到 $DSH_HOME/tools/wb.mjs', probeFake.json.runner === path.join(TMP, 'tools', 'wb.mjs'), String(probeFake.json.runner))
  ok('★ 回退后的 runner 真实存在（旧版就是死在这条）', fs.existsSync(probeFake.json.runner))
  modFake.setEnabledForTest(A, true, 'test')
  const fakeText = modFake.promptTextForTest(A)
  const mf = /node "([^"]+wb\.mjs)"/.exec(fakeText)
  ok('回退后注入文本里的路径也真实存在', mf !== null && fs.existsSync(mf[1]), mf ? mf[1] : 'n/a')
  ok('没有自带 skills/ 时 SKILL 也有活路径', probeFake.json.skillExists === true, String(probeFake.json.skill))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}`)
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 忽略 */ }
process.exit(fail === 0 ? 0 : 1)
