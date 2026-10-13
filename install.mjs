#!/usr/bin/env node
/**
 * install.mjs —— 把 dsh-wb-outsource 挂进本机 DSH 的 profile（跨平台、不用手改配置）
 *
 *   node install.mjs --check        # 只读体检（默认）
 *   node install.mjs --apply        # 挂载（DSH 正在跑时会拒绝，避免热重载把 DSH 搞崩）
 *   node install.mjs --uninstall    # 卸载
 *
 * 可选：--profile <profile目录>   指定挂到哪个 profile（默认优先 profiles/desktop）
 *      --registry <url>           pnpm 用的源（默认用机器上 npm 的默认源）
 *
 * 会先备份：package.json / cordis.patch.yml / pnpm-lock.yaml → *.bak-wboutsource-<时间戳>
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'))
const PKG_NAME = PKG.name
const ENTRY_ID = 'wb-outsource'
const DSH_HOME = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')
const PROFILES_DIR = path.join(DSH_HOME, 'profiles')
const DEP_SPEC = 'file:' + HERE.replace(/\\/g, '/')
const PATCH_BLOCK = '\n- insert:\n    - id: ' + ENTRY_ID + "\n      name: '" + PKG_NAME + "'\n"

const argv = process.argv.slice(2)
const mode = argv.includes('--apply') ? 'apply' : argv.includes('--uninstall') ? 'uninstall' : 'check'
const argVal = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const registry = argVal('--registry')
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

const out = (o) => console.log(JSON.stringify(o, null, 2))
const die = (error, extra = {}) => { out({ ok: false, error, ...extra }); process.exit(1) }

// ── 找 profile ────────────────────────────────────────────────
function candidates() {
  let dirs = []
  try { dirs = fs.readdirSync(PROFILES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return [] }
  return dirs
    .map((d) => path.join(PROFILES_DIR, d.name))
    .filter((p) => fs.existsSync(path.join(p, 'package.json')) && fs.existsSync(path.join(p, 'cordis.patch.yml')))
}
let profileDir = argVal('--profile')
if (profileDir) {
  profileDir = path.resolve(profileDir)
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) die('PROFILE_INVALID: ' + profileDir)
} else {
  const cs = candidates()
  if (cs.length === 0) die('NO_PROFILE_FOUND', { lookIn: PROFILES_DIR })
  const desktop = cs.find((p) => path.basename(p) === 'desktop')
  profileDir = desktop || cs[0]
  if (!desktop && cs.length > 1) {
    console.log('（发现多个 profile，默认用了第一个；要指定请加 --profile <目录>）')
    cs.forEach((p) => console.log('   - ' + p))
  }
}
const PKG_FILE = path.join(profileDir, 'package.json')
const PATCH_FILE = path.join(profileDir, 'cordis.patch.yml')
const LOCK_FILE = path.join(profileDir, 'pnpm-lock.yaml')

// ── DSH 是否在跑 ──────────────────────────────────────────────
async function probe(port) {
  try {
    const c = new AbortController()
    const t = setTimeout(() => c.abort(), 800)
    const r = await fetch('http://127.0.0.1:' + port + '/', { signal: c.signal })
    clearTimeout(t)
    return r.status < 500 || r.status === 401
  } catch { return false }
}
async function dshRunning() {
  const ports = (process.env.DSH_PORTS || '19387,50471,3080').split(',').map((s) => Number(s.trim())).filter(Boolean)
  for (const p of ports) if (await probe(p)) return p
  return 0
}

// ── 状态 ─────────────────────────────────────────────────────
function state() {
  const s = { profile: profileDir, pluginDir: HERE, dep: false, patch: false, depSpec: null }
  try {
    const pj = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'))
    s.depSpec = pj.dependencies ? pj.dependencies[PKG_NAME] : undefined
    s.dep = s.depSpec !== undefined
  } catch (e) { s.error = 'package.json 读不了: ' + String(e) }
  try { s.patch = fs.readFileSync(PATCH_FILE, 'utf8').includes('id: ' + ENTRY_ID) } catch { s.error = 'cordis.patch.yml 读不了' }
  return s
}

function backup(p) {
  if (!fs.existsSync(p)) return null
  const dst = p + '.bak-wboutsource-' + stamp
  fs.copyFileSync(p, dst)
  return dst
}

// ── pnpm：优先用 DSH 自带运行时，其次 PATH 上的 pnpm / npx ──────
function findPnpm() {
  const rt = path.join(DSH_HOME, 'dsh-runtimes')
  try {
    for (const d of fs.readdirSync(rt, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const cand = path.join(rt, d.name, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
      if (fs.existsSync(cand)) return { kind: 'mjs', pnpm: cand }
    }
  } catch { /* ignore */ }
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pnpm'], { encoding: 'utf8' })
  if (probe.status === 0 && probe.stdout.trim()) return { kind: 'bin', pnpm: 'pnpm' }
  return { kind: 'npx', pnpm: 'npx' }
}

