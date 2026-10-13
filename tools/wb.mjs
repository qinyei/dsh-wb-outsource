#!/usr/bin/env node
/**
 * wb.mjs —— 把"耗 token 的重活"外包给本机 WorkBuddy CLI（codebuddy 无头模式）。
 *
 * 设计原则（跟 DSH 的 subagent 工具同构）：
 *   本脚本写一份「自包含任务书」→ WorkBuddy 在自己的上下文里干活（花它自己的积分）
 *   → 产物落在指定目录 → 本脚本核对「改了什么」→ 交回 DSH 由小鲸验证。
 *
 * 它不做的事：不替你把产物搬进正主目录、不判断质量好坏 —— 那是验证门的工作。
 *
 * 用法：
 *   node wb.mjs --check
 *   node wb.mjs "任务描述" [选项]
 *   node wb.mjs --brief 任务书.md [选项]
 *
 * 选项：
 *   --dir <目录>       工作目录（默认新建 <DSH 家目录>/wb-outsource/<时间戳>-<name>）
 *   --model <id>       模型（默认 deepseek-v4.1-flash）
 *   --turns <n>        agent 最大轮数（默认 40）
 *   --timeout <秒>     超时（默认 900）
 *   --context <文件>   附加上下文（规范/说明），会拼进任务书
 *   --include <路径>   把文件或目录**拷进工作目录**（可重复）—— 让 WorkBuddy 就地读，
 *                      别把大段代码粘进任务书（那才烧 token）。例：--include lib/foo.js src/
 *   --name <标签>      产物目录后缀标记
 *   --allow-bash       放开 Bash（默认禁止，只让它读写文件）
 *   --raw              原样打印 CLI 的输出（排障用）
 *   --brief <文件>     从文件读任务（比命令行传长文本安全）
 *   --help
 *
 * 退出码：0 成功 / 1 其它错误 / 2 超时 / 3 未登录 / 4 找不到 CLI
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const DSH_HOME = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh');
const OUT_ROOT = process.env.WB_OUT_ROOT || path.join(DSH_HOME, 'wb-outsource');
const ACTIVE_FILE = path.join(DSH_HOME, 'wb-outsource-active.json');

/** 当前活跃的 DSH 会话（由插件 host 在每步写入）—— 用来把这次外包归到某个会话上。 */
function currentDshSession() {
  try {
    const rec = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'));
    if (rec && typeof rec.sessionId === 'string' && Date.now() - Number(rec.at || 0) < 10 * 60 * 1000) return rec.sessionId;
  } catch { /* 读不到就算了 */ }
  return null;
}
const LOG_ROOT = path.join(OUT_ROOT, '_runs');
const DEFAULT_MODEL = process.env.WB_MODEL || 'deepseek-v4.1-flash';
const MAX_PROMPT_CHARS = 20000;

const log = (...a) => console.error('[wb]', ...a);
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const safeName = (s) => (s || 'run').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 40);

/** 把文件/目录拷进工作目录（--include 用）。跳过 node_modules/.git，免得拷出一个宇宙。 */
function copyInto(src, destDir) {
  const st = fs.statSync(src);
  const dst = path.join(destDir, path.basename(src));
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      copyInto(path.join(src, e.name), dst);
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function findCli() {
  const cands = [
    process.env.WB_CLI,
    // 官方完整 CLI（npm 全局装，带 TUI；登录态在 ~/.codebuddy）—— 优先
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
    // 桌面端随包发的 headless 版（无 TUI，只能 -p）—— 兜底
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'CodeBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'),
    path.join(os.homedir(), '.codebuddy', 'bin', 'codebuddy'),
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

function guessLogin() {
  const dir = path.join(os.homedir(), '.codebuddy');
  if (!fs.existsSync(dir)) return { dir, found: [], hint: '目录不存在（几乎肯定没登录过）' };
  const found = [];
  const walk = (d, depth) => {
    if (depth > 2) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/keyblob|credential|auth|token|account/i.test(e.name)) found.push(path.relative(dir, p));
    }
  };
  walk(dir, 0);
  // 实测（2026-10-11）：登录态落在 local_storage/entry_*.info 里，且不是明文 → 离线判断不可靠
  let lsCount = 0;
  try { lsCount = fs.readdirSync(path.join(dir, 'local_storage')).filter((n) => n.endsWith('.info')).length; } catch { /* ignore */ }
  const hint = lsCount > 0
    ? `无法离线可靠判断（local_storage 有 ${lsCount} 个存储块，凭据非明文）→ 实跑一次最准`
    : '本地几乎没有 CLI 状态 → 很可能没登录过';
  return { dir, found, localStorageEntries: lsCount, hint };
}

