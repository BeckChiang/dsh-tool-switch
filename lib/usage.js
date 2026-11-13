// dsh-tool-switch — 工具调用次数索引
//
// 数据来源：DSH 的会话日志 `~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`。
// 每行一条记录，`{"type":"tool/call","time":<ms>,"data":{"name":"<工具>"}}`。
// 文件是多帧 zstd（每帧一组追加的行），所以先按魔数切帧再逐帧解压。
//
// 三个口径：
//   session  本会话调用次数
//   d30      近 30 天调用次数（扫描时按天分桶，只留最近 31 天）
//   all      全局累计调用次数
//
// 增量策略：每个文件按 (size, mtimeMs) 缓存解析结果，只有变过的文件才重新解压；
// 缓存落在 `~/.dsh-tool-switch/usage-cache.json`。冷启动要把 ~150MB 日志全解一遍
// （约 4 秒），所以扫描分批让出事件循环，并且和工具列表分成两个请求：面板先出来，
// 徽章随后补上。

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const LOG_NAME = 'session.v4.jsonl.zstd'
const KEEP_DAYS = 31
const MAX_NAME_LENGTH = 200
const CACHE_VERSION = 2
const BATCH = 4

export function defaultSessionsRoot() {
  return join(homedir(), '.dsh', 'sessions')
}

export function defaultCacheFile() {
  return join(homedir(), '.dsh-tool-switch', 'usage-cache.json')
}

function startOfDay(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function dayKey(ms) {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function dayStartOf(key) {
  const [year, month, day] = String(key).split('-').map(Number)
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return Number.NaN
  return new Date(year, month - 1, day).getTime()
}

/** 把多帧 zstd 缓冲切成单帧（每帧自带魔数）。 */
export function splitFrames(buffer) {
  const starts = []
  let index = 0
  while (index + 4 <= buffer.length) {
    const found = buffer.indexOf(ZSTD_MAGIC, index)
    if (found < 0) break
    starts.push(found)
    index = found + 4
  }
  if (starts.length === 0) return []
  const frames = []
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    frames.push(buffer.subarray(starts[i], end))
  }
  return frames
}

/** 日志缓冲 → 文本（跨帧拼接，帧边界可能落在行中间）。 */
export function decodeLog(buffer) {
  const parts = []
  for (const frame of splitFrames(buffer)) {
    try {
      parts.push(zstdDecompressSync(frame).toString('utf8'))
    } catch {
      // 正在写入的尾帧可能不完整；跳过，下次大小变了会重解析。
    }
  }
  return parts.join('')
}

/**
 * 数一个日志里的 tool/call。
 * 返回 { calls, tools: { name: { n, last, days } } }，days 只保留最近 KEEP_DAYS 天。
 */
export function countCalls(text, { now = Date.now() } = {}) {
  const cutoffDay = startOfDay(now - (KEEP_DAYS - 1) * 86400000)
  const tools = new Map()
  let calls = 0
  for (const line of text.split('\n')) {
    if (line.length === 0 || !line.includes('"tool/call"') || !line.includes('"name"')) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record?.type !== 'tool/call') continue
    const name = record?.data?.name
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) continue
    const time = typeof record.time === 'number' && Number.isFinite(record.time) ? record.time : now
    calls += 1
    let entry = tools.get(name)
    if (entry === undefined) {
      entry = { n: 0, last: 0, days: {} }
      tools.set(name, entry)
    }
    entry.n += 1
    if (time > entry.last) entry.last = time
    if (startOfDay(time) >= cutoffDay) {
      const key = dayKey(time)
      entry.days[key] = (entry.days[key] ?? 0) + 1
    }
  }
  const output = {}
  for (const [name, entry] of tools) output[name] = entry
  return { calls, tools: output }
}

