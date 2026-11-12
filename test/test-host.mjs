// 主机半侧的离线验证：用一个最小 ctx 桩，跑通
// 分组 / 持久化 / restrict 重装 / HTTP 路由 这几条主路径。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { apply, ROUTE } from '../index.js'

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-switch-test-'))

// --- 假的工具注册表 --------------------------------------------------------
const globalTools = new Map([
  ['pwsh', 'Run a PowerShell command.'],
  ['read', 'Read a file.\nSecond line ignored.'],
  ['write', 'Create a file.'],
  ['edit', 'Replace literal text.'],
  ['web_search', 'Search the web.'],
  ['web_fetch', 'Fetch a URL.'],
  ['todo_write', 'Record a task list.'],
  ['create_goal', 'Create a persisted goal.'],
  ['subagent', 'Delegate a task.'],
  ['workflow', 'Run a workflow script.'],
  ['office_template', 'Prepare a template.'],
  ['mcp__rea__analyze_function', 'Build a dossier.'],
  ['mcp__rea__open_binary', 'Open a binary.'],
  ['mcp__bilibili__bilibili_hot', 'List hot videos.'],
  ['some_legacy_tool', 'No rule matches me.'],
])
// 只能在 agent 作用域里注册、restrict 管不到的工具
const scopedOnly = new Set(['preset_only_tool'])

const restrictCalls = []
function makeAgent(sessionId) {
  const agent = {
    id: sessionId,
    session: { id: sessionId },
    ctx: {
      tools: {
        restrict(filter) {
          const call = { sessionId, allow: [...filter.allow] }
          restrictCalls.push(call)
          return () => {
            call.disposed = true
          }
        },
      },
    },
  }
  return agent
}

const tools = {
  definitions() {
    return [...globalTools].map(([name, description]) => ({ name, description }))
  },
  view() {
    return {
      knownNames: new Set([...globalTools.keys(), ...scopedOnly]),
      restrictableNames: new Set(globalTools.keys()),
      visible: new Map(),
      registrations: new Map(),
    }
  },
}

const agents = new Map()
const agentsService = {
  list: () => [...agents.values()],
  get: (id) => agents.get(id),
}

// --- 假的 ctx --------------------------------------------------------------
const listeners = new Map()
const disposers = []
const routes = new Map()

const ctx = {
  logger: { warn: (...args) => console.log('[warn]', ...args), info() {}, error: console.error },
  tools,
  agents: agentsService,
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(fn)
  },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  inject(deps, cb) {
    if (deps.every((dep) => ctx[dep] !== undefined)) cb(ctx)
  },
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
}

apply(ctx, { stateDir })

const emit = (event, payload) => {
  for (const fn of listeners.get(event) ?? []) fn(payload)
}

// --- 假 HTTP ---------------------------------------------------------------
function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

async function call(method, url, body) {
  const route = routes.get(ROUTE)
  assert.ok(route, '路由应当已注册')
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = method
  req.url = url
  const res = fakeRes()
  await route.handler(req, res)
  return { status: res.status, json: JSON.parse(res.body || '{}') }
}

const SESSION = 'sess-abc'

// 1) 没有 agent 时也能列出目录（用于恢复前的预览）
{
  const { status, json } = await call('GET', `${ROUTE}?session=${SESSION}`)
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.live, false)
  assert.equal(json.mode, 'all')
  assert.equal(json.counts.total, 15, '没有 agent 时按全局注册表计数')
  const ids = json.groups.map((group) => group.id)
  assert.deepEqual(ids.slice(0, 3), ['session', 'shell', 'fs'], `分组顺序异常: ${ids.join(',')}`)
  const rea = json.groups.find((group) => group.id === 'mcp:rea')
  assert.ok(rea, 'MCP 工具应单独成组')
  assert.deepEqual(rea.tools.map((t) => t.label), ['analyze_function', 'open_binary'])
  const prefixed = json.groups.find((group) => group.id === 'x:some')
  assert.ok(prefixed, '未命中规则的工具应按前缀兜底成组')
  assert.equal(prefixed.tools[0].name, 'some_legacy_tool')
  const read = json.groups.flatMap((g) => g.tools).find((t) => t.name === 'read')
  assert.equal(read.description, 'Read a file.', '描述应只保留第一行')
  console.log('✓ 目录 / 分组')
}

// 2) agent 创建：默认不装遮罩
{
  const agent = makeAgent(SESSION)
  agents.set(SESSION, agent)
  emit('agent/created', { agent })
  assert.equal(restrictCalls.length, 0, '默认全部启用时不应调用 restrict')
  const { json } = await call('GET', `${ROUTE}?session=${SESSION}`)
  assert.equal(json.live, true)
  assert.equal(json.counts.total, 16, '有 agent 时应按该 agent 的可见集合计数')
  assert.equal(json.counts.fixed, 1)
  const preset = json.groups.flatMap((g) => g.tools).find((t) => t.name === 'preset_only_tool')
  assert.ok(preset && preset.locked === true, '作用域内工具应标记为不可关闭')
  console.log('✓ 默认不装遮罩 / 不可关闭标记')
}

