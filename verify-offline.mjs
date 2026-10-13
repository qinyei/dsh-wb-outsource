/**
 * dsh-wb-outsource — 离线自检（不启动 DSH 也能跑）
 *
 *   node verify-offline.mjs
 *
 * 定位：**只做静态结构检查** —— ① 清单/打包契约 ② host 安全性与结构 ③ client
 * bundle 形状与安全写法 ④ 注入文案存在性（宽松）。
 *
 * ⚠️ 行为语义（按会话开关、重启归零、注入按会话判定、路径回退……）交给
 *    verify-persession.mjs（它把 host 真跑起来），这里**不重复**。
 * ⚠️ 这里**不把注入文案整句硬编码** —— 文案一改就红，正是它以前烂掉的原因。
 *    只查关键词 / 结构：text 是函数、文本含「外包模式」「wb.mjs」「SKILL.md」等。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
const fails = []

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fails.push(name + (extra ? `（${extra}）` : ''))
    console.log(`  ✗ ${name}${extra ? `（${extra}）` : ''}`)
  }
}

function group(title) {
  console.log(`\n${title}`)
}

const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'))
const hostSrc = fs.readFileSync(path.join(here, 'lib', 'index.js'), 'utf8')
const clientSrc = fs.readFileSync(path.join(here, 'lib', 'client.js'), 'utf8')
const wbSrc = fs.readFileSync(path.join(here, 'tools', 'wb.mjs'), 'utf8')
const skillSrc = fs.readFileSync(path.join(here, 'skills', 'workbuddy-outsource', 'SKILL.md'), 'utf8')
const creditsSrc = fs.readFileSync(path.join(here, 'tools', 'wb-credits.mjs'), 'utf8')

// ── ① 清单、依赖与打包契约 ─────────────────────────────────────
group('① 清单、依赖与打包契约')
ok('name 正确', pkg.name === 'dsh-wb-outsource')
ok('type=module', pkg.type === 'module')
ok('main 指向 lib/index.js', pkg.main === 'lib/index.js')
ok("dsh.client.platform === 'web'", pkg.dsh?.client?.platform === 'web')
ok('dsh.client 只有 platform（不声明依赖清单）', Object.keys(pkg.dsh.client).length === 1)
// ★★ 2026-10-11「启动崩溃」的根因就在这里：声明了 dsh.client 却没有 exports["./client"]
//    宿主 client-modules 解析不到客户端 bundle → 必需插件 modules 组合失败 → 整个 DSH 起不来。
//    这三条是事故后补上的检查，**不许删**。
const declaresClient = Boolean(pkg.dsh && pkg.dsh.client)
const exMap = pkg.exports || {}
ok('★ 声明 dsh.client 时 exports["./client"] 必须存在（缺了会崩整个 DSH）', !declaresClient || typeof exMap['./client'] === 'string')
ok('★ exports["./client"] 指向的文件真实存在', !declaresClient || (typeof exMap['./client'] === 'string' && fs.existsSync(path.join(here, exMap['./client']))))
ok('★ exports["."] 存在且指向真实文件（host 入口）', typeof exMap['.'] === 'string' && fs.existsSync(path.join(here, exMap['.'])))
ok('peerDependencies 只有 cordis', JSON.stringify(Object.keys(pkg.peerDependencies)) === '["cordis"]')
ok('peerDependencies.cordis 是 *', pkg.peerDependencies.cordis === '*')
ok('没有 dependencies（不引入第三方包）', pkg.dependencies === undefined)
// 打包完整性：两个自检脚本都要随包分发（离线自检 + 行为级自检）
ok('files 数组含 verify-offline.mjs（静态自检随包分发）', Array.isArray(pkg.files) && pkg.files.includes('verify-offline.mjs'))
ok('★ files 数组含 verify-persession.mjs（行为级自检随包分发）', Array.isArray(pkg.files) && pkg.files.includes('verify-persession.mjs'))

// ── ② host 半边（安全性 + 结构） ───────────────────────────────
group('② host 安全性、状态模型与注入结构')
ok("host 导出 name = 'dsh-wb-outsource'", /export\s+const\s+name\s*=\s*'dsh-wb-outsource'/.test(hostSrc))
ok('host 导出 apply', /export\s+function\s+apply\s*\(/.test(hostSrc))
ok('systemPrompt 留在静态 inject（实证可用形式）', /export\s+const\s+inject\s*=\s*\[\s*'webServer'\s*,\s*'systemPrompt'\s*\]/.test(hostSrc))
ok('路由前缀正确', hostSrc.includes("'/api/dsh-wb-outsource'"))
ok('全文没有 import @deepseek-ai', !hostSrc.includes("'@deepseek-ai/") && !hostSrc.includes('"@deepseek-ai/'))
ok('webServer 有存在性判断', hostSrc.includes("typeof webServer.register !== 'function'"))
// ★ 2026-10-13 改为按会话：text 是**函数**且接 assembly context（形参数量 ≥ 1），才能逐会话判定
const textFn = /text:\s*\(([^)]*)\)\s*=>/.exec(hostSrc)
ok('★ 注入段 text 是函数（读得到 assembly context）', textFn !== null && textFn[1].trim().length > 0, textFn ? `params=${textFn[1].trim()}` : 'no match')
ok('★ 注入按会话判定：用 context.agent 取会话再 isEnabled', hostSrc.includes('context.agent') && hostSrc.includes('isEnabled('))
// ★ 状态模型：按会话 + 纯内存（重启归零）
ok('★ 状态模型是按会话：出现 sessions（Map）', hostSrc.includes('const sessions = new Map()'))
ok('★ 重启归零：apply 里 sessions.clear()', hostSrc.includes('sessions.clear()'))
ok('★ 会话 id 归一化：定义并使用了 normSid', hostSrc.includes('function normSid(') && hostSrc.includes('normSid(r.dshSession)'))
ok('★ 逐会话自证计数：readsBySession', hostSrc.includes('readsBySession'))
ok('snapshot 接受 sessionId 参数（按会话返回快照）', /function\s+snapshot\s*\(\s*sid\s*\)/.test(hostSrc))
// ★ 旧全局状态文件已退役：只剩只读提示，**不再有任何写操作**
ok('★ 不再有 writeStateToDisk 之类的写状态逻辑', !hostSrc.includes('writeStateToDisk'))
ok('★ 不再写 outsource-state.json（写操作已删除）', !/writeFileSync\([^\n]*outsource-state\.json/.test(hostSrc))
ok('旧状态文件只被读来做提示（legacy，不落盘）', hostSrc.includes('LEGACY_STATE_FILE') && hostSrc.includes('legacy-global-state-ignored'))
// ★ 注入路径存在性回退（本机实测的坑）：按候选表挑第一个真实存在的
ok('★ 注入路径按候选表回退（resolveFirst）', hostSrc.includes('function resolveFirst(') && hostSrc.includes('resolveFirst(['))
ok('★ runner 候选含 $DSH_HOME/tools/wb.mjs 回退项', hostSrc.includes("'tools', 'wb.mjs'") && hostSrc.includes('DSH_HOME'))
ok('★ SKILL 候选含 $DSH_HOME/plugin-stash 回退项', hostSrc.includes("'plugin-stash'") && hostSrc.includes("'SKILL.md'"))
// 假警报修掉：warning 只在**真注册失败**时报；源码里已无 INJECT_NEVER_READ
ok('★ warning 只在真注册失败时给出（INJECT_NOT_REGISTERED）', hostSrc.includes('INJECT_NOT_REGISTERED'))
// ⚠️ 只查「带引号的字符串字面量」：旧名字 INJECT_NEVER_READ 被有意留在注释里当历史说明，别一棍子打死
ok('★ 代码里已不再把 INJECT_NEVER_READ 当字符串用（假警报删除）', !hostSrc.includes("'INJECT_NEVER_READ'") && !hostSrc.includes('"INJECT_NEVER_READ"'))
ok('「还没读过」降级为中性 pending + pendingNote', hostSrc.includes('pendingNote') && hostSrc.includes('pending:'))
ok('host 注册失败时会记下具体原因（injectError）', hostSrc.includes('injectError =') && hostSrc.includes('injectError: injectError'))
ok('活跃会话落盘是原子写（tmp + rename）', hostSrc.includes('renameSync') && hostSrc.includes('.tmp'))
ok('/ledger 无参时回退到当前活跃会话', hostSrc.includes('readActiveSession()') && hostSrc.includes('lastActiveSid'))
ok('host 挂 agent/pre-step 记录活跃会话', hostSrc.includes("ctx.on('agent/pre-step'") && hostSrc.includes('wb-outsource-active.json'))
ok('/ledger 支持 ?sessionId= 过滤（归一化 session- 前缀）', hostSrc.includes("searchParams.get('sessionId')") && hostSrc.includes('normSid(r.dshSession) === sid'))
ok('host 会话已知时只回该会话的 runs', hostSrc.includes("(sid === '' ? runs : mine).slice(0, 10)"))
ok('host 只读账本文件（不引入 child_process）', hostSrc.includes('wb-outsource-ledger.json') && !/child_process|spawnSync/.test(hostSrc))
// probe 暴露的新字段（结构存在性，具体取值由 verify-persession 验）
const probeFields = ['mode', 'activeSessionId', 'enabledSessions', 'sectionCalls', 'sessionReads', 'runnerExists', 'skillExists', 'legacy']
ok('probe 暴露按会话/健康度/路径存在性等字段', probeFields.every((f) => hostSrc.includes(f)), probeFields.filter((f) => !hostSrc.includes(f)).join(','))

// 路由集合：只读/只切，绝不能有"执行外包"的路由
const routePaths = [...hostSrc.matchAll(/\$\{BASE\}\/([a-zA-Z/_-]*)/g)].map((m) => m[1])
const routeSet = [...new Set(routePaths)].sort()
ok('路由只有 state / reset / ledger / probe（都没有执行能力）', JSON.stringify(routeSet) === '["ledger","probe","reset","state"]', routeSet.join(','))
ok('★ 新增 /reset 路由（清空全部会话开关）', routeSet.includes('reset'))
ok('没有 spawn/child_process/exec（host 不执行任何命令）', !/child_process|spawnSync|execFile|\bexec\(/.test(hostSrc))
ok('/state 与 /probe 都带上健康度（health 被复用）', (hostSrc.match(/health\(/g) || []).length >= 3)

// ── ③ 注入文案存在性（宽松：只查关键词，不整句硬编码） ──────────
group('③ 注入文案存在性（宽松）')
const mod = await import(pathToFileURL(path.join(here, 'lib', 'index.js')).href)
ok('可被 import（无副作用炸点）', typeof mod.apply === 'function')
mod.setEnabledForTest('verify-off', false, 'verify')
ok('关着的会话：注入文本为空串', mod.promptTextForTest('verify-off') === '')
const snapOn = mod.setEnabledForTest('verify-on', true, 'verify')
ok('开着的会话：snapshot().enabled === true', snapOn.enabled === true)
const prompt = mod.promptTextForTest('verify-on')
ok('注入文本含「外包模式」字样', prompt.includes('外包模式'))
ok('注入文本给出执行器（wb.mjs）', prompt.includes('wb.mjs'))
ok('注入文本给出完整手册路径（SKILL.md）', prompt.includes('SKILL.md'))
ok('注入文本给出标准动作（一条命令 + --include）', prompt.includes('标准动作') && prompt.includes('--include'))
ok('注入文本点明「本会话」口径（只对这条会话生效）', prompt.includes('本会话'))
mod.setEnabledForTest('verify-on', false, 'verify')
ok('wb.mjs 支持 --include（拷贝上下文）', wbSrc.includes("'--include'") && wbSrc.includes('function copyInto('))
ok('wb.mjs 会给外包盖会话戳', wbSrc.includes('currentDshSession') && wbSrc.includes('dshSession: dshSession'))
ok('SKILL.md 已同步为默认外包口径', skillSrc.includes('默认外包，例外才自己干'))

// ── ④ client bundle 形状与安全写法 ────────────────────────────
group('④ client bundle 形状与安全写法')
ok('加载器 id 等于包名（client 清单按包名配对）', clientSrc.includes("id: 'dsh-wb-outsource'"))
ok('挂到 conversation.input.right', clientSrc.includes("'conversation.input.right'"))
ok('挂到 conversation.composer.dock（底部状态栏）', clientSrc.includes("'conversation.composer.dock'"))
ok('client 会轮询 /state（消除状态漂移）', clientSrc.includes('setInterval(tick, 30000)'))
ok('client 失效时显示 ⚠️ 而不是装作正常', clientSrc.includes('is-warn') && clientSrc.includes('注入未生效'))
ok('client 切状态时带 sessionId（按会话）', clientSrc.includes("post('/state', { sessionId: sid"))
ok('client 拿不到会话时不瞎猜（按钮禁用）', clientSrc.includes('外包模式：拿不到当前会话 id'))
ok('client 请求 /ledger 时带 sessionId', clientSrc.includes('?sessionId='))
ok('dock 从按钮借 sessionId（共享页面全局）', clientSrc.includes('__dshWbOutsourceSessionId') && clientSrc.includes('knownSession()'))
ok('按钮把 sessionId 登记到页面全局', clientSrc.includes('function rememberSession(') && clientSrc.includes('window[SESSION_KEY] = String(id)'))
ok('dock 每次轮询重读 id + 监听会话切换', clientSrc.includes('var sid = (props && props.sessionId) || knownSession()') && clientSrc.includes("'dsh-wb-outsource-session'"))
ok('底部只按本会话显示（拿不到会话就不显示）', clientSrc.includes('if (!st || !st.session) return null;'))
ok('client 里已经没有「外包累计」这个口径', clientSrc.includes('外包累计') === false)
ok('client 底部优先显示「本会话外包」', clientSrc.includes('本会话外包'))
ok('register 带 id/order/label', /id:\s*'dsh-wb-outsource'/.test(clientSrc) && /order:\s*\d+/.test(clientSrc))
ok('client 只 require react（不碰宿主其它模块）', (() => {
  const reqs = [...clientSrc.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2])
  return reqs.every((r) => r === 'react')
})(), [...clientSrc.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]).join(','))
ok('不引用图标导出（避免 undefined 组件炸插槽）', !clientSrc.includes('primitives.'))
ok('样式注入有幂等判断', clientSrc.includes("document.querySelector('style['"))
ok('样式注入包在 try/catch 里', clientSrc.includes('样式注入失败（已忽略）'))
ok('插槽挂载包在 try/catch 里', clientSrc.includes('插槽挂载失败（已忽略）'))
ok('fetch 全部有 catch（失败不炸页面）', (clientSrc.match(/catch\(function \(\) \{/g) || []).length >= 3)
ok('导出 name 与包名同源', clientSrc.includes("name: 'dsh-wb-outsource-client'"))
ok('Symbol.toStringTag 设为 Module', clientSrc.includes("Symbol.toStringTag, { value: 'Module' }"))
ok('窄屏只留图标（不挤爆 composer 右侧）', clientSrc.includes('max-width:640px'))
ok('点击有乐观更新 + 失败回滚', clientSrc.includes('乐观更新') && clientSrc.includes('回滚'))
ok('双击/连点有 busy 保护', /if\s*\(\s*!sid\s*\|\|\s*shown\.busy\s*\)\s*return/.test(clientSrc))
ok('wb-credits 的 bySession 也归一化 session- 前缀', creditsSrc.includes("replace(/^session-/, '')"))
ok('wb-credits 把会话戳并进账本', creditsSrc.includes('sessionByLabel') && creditsSrc.includes('bySession'))

// ── 汇总 ───────────────────────────────────────────────────────
console.log(`\n${fails.length === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${pass} 项断言，${fails.length} 项失败`)
if (fails.length) {
  for (const f of fails) console.log(`   - ${f}`)
  process.exit(1)
}