function listLogs(root) {
  const logs = []
  let workspaces = []
  try {
    workspaces = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return logs
  }
  for (const workspace of workspaces) {
    const workspacePath = join(root, workspace.name)
    let sessions = []
    try {
      sessions = readdirSync(workspacePath, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    for (const session of sessions) {
      const file = join(workspacePath, session.name, LOG_NAME)
      try {
        const stat = statSync(file)
        if (!stat.isFile()) continue
        logs.push({ path: file, session: session.name, workspace: workspace.name, size: stat.size, mtimeMs: stat.mtimeMs })
      } catch {
        continue
      }
    }
  }
  return logs
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(value)}\n`)
  } catch {
    // 缓存写不进去只影响下次启动速度。
  }
}

/** 会话目录名可能是 `session-<uuid>`，也可能是裸 uuid；两边都认。 */
export function matchesSession(session, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false
  if (session === sessionId) return true
  if (session === `session-${sessionId}`) return true
  if (sessionId === `session-${session}`) return true
  return session.endsWith(sessionId) || sessionId.endsWith(session)
}

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve))

export class UsageIndex {
  constructor({ root, cacheFile, now = () => Date.now() } = {}) {
    this.root = root ?? defaultSessionsRoot()
    this.cacheFile = cacheFile ?? defaultCacheFile()
    this.now = now
    this.files = null
    this.inflight = null
    this.lastScan = null
  }

  #cache() {
    if (this.files !== null) return this.files
    const loaded = readJson(this.cacheFile, { version: CACHE_VERSION, files: {} })
    const files = loaded?.files !== null && typeof loaded?.files === 'object' ? loaded.files : {}
    this.files = files
    return files
  }

  /** 分批扫描；并发调用共享同一次扫描。 */
  scan(sessionId) {
    if (this.inflight !== null) return this.inflight
    this.inflight = this.#run(sessionId).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  async #run(sessionId) {
    const startedAt = Date.now()
    const now = this.now()
    const cache = this.#cache()
    const logs = listLogs(this.root)
    const files = {}
    let parsedFiles = 0
    let parsedBytes = 0
    let ticks = 0

    for (const log of logs) {
      const cached = cache[log.path]
      const fresh =
        cached !== undefined &&
        cached.version === CACHE_VERSION &&
        cached.size === log.size &&
        cached.mtimeMs === log.mtimeMs
      if (fresh) {
        files[log.path] = cached
        continue
      }
      let record = cached ?? null
      try {
        const buffer = readFileSync(log.path)
        const counted = countCalls(decodeLog(buffer), { now })
        record = { version: CACHE_VERSION, size: log.size, mtimeMs: log.mtimeMs, scannedAt: now, tools: counted.tools }
        parsedFiles += 1
        parsedBytes += buffer.length
      } catch {
        // 读不到就沿用旧记录（可能是空）；下次大小变化再试。
      }
      if (record !== null) files[log.path] = record
      ticks += 1
      if (ticks % BATCH === 0) await yieldTurn()
    }

    this.files = files

    // 会话名 → 该会话的日志记录
    let sessionRecord = null
    for (const log of logs) {
      if (matchesSession(log.session, sessionId)) {
        sessionRecord = files[log.path] ?? null
        break
      }
    }

    const cutoffDay = startOfDay(now - 30 * 86400000)
    const totals = new Map()
    const entryOf = (name) => {
      let entry = totals.get(name)
      if (entry === undefined) {
        entry = { session: 0, d30: 0, all: 0, last: 0 }
        totals.set(name, entry)
      }
      return entry
    }

    for (const record of Object.values(files)) {
      if (record === null || typeof record.tools !== 'object' || record.tools === null) continue
      for (const [name, count] of Object.entries(record.tools)) {
        if (count === null || typeof count !== 'object') continue
        const entry = entryOf(name)
        if (Number.isFinite(count.n)) entry.all += count.n
        if (Number.isFinite(count.last) && count.last > entry.last) entry.last = count.last
        if (count.days !== null && typeof count.days === 'object') {
          for (const [key, value] of Object.entries(count.days)) {
            if (!Number.isFinite(value)) continue
            if (dayStartOf(key) >= cutoffDay) entry.d30 += value
          }
        }
      }
    }

    if (sessionRecord !== null && typeof sessionRecord.tools === 'object' && sessionRecord.tools !== null) {
      for (const [name, count] of Object.entries(sessionRecord.tools)) {
        if (count === null || typeof count !== 'object' || !Number.isFinite(count.n)) continue
        entryOf(name).session += count.n
      }
    }

    if (parsedFiles > 0) writeJson(this.cacheFile, { version: CACHE_VERSION, updatedAt: new Date(now).toISOString(), files })

    const usage = {}
    for (const [name, entry] of totals) usage[name] = entry

    this.lastScan = {
      at: now,
      ms: Date.now() - startedAt,
      files: logs.length,
      parsedFiles,
      parsedBytes,
      sessionMatched: sessionRecord !== null,
    }
    return { ok: true, usage, meta: this.lastScan }
  }
}