// 3) 写入选择 -> 装遮罩，且 allow = 可限制集合 - 关闭集合
{
  const { status, json } = await call('POST', ROUTE, {
    session: SESSION,
    disabled: ['pwsh', 'web_fetch', 'mcp__rea__open_binary'],
  })
  assert.equal(status, 200)
  assert.equal(json.mode, 'custom')
  assert.equal(json.counts.disabled, 3)
  assert.equal(restrictCalls.length, 1)
  const allow = new Set(restrictCalls[0].allow)
  assert.ok(!allow.has('pwsh') && !allow.has('web_fetch') && !allow.has('mcp__rea__open_binary'))
  assert.ok(allow.has('read') && allow.has('mcp__rea__analyze_function'))
  assert.equal(allow.size, 12, `allow 应当是可限制集合减去三项: ${allow.size}`)
  const tool = json.groups.flatMap((g) => g.tools).find((t) => t.name === 'pwsh')
  assert.equal(tool.enabled, false)
  console.log('✓ 写入后装遮罩（allow = 可限制集合 − 关闭集合）')
}

// 4) 重复写入相同选择不应重装（避免提示词前缀反复失效）
{
  const before = restrictCalls.length
  await call('POST', ROUTE, { session: SESSION, disabled: ['mcp__rea__open_binary', 'pwsh', 'web_fetch'] })
  assert.equal(restrictCalls.length, before, '相同签名不应重复 restrict')
  console.log('✓ 幂等：相同选择不重装')
}

// 5) 变化时先撤旧遮罩再装新的
{
  const previous = restrictCalls[0]
  await call('POST', ROUTE, { session: SESSION, disabled: ['pwsh', 'read'] })
  assert.equal(previous.disposed, true, '旧遮罩应被撤销')
  const latest = restrictCalls[restrictCalls.length - 1]
  assert.ok(!latest.allow.includes('pwsh') && !latest.allow.includes('read'))
  assert.ok(latest.allow.includes('web_fetch'), '重新启用的工具应回到 allow')
  console.log('✓ 变更时撤销旧遮罩并重装')
}

// 6) 工具集合变化（新 MCP 工具晚到）后 allow 自动补齐
{
  globalTools.set('mcp__new__late_tool', 'Arrived late.')
  delete globalTools.delete // noop, 保持可读性
  const before = restrictCalls.length
  emit('tools/change', {})
  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal(restrictCalls.length, before + 1, 'tools/change 后应重装一次')
  const latest = restrictCalls[restrictCalls.length - 1]
  assert.ok(latest.allow.includes('mcp__new__late_tool'), '晚到的工具应默认可用')
  console.log('✓ 晚到工具自动补齐（新增工具默认启用）')
}

// 7) 清空选择 = 撤掉遮罩
{
  await call('POST', ROUTE, { session: SESSION, disabled: [] })
  const last = restrictCalls[restrictCalls.length - 1]
  assert.equal(last.disposed, true, '清空后旧遮罩应被撤销')
  const { json } = await call('GET', `${ROUTE}?session=${SESSION}`)
  assert.equal(json.mode, 'all')
  console.log('✓ 清空即撤销遮罩')
}

// 8) 持久化：重启后（新 apply）选择仍在
{
  await call('POST', ROUTE, { session: SESSION, disabled: ['edit'] })
  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
  assert.deepEqual(saved.sessions[SESSION].disabled, ['edit'])

  // 重新搭一套 ctx，模拟 Host 重启
  const restored = []
  const ctx2 = Object.assign({}, ctx, {
    tools,
    agents: agentsService,
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  })
  ctx2.on = () => {}
  apply(ctx2, { stateDir })
  // 新 apply 会 sync 现存 agent
  assert.equal(restrictCalls[restrictCalls.length - 1].sessionId, SESSION)
  restored.push(restrictCalls[restrictCalls.length - 1])
  assert.ok(!restored[0].allow.includes('edit'), '重启后应恢复遮蔽')
  console.log('✓ 持久化：重启后选择仍生效')
}

// 9) 错误输入
{
  const missing = await call('POST', ROUTE, { disabled: [] })
  assert.equal(missing.status, 400)
  const badGet = await call('GET', ROUTE)
  assert.equal(badGet.status, 400)
  const wrongMethod = await call('PUT', ROUTE, {})
  assert.equal(wrongMethod.status, 405)
  console.log('✓ 输入校验')
}

// 10) 卸载时撤销全部遮罩
{
  const before = restrictCalls.filter((call) => call.disposed !== true).length
  for (const dispose of [...disposers].reverse()) dispose()
  const after = restrictCalls.filter((call) => call.disposed !== true).length
  assert.ok(after < before, '卸载时应撤销遮罩')
  console.log('✓ 卸载撤销遮罩')
}

fs.rmSync(stateDir, { recursive: true, force: true })
console.log('\n全部主机侧检查通过')