function snapshot(root, opts = {}) {
  const skipDirs = new Set(opts.skipDirs || ['node_modules', '.git', '.cache', 'dist', 'build']);
  const maxEntries = opts.maxEntries || 20000;
  const out = new Map();
  const walk = (d) => {
    if (out.size > maxEntries) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!skipDirs.has(e.name)) walk(p); }
      else {
        try { const st = fs.statSync(p); out.set(path.relative(root, p).replace(/\\/g, '/'), st.size + ':' + Math.round(st.mtimeMs)); }
        catch { /* ignore */ }
      }
    }
  };
  walk(root);
  return out;
}

function diffSnapshot(before, after) {
  const added = [], changed = [], removed = [];
  for (const [k, v] of after) {
    if (!before.has(k)) added.push(k);
    else if (before.get(k) !== v) changed.push(k);
  }
  for (const k of before.keys()) if (!after.has(k)) removed.push(k);
  const s = (a, b) => a.localeCompare(b);
  return { added: added.sort(s), changed: changed.sort(s), removed: removed.sort(s) };
}

function parseArgs(argv) {
  const o = { timeout: 900, turns: 40, model: DEFAULT_MODEL, allowBash: false, raw: false, check: false, help: false, include: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--check') o.check = true;
    else if (a === '--raw') o.raw = true;
    else if (a === '--allow-bash') o.allowBash = true;
    else if (a === '--dir') o.dir = next();
    else if (a === '--model') o.model = next();
    else if (a === '--turns') o.turns = Number(next()) || o.turns;
    else if (a === '--timeout') o.timeout = Number(next()) || o.timeout;
    else if (a === '--context') o.context = next();
    else if (a === '--name') o.name = next();
    else if (a === '--brief') o.brief = next();
    else if (a === '--include') { const v = next(); if (v) o.include.push(v); }
    else if (a.startsWith('--')) log('未知参数 ' + a + '，已忽略');
    else rest.push(a);
  }
  o.task = rest.join(' ').trim();
  return o;
}

function usage() {
  const txt = fs.readFileSync(new URL(import.meta.url), 'utf8');
  const head = txt.split('*/')[0];
  console.log(head.split('\n').slice(1).map((l) => l.replace(/^\s*\*\s?/, '')).join('\n').trim());
}

function buildPrompt(task, ctx, dir) {
  const parts = [];
  parts.push('你是"外包工程师"，在一个受限目录里独立完成下面这件事。');
  parts.push('');
  parts.push('【工作目录】' + dir);
  parts.push('');
  parts.push('【任务】');
  parts.push(task);
  parts.push('');
  parts.push('【硬性约束】');
  parts.push('- 只在本工作目录内创建/修改文件，不要碰目录之外的任何路径');
  parts.push('- 不要联网、不要安装依赖、不要 git push');
  parts.push('- 优先复用目录里已有的代码风格与依赖，不要自作主张引入新库');
  parts.push('- 完成后用简短 Markdown 总结：改了/新增了哪些文件，每个文件做了什么，还有哪些没做完');
  if (ctx) {
    parts.push('');
    parts.push('【项目规范与上下文 —— 必须遵守】');
    parts.push(ctx);
  }
  return parts.join('\n');
}

function runCli(opts) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [opts.cli].concat(opts.args), {
      cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGKILL');
      } catch { /* ignore */ }
    }, opts.timeoutSec * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null, stdout, stderr: stderr + '\n[spawn error] ' + err.message, timedOut });
    });
  });
}

