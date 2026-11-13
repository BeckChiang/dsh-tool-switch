// 调用次数统计的离线验证：
//  1) lib/usage.js：多帧 zstd 日志 → 本会话 / 近 30 天 / 全局三个口径
//  2) 缓存：同一次解析只做一遍，文件没变就不再解压
//  3) 浏览器半侧：徽章、未用标记、按频率排序、展开完整说明
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { zstdCompressSync } from 'node:zlib'

import { countCalls, decodeLog, splitFrames, UsageIndex, matchesSession } from '../lib/usage.js'

// --- 1) 合成日志：两帧追加，第二帧是后来的调用 ------------------------------

const DAY = 86400000
const now = Date.now()

function line(type, data, time) {
  return `${JSON.stringify({ type, seq: 1, time, data })}\n`
}

function logLines() {
  return [
    line('session', { version: 4, id: 'session-a' }, now - 40 * DAY),
    line('tool/call', { name: 'pwsh', arguments: {} }, now - 40 * DAY),
    line('tool/call', { name: 'pwsh', arguments: {} }, now - 3 * DAY),
    line('tool/call', { name: 'web_search', arguments: {} }, now - 2 * DAY),
    line('assistant/message', { text: 'hi' }, now - 2 * DAY),
    line('tool/result', { name: 'web_search' }, now - 2 * DAY),
  ].join('')
}

function logTail() {
  return [line('tool/call', { name: 'pwsh', arguments: {} }, now - 1000), line('tool/call', { name: 'present', arguments: {} }, now - 500)].join('')
}

const frameA = zstdCompressSync(Buffer.from(logLines(), 'utf8'))
const frameB = zstdCompressSync(Buffer.from(logTail(), 'utf8'))
const buffer = Buffer.concat([frameA, frameB])

assert.equal(splitFrames(buffer).length, 2, '应按魔数切出两帧')
const text = decodeLog(buffer)
assert.ok(text.includes('tool/call') && text.includes('present'), '跨帧文本应完整')

const counted = countCalls(text, { now })
assert.equal(counted.calls, 5, '只数 tool/call，tool/result 不算')
assert.equal(counted.tools.pwsh.n, 3)
assert.equal(counted.tools.pwsh.last, now - 1000, 'last 取最近的调用')
// pwsh 有一次在 40 天前，不进 30 天天桶
const pwshDays = Object.values(counted.tools.pwsh.days).reduce((sum, value) => sum + value, 0)
assert.equal(pwshDays, 2, '40 天前那次只算进 all，不进天桶')
assert.equal(counted.tools.present.n, 1)

// --- 2) UsageIndex：目录扫描 + 会话匹配 + 缓存 --------------------------------

const root = mkdtempSync(join(tmpdir(), 'tool-switch-usage-'))
const workspace = join(root, 'workspace-a')
mkdirSync(join(workspace, 'session-abc'), { recursive: true })
mkdirSync(join(workspace, 'session-other'), { recursive: true })
writeFileSync(join(workspace, 'session-abc', 'session.v4.jsonl.zstd'), buffer)
writeFileSync(
  join(workspace, 'session-other', 'session.v4.jsonl.zstd'),
  zstdCompressSync(Buffer.from(logTail(), 'utf8')),
)

assert.equal(matchesSession('session-abc', 'abc'), true)
assert.equal(matchesSession('session-abc', 'session-abc'), true)
assert.equal(matchesSession('session-abc', 'zzz'), false)

const cacheFile = join(root, 'cache.json')
const index = new UsageIndex({ root, cacheFile, now: () => now })
const first = await index.scan('session-abc')
assert.equal(first.ok, true)
assert.equal(first.meta.files, 2)
assert.equal(first.meta.sessionMatched, true, '应认出本会话的那份日志')
assert.deepEqual(
  { session: first.usage.pwsh.session, d30: first.usage.pwsh.d30, all: first.usage.pwsh.all },
  { session: 3, d30: 3, all: 4 },
  '本会话 / 近 30 天 / 全局 三个口径应各自独立（另一个会话里也有一条 pwsh）',
)
assert.equal(first.usage.present.session, 1, '只有本会话那份日志里的那次算本会话')
assert.equal(first.usage.present.d30, 2, '两个会话里的 present 都在 30 天内')
assert.equal(first.usage.present.all, 2, 'present 在另一个会话里也出现过一次')

// 文件没变 → 第二次搭新实例走缓存，一个都不重解析
const second = await new UsageIndex({ root, cacheFile, now: () => now }).scan('session-abc')
assert.equal(second.meta.parsedFiles, 0, '缓存命中时不应重新解压')
assert.equal(second.usage.pwsh.all, 4, '缓存结果应与首次一致')

