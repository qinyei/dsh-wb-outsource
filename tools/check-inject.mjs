/**
 * check-inject.mjs —— 检查会话日志里，system prompt 是否真的包含插件注入的那段说明
 *   node check-inject.mjs <session.v4.jsonl.zstd> [标记文字]
 *
 * 原理：DSH 每次构建 system prompt 都会落一条 type=system/message 事件。
 *      所以"注入了却没生效"在日志里表现得很清楚：**没有任何 system/message 含那段标记**。
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
// ⚠️ 标记要跟着注入文案走：2026-10-13 起按会话版写的是「外包模式：本会话已开启」。
//    查更早的日志（按会话之前）时，第二个参数传旧文案「外包模式：已开启」。
const MARK = process.argv[3] || '外包模式：本会话已开启'
if (!file) { console.error('用法: node check-inject.mjs <session.v4.jsonl.zstd> [标记]'); process.exit(2) }

const buf = fs.readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// 逐帧解压（zstdDecompressSync 只解第一帧，必须自己切帧）
let off = 0
const chunks = []
let frames = 0, failed = 0
while (off < buf.length) {
  const idx = buf.indexOf(MAGIC, off)
  if (idx < 0) break
  const next = buf.indexOf(MAGIC, idx + 4)
  const end = next < 0 ? buf.length : next
  try {
    chunks.push(zlib.zstdDecompressSync(buf.subarray(idx, end)).toString('utf8'))
    frames++
  } catch { failed++ }
  off = end
}

const text = chunks.join('')
const sysEvents = []
for (const line of text.split('\n')) {
  const t = line.trim()
  if (!t) continue
  let j
  try { j = JSON.parse(t) } catch { continue }
  if (j.type === 'system/message') sysEvents.push(j)
}

const hits = sysEvents.filter((e) => JSON.stringify(e).includes(MARK))

console.log('帧: ' + frames + '（失败 ' + failed + '）  日志字符数: ' + text.length)
console.log('system/message 事件: ' + sysEvents.length + ' 条')
if (sysEvents.length > 0) {
  const first = sysEvents[0], last = sysEvents[sysEvents.length - 1]
  const t = (x) => new Date(x.time || 0).toLocaleString('zh-CN', { hour12: false })
  console.log('  最早 seq=' + first.seq + ' @' + t(first))
  console.log('  最新 seq=' + last.seq + ' @' + t(last))
}
console.log('含「' + MARK + '」的: ' + hits.length + ' 条' + (hits.length ? '  seq=' + hits.map((h) => h.seq).join(',') : ''))
console.log('')
if (hits.length === 0) {
  console.log('❌ 结论：注入**从未**出现在 system prompt 里 → 开关亮着也不会生效')
} else {
  console.log('✅ 结论：注入确实进过 system prompt（最近一次 seq=' + hits[hits.length - 1].seq + '）')
  // 顺手看看最近一次 system prompt 里那段长什么样
  const last = hits[hits.length - 1]
  const s = JSON.stringify(last)
  const i = s.indexOf(MARK)
  console.log('  片段: ' + s.slice(Math.max(0, i - 40), i + 160).replace(/\\n/g, ' | '))
}