function extractResult(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: '', parsed: null, meta: null };

  // `--output-format json` 吐的是「消息数组」，最后一条是 {type:"result", result:"...", num_turns, usage}
  const fromMessages = (arr) => {
    if (!Array.isArray(arr)) return null;
    let text = '', meta = null;
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i];
      if (!m || typeof m !== 'object') continue;
      if (!text && m.type === 'result' && typeof m.result === 'string') {
        text = m.result;
        meta = {
          subtype: m.subtype, isError: m.is_error, numTurns: m.num_turns,
          durationMs: m.duration_ms, durationApiMs: m.duration_api_ms,
          costUsd: m.total_cost_usd, usage: m.usage, sessionId: m.session_id,
        };
      }
      if (!text && m.type === 'message' && m.role === 'assistant' && Array.isArray(m.content)) {
        const t = m.content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n');
        if (t) text = t;
      }
      if (text && meta) break;
    }
    return text || meta ? { text: text, meta: meta } : null;
  };

  const pick = (j) => {
    const t = j.result !== undefined ? j.result : (j.text !== undefined ? j.text : (j.content !== undefined ? j.content : j.message));
    return t === undefined || t === null ? '' : (typeof t === 'string' ? t : JSON.stringify(t));
  };

  try {
    const j = JSON.parse(trimmed);
    const arr = fromMessages(j);
    if (arr) return { text: arr.text, parsed: j, meta: arr.meta };
    if (j && j.type === 'result' && typeof j.result === 'string') {
      return { text: j.result, parsed: j, meta: { subtype: j.subtype, numTurns: j.num_turns, durationMs: j.duration_ms, costUsd: j.total_cost_usd, usage: j.usage } };
    }
    return { text: pick(j), parsed: j, meta: null };
  } catch { /* 落回逐行 */ }

  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]);
      const arr = fromMessages(j);
      if (arr && arr.text) return { text: arr.text, parsed: j, meta: arr.meta };
      const t = pick(j);
      if (t) return { text: t, parsed: j, meta: null };
    } catch { /* continue */ }
  }
  return { text: trimmed, parsed: null, meta: null };
}

const opt = parseArgs(process.argv.slice(2));
if (opt.help) { usage(); process.exit(0); }

const cli = findCli();
if (!cli) {
  console.error(JSON.stringify({ ok: false, error: 'NOT_FOUND_CLI', hint: '没找到 codebuddy CLI；可用 WB_CLI 环境变量指定路径' }, null, 2));
  process.exit(4);
}

if (opt.check) {
  const login = guessLogin();
  console.log(JSON.stringify({
    ok: true, cli: cli, node: process.execPath, model: opt.model, outRoot: OUT_ROOT,
    loginHint: login.hint, loginDir: login.dir, credentialFiles: login.found,
    note: '登录方式：终端运行 codebuddy，进去后输 /login',
  }, null, 2));
  process.exit(0);
}

if (!opt.task && !opt.brief) {
  console.error(JSON.stringify({ ok: false, error: 'NO_TASK', hint: '给个任务，或用 --brief <文件>；--help 看用法' }, null, 2));
  process.exit(1);
}

let task = opt.task;
if (opt.brief) {
  try { task = fs.readFileSync(opt.brief, 'utf8').trim(); }
  catch (e) { console.error(JSON.stringify({ ok: false, error: 'BRIEF_READ_FAILED', detail: String(e) }, null, 2)); process.exit(1); }
}
let ctx = '';
if (opt.context) {
  try { ctx = fs.readFileSync(opt.context, 'utf8').trim(); }
  catch (e) { console.error(JSON.stringify({ ok: false, error: 'CONTEXT_READ_FAILED', detail: String(e) }, null, 2)); process.exit(1); }
}

let workDir = opt.dir ? path.resolve(opt.dir) : path.join(OUT_ROOT, stamp() + '-' + safeName(opt.name || 'job'));
fs.mkdirSync(workDir, { recursive: true });
if (opt.include.length > 0) {
  for (const inc of opt.include) {
    try { copyInto(path.resolve(inc), workDir); log('已带进上下文：' + path.resolve(inc)); }
    catch (error) { log('--include 失败（已忽略）：' + inc + ' → ' + String(error)); }
  }
}
const runDir = path.join(LOG_ROOT, stamp() + '-' + safeName(opt.name || 'job'));
fs.mkdirSync(runDir, { recursive: true });

const before = snapshot(workDir);
const prompt = buildPrompt(task, ctx, workDir);
let promptArg = prompt;
if (prompt.length > MAX_PROMPT_CHARS) {
  const pf = path.join(runDir, 'prompt.txt');
  fs.writeFileSync(pf, prompt, 'utf8');
  promptArg = '请先读取 ' + pf + ' 里的完整任务书，然后执行它。';
}

const args = [promptArg, '--model', opt.model, '--output-format', 'json', '--max-turns', String(opt.turns), '--permission-mode', 'acceptEdits'];
if (!opt.allowBash) args.push('--disallowedTools', 'Bash');
args.push('--add-dir', workDir);