// 追加一帧 → 只重解析变了的那个文件
writeFileSync(join(workspace, 'session-abc', 'session.v4.jsonl.zstd'), Buffer.concat([buffer, zstdCompressSync(Buffer.from(logTail(), 'utf8'))]))
const third = await new UsageIndex({ root, cacheFile, now: () => now }).scan('session-abc')
assert.equal(third.meta.parsedFiles, 1, '只有变了的文件需要重解析')
assert.equal(third.usage.pwsh.session, 4, '追加的调用要算进来（3 + 1）')

// --- 3) 浏览器半侧渲染 -------------------------------------------------------

let loaded = null
globalThis.window = {
  __ModuleLoader__: { load(spec) { loaded = spec } },
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1280,
  innerHeight: 800,
}
globalThis.document = { body: {} }
globalThis.fetch = async () => {
  throw new Error('offline test: fetch disabled')
}
await import('../lib/client.js')

const appRequire = createRequire(process.env.DSH_APP ?? 'C:/Users/recko/DSH/tmp/react-test/package.json')
const React = appRequire('react')
const { renderToStaticMarkup } = appRequire('react-dom/server')
const { renderToolTree } = loaded.factory((specifier) => {
  if (specifier === 'react') return React
  if (specifier === 'react-dom') return appRequire('react-dom')
  throw new Error(`意外的模块请求: ${specifier}`)
}).__internals

const state = {
  ok: true,
  groups: [
    {
      id: 'shell',
      label: '终端与执行',
      order: 1,
      tools: [
        { name: 'pwsh', label: 'pwsh', description: 'Run a command.', detail: 'Run a command.\n第二行细节', signature: '(command, timeout?)', enabled: true, locked: false },
        { name: 'never_used', label: 'never_used', description: 'Never called.', detail: '', signature: '()', enabled: true, locked: false },
      ],
    },
    {
      id: 'web',
      label: '网络检索',
      order: 2,
      tools: [{ name: 'web_search', label: 'web_search', description: 'Search the web.', detail: '', signature: '(query)', enabled: true, locked: false }],
    },
  ],
}
const usage = { usage: { pwsh: { session: 12, d30: 340, all: 7885 }, web_search: { session: 1, d30: 50, all: 50 } } }
const base = { state, needle: '', expanded: { shell: true, web: true }, setExpanded: () => {}, toggleGroup: () => {}, toggleTool: () => {}, usage, usageReady: true }

const sessionView = renderToStaticMarkup(React.createElement('div', null, renderToolTree(Object.assign({}, base, { metric: 'session' }))))
assert.ok(sessionView.includes('12'), '本会话口径应显示 12')
assert.ok(sessionView.includes('未用'), '从没调用过的工具应有「未用」标记')
assert.ok(sessionView.includes('(command, timeout?)'), '应显示参数签名')
assert.ok(sessionView.includes('·12'), '组头应显示该组在当前口径下的总次数（pwsh 12 + never_used 0）')

const globalView = renderToStaticMarkup(React.createElement('div', null, renderToolTree(Object.assign({}, base, { metric: 'all' }))))
assert.ok(globalView.includes('7.9k'), '全局口径应把 7885 压成 7.9k')

// 未加载完统计时不误报「未用」
const pending = renderToStaticMarkup(React.createElement('div', null, renderToolTree(Object.assign({}, base, { usage: null, usageReady: false }))))
assert.equal(pending.includes('未用'), false, '统计未就绪时不应显示「未用」')
assert.ok(pending.includes('··'), '统计未就绪时徽章应是占位符')

// 按频率排序：web(1) 不应排在 shell(12) 前面，组内 pwsh(12) 在前
const sorted = renderToStaticMarkup(React.createElement('div', null, renderToolTree(Object.assign({}, base, { sortByFreq: true, metric: 'session' }))))
assert.ok(sorted.indexOf('终端与执行') < sorted.indexOf('网络检索'), '按频率排序时调用多的组在前')

// 展开说明：默认显示首行，展开后显示 detail（多行）
const collapsedDetail = renderToStaticMarkup(React.createElement('div', null, renderToolTree(base)))
assert.ok(collapsedDetail.includes('Run a command.'), '默认显示首行说明')
assert.equal(collapsedDetail.includes('第二行细节'), false, '默认不展开完整说明')
const openedDetail = renderToStaticMarkup(
  React.createElement('div', null, renderToolTree(Object.assign({}, base, { openDetail: { pwsh: true } }))),
)
assert.ok(openedDetail.includes('第二行细节'), '展开后应显示完整说明')

console.log('全部调用次数统计检查通过')