function runPnpm(extra = []) {
  return new Promise((resolve) => {
    const found = findPnpm()
    let cmd, args
    if (found.kind === 'mjs') { cmd = process.execPath; args = [found.pnpm, 'install', '--dir', profileDir, ...extra] }
    else if (found.kind === 'bin') { cmd = 'pnpm'; args = ['install', '--dir', profileDir, ...extra] }
    else { cmd = 'npx'; args = ['--yes', 'pnpm', 'install', '--dir', profileDir, ...extra] }
    const child = spawn(cmd, args, { cwd: profileDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    child.stdout.on('data', (d) => { buf += d.toString() })
    child.stderr.on('data', (d) => { buf += d.toString() })
    child.on('close', (code) => resolve({ ok: code === 0, code, how: found.kind, tail: buf.trim().split('\n').slice(-8).join('\n') }))
    child.on('error', (e) => resolve({ ok: false, error: String(e) }))
  })
}

// ── 主流程 ───────────────────────────────────────────────────
const before = state()
const running = await dshRunning()

if (mode === 'check') {
  out({
    ok: true, mode, dshHome: DSH_HOME, profile: profileDir, pluginRoot: HERE,
    dshRunningOnPort: running || null,
    willAddDependency: PKG_NAME + ': ' + DEP_SPEC,
    willAppend: PATCH_BLOCK.trim().split('\n').map((x) => x.trim()).join(' / '),
    current: before,
    verdict: before.dep && before.patch
      ? '已挂载（如果按钮没出现，重启应用即可）'
      : (running ? '未挂载；DSH 正在运行 → 先关掉它再 --apply' : '未挂载；可以 --apply'),
  })
  process.exit(0)
}

if (running) die('DSH 正在运行（端口 ' + running + '）→ 运行中改 profile 会触发热重载、可能崩。先关掉 DSH 再跑', { profile: profileDir })

const backups = []
try {
  backups.push(backup(PKG_FILE), backup(PATCH_FILE), backup(LOCK_FILE))
  const pj = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'))
  pj.dependencies = pj.dependencies || {}
  let patch = fs.readFileSync(PATCH_FILE, 'utf8')

  if (mode === 'apply') {
    pj.dependencies[PKG_NAME] = DEP_SPEC
    if (!patch.includes('id: ' + ENTRY_ID)) {
      if (!patch.endsWith('\n')) patch += '\n'
      patch += PATCH_BLOCK
    }
  } else {
    delete pj.dependencies[PKG_NAME]
    const lines = patch.split(/\r?\n/)
    const kept = []
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '- insert:' && (lines[i + 1] || '').includes('id: ' + ENTRY_ID)) { i += 2; continue }
      kept.push(lines[i])
    }
    patch = kept.join('\n')
  }
  fs.writeFileSync(PKG_FILE, JSON.stringify(pj, null, 2) + '\n', 'utf8')
  fs.writeFileSync(PATCH_FILE, patch, 'utf8')
} catch (e) {
  die('写配置失败: ' + String(e), { backups: backups.filter(Boolean) })
}

const installRes = await runPnpm(registry ? ['--registry', registry] : [])
out({
  ok: installRes.ok,
  mode,
  profile: profileDir,
  pluginRoot: HERE,
  backups: backups.filter(Boolean),
  pnpm: installRes,
  next: mode === 'apply'
    ? '重开 DSH → 验证：输入框右侧出现 🥚 外包；GET /api/dsh-wb-outsource/probe 返回 ok:true'
    : '重开 DSH 确认按钮已消失',
})
process.exit(installRes.ok ? 0 : 1)