fs.writeFileSync(path.join(runDir, 'task.md'), '# 任务\n\n' + task + '\n\n' + (ctx ? '# 上下文\n\n' + ctx + '\n' : ''), 'utf8');
log('工作目录 ' + workDir);
log('日志目录 ' + runDir);
log('模型 ' + opt.model + ' / 轮数 ' + opt.turns + ' / 超时 ' + opt.timeout + 's / Bash ' + (opt.allowBash ? '允许' : '禁止'));
log('开始跑（长任务可能要几分钟，别以为卡死）...');

const started = Date.now();
const dshSession = currentDshSession();
const res = await runCli({ cli: cli, args: args, cwd: workDir, timeoutSec: opt.timeout, env: process.env });
const elapsed = Math.round((Date.now() - started) / 1000);
const diff = diffSnapshot(before, snapshot(workDir));
const combined = res.stdout + '\n' + res.stderr;
const notLoggedIn = /Authentication required|Please use \/login/i.test(combined);

fs.writeFileSync(path.join(runDir, 'stdout.txt'), res.stdout, 'utf8');
fs.writeFileSync(path.join(runDir, 'stderr.txt'), res.stderr, 'utf8');

const picked = extractResult(res.stdout);
if (opt.raw) {
  console.log('===== stdout =====\n' + res.stdout);
  console.log('===== stderr =====\n' + res.stderr);
}

let status = 'ok', exitCode = 0;
if (notLoggedIn) { status = 'not_logged_in'; exitCode = 3; }
else if (res.timedOut) { status = 'timeout'; exitCode = 2; }
else if (res.code !== 0) { status = 'failed'; exitCode = 1; }

const summary = {
  ok: status === 'ok',
  status: status,
  dshSession: dshSession,
  startedAt: started,
  cliExitCode: res.code,
  seconds: elapsed,
  model: opt.model,
  workDir: workDir,
  runDir: runDir,
  changes: { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length },
  files: { added: diff.added.slice(0, 80), changed: diff.changed.slice(0, 80), removed: diff.removed.slice(0, 80) },
  result: picked.text.slice(0, 4000),
  wb: picked.meta ? {
    turns: picked.meta.numTurns,
    durationMs: picked.meta.durationMs,
    costUsd: picked.meta.costUsd,
    tokens: picked.meta.usage ? {
      in: picked.meta.usage.input_tokens,
      out: picked.meta.usage.output_tokens,
      cacheRead: picked.meta.usage.cache_read_input_tokens,
    } : null,
    sessionId: picked.meta.sessionId,
    isError: picked.meta.isError,
  } : null,
};
if (status === 'not_logged_in') summary.hint = 'WorkBuddy CLI 未登录：终端运行 codebuddy → 输入 /login 完成授权后重试';
if (status === 'timeout') summary.hint = '超过 ' + opt.timeout + 's 已强杀；产物仍在 workDir，可拆小任务或加大 --timeout';
// 顺手刷新积分账本，并把「本次外包花了多少积分」带进结果（本地账本，来自 CLI 会话的 credit 字段）
try {
  const creditsTool = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wb-credits.mjs');
  if (fs.existsSync(creditsTool)) {
    // 先记「产物标签 → DSH 会话」映射：账本据此按会话分组（比让账本工具猜产物目录可靠）
    const mapFile = path.join(DSH_HOME, 'wb-outsource-sessions-map.json');
    try {
      let map = {};
      try { map = JSON.parse(fs.readFileSync(mapFile, 'utf8')); } catch { /* 首次运行，文件还不存在 */ }
      if (dshSession) map[path.basename(workDir)] = dshSession;
      fs.writeFileSync(mapFile + '.tmp', JSON.stringify(map, null, 2), 'utf8');
      fs.renameSync(mapFile + '.tmp', mapFile);
    } catch (error) { log('会话映射写入失败（已忽略）：' + String(error)); }
    spawnSync(process.execPath, [creditsTool, '--ledger'], { stdio: 'ignore', windowsHide: true });
    const ledger = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'wb-outsource-ledger.json'), 'utf8'));
    const label = path.basename(workDir);
    const mine = (ledger.runs || []).find((r) => String(r.label).includes(label));
    summary.credits = mine ? Math.round(mine.credits * 100) / 100 : null;
    summary.creditsTotal = ledger.totals ? ledger.totals.credits : null;
  }
} catch (error) {
  log('积分账本刷新失败（已忽略）：' + String(error));
}

fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify(summary, null, 2));
process.exit(exitCode);
