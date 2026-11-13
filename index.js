// dsh-tool-switch — 会话级工具可见性开关（Host 半侧）
//
// 目标：让用户在某个会话里自己决定「这一轮对话中，模型能用哪些工具」。
//
// 机制：
//   1. `ctx.tools.restrict({ allow })` 是 DSH 已有的按 agent 遮罩 API：只有
//      在 agent 作用域上下文（agent.ctx）里调用才会只影响该 agent。遮罩会从
//      模型可见的 schema 集合、PTC 绑定与执行集合里同时移除工具，因此隐藏的
//      工具既不进提示词，也无法被调用（返回 UNKNOWN_TOOL）。
//   2. 本插件按 sessionId 记住「被关闭的工具名」，在 agent 创建时、以及工具
//      注册表变化（MCP 服务器晚到、插件热插拔）时重新计算 allow 掩码并重装。
//   3. 浏览器半侧（lib/client.js）通过本文件注册的 HTTP 路由读取/写入选择；
//      路由挂在框架自带的 webServer 上，页面与它是同源（桌面外壳会带 cookie
//      转发），因此不需要额外的鉴权通道。
//
// 语义说明：只记「关闭」集合而不是「开启」集合，这样后到的工具默认可用，
// 新增 MCP 工具不会被悄悄藏起来。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { UsageIndex } from './lib/usage.js'

export const name = 'dsh-tool-switch'

/** Cordis：这两个服务不存在时插件不激活。 */
export const inject = ['tools', 'agents']

/** 浏览器半侧使用的路由（同源，精确匹配）。 */
export const ROUTE = '/tool-switch/state'

/** 调用次数统计的独立路由：冷启动要解几百 MB 日志，不能拖慢工具列表。 */
export const USAGE_ROUTE = '/tool-switch/usage'

/** 请求体上限，避免误传大文件。 */
const MAX_BODY_BYTES = 64 * 1024

/** 工具名长度上限（防止脏状态文件把 restrict 撑爆）。 */
const MAX_NAME_LENGTH = 200

/** 模型可调用的开关工具名；它自己永远不会被关掉，否则唯一的 headless 入口就没了。 */
const SWITCH_TOOL_NAME = 'tool_switch'

// ---------------------------------------------------------------------------
// 分组规则：先按内置能力分类，MCP 工具按服务器单独成组，认不出来的再按
// 名字前缀兜底（community 插件通常用 <产物>_<动作> 命名，例如 x_post、
// comfyui_run），这样 300+ 个工具也不会挤进一个「其他」。
// ---------------------------------------------------------------------------

const CORE_GROUPS = [
  {
    id: 'session',
    label: '会话与计划',
    order: 0,
    test: (name) =>
      /^(todo_write|create_goal|get_goal|update_goal|ask_user_question|present|skill|exit_plan_mode)$/.test(name) ||
      /^schedule_/.test(name),
  },
  { id: 'shell', label: '终端与执行', order: 1, test: (name) => /^(pwsh|bash|run_code|shell|terminal|exec)$/.test(name) || /^job_/.test(name) },
  {
    id: 'fs',
    label: '文件与检索',
    order: 2,
    test: (name) =>
      /^(read|write|edit|glob|grep|read_image|read_animation)$/.test(name) ||
      /^(ls|list_dir|list_files|move|copy|remove|mkdir)/.test(name) ||
      name === 'load_workspace_dependencies',
  },
  { id: 'web', label: '网络检索', order: 3, test: (name) => /^(web_search|web_fetch)$/.test(name) },
  {
    id: 'agent',
    label: '子代理与编排',
    order: 4,
    test: (name) =>
      /^(subagent|subagent_fork|send_message|list_agents|interrupt_agent|workflow)$/.test(name) || /^list_subagent_/.test(name),
  },
  { id: 'office', label: '文档与演示', order: 5, test: (name) => /^(office_|ppt)/.test(name) },
  { id: 'media', label: '图像与音视频', order: 6, test: (name) => /^(comfyui_|image_generate)/.test(name) },
  {
    id: 'mcp-resource',
    label: 'MCP 资源',
    order: 7,
    test: (name) => /^(list_mcp_resource|list_mcp_resources|list_mcp_resource_templates|read_mcp_resource)$/.test(name),
  },
  { id: 'social', label: '社交与发布', order: 8, test: (name) => /^x_(post|delete|search|timeline|thread|status|probe)$/.test(name) },
  {
    id: 'toolchain',
    label: '工具链与维护',
    order: 9,
    test: (name) => /^(purge_|install_local_workbench|plugin_manager|working_directory|gain_qq_tools|ops_)/.test(name),
  },
]

const MCP_PATTERN = /^mcp__([A-Za-z0-9_.-]+)__/

/** 把工具名归到一个分组。 */
function groupOf(name) {
  const mcp = MCP_PATTERN.exec(name)
  if (mcp !== null) {
    const server = mcp[1]
    return { id: `mcp:${server}`, label: `${server} · MCP`, order: 100, tool: name.slice(mcp[0].length) }
  }
  for (const group of CORE_GROUPS) {
    if (group.test(name)) return { id: group.id, label: group.label, order: group.order, tool: name }
  }
  const underscore = name.indexOf('_')
  if (underscore > 0) {
    const prefix = name.slice(0, underscore)
    return { id: `x:${prefix}`, label: prefix, order: 800, tool: name }
  }
  return { id: 'other', label: '其他', order: 900, tool: name }
}

// ---------------------------------------------------------------------------
// 选择持久化：~/.dsh-tool-switch/state.json
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function sessionIdOf(agent) {
  const sessionId = agent?.session?.id ?? agent?.id
  return typeof sessionId === 'string' ? sessionId : undefined
}

class SelectionStore {
  constructor(file) {
    this.file = file
    const loaded = readJson(file, undefined)
    this.data =
      loaded !== null && typeof loaded === 'object' && typeof loaded.sessions === 'object' && loaded.sessions !== null
        ? loaded
        : { version: 1, sessions: {} }
    if (this.data.version !== 1) this.data.version = 1
  }

  /** 该会话被关闭的工具名集合。 */
  disabled(sessionId) {
    const entry = this.data.sessions[sessionId]
    const list = Array.isArray(entry?.disabled) ? entry.disabled : []
    const result = new Set()
    for (const name of list) {
      if (typeof name !== 'string') continue
      if (name.length === 0 || name.length > MAX_NAME_LENGTH) continue
      result.add(name)
    }
    return result
  }

  /** 覆盖该会话的关闭集合；空集合等于「全部启用」。 */
  set(sessionId, disabled) {
    const cleaned = new Set()
    for (const name of disabled) {
      if (typeof name !== 'string') continue
      if (name.length === 0 || name.length > MAX_NAME_LENGTH) continue
      cleaned.add(name)
    }
    const list = [...cleaned].sort()
    if (list.length === 0) delete this.data.sessions[sessionId]
    else this.data.sessions[sessionId] = { disabled: list, updatedAt: new Date().toISOString() }
    this.flush()
    return cleaned
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
    } catch {
      /* 持久化失败不影响本次运行内的效果 */
    }
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const settings = config ?? {}
  const stateDir = settings.stateDir ? String(settings.stateDir) : path.join(os.homedir(), '.dsh-tool-switch')
  const store = new SelectionStore(path.join(stateDir, 'state.json'))
  // 调用次数索引：扫 ~/.dsh/sessions 下的会话日志，按 (size, mtime) 增量缓存。
  const usageIndex = new UsageIndex({ cacheFile: path.join(stateDir, 'usage-cache.json') })

  const warn = (message, cause) => {
    try {
      ctx.logger?.warn?.(`[tool-switch] ${message}${cause === undefined ? '' : `: ${String(cause?.message ?? cause)}`}`)
    } catch {
      /* logger 不可用就算了 */
    }
  }

  /** sessionId -> 活着的 agent */
  const live = new Map()
  /** sessionId -> { signature, dispose } */
  const installed = new Map()

  function viewOf(agent) {
    try {
      return ctx.tools.view(agent)
    } catch (error) {
      warn('tools.view() failed', error)
      return undefined
    }
  }

  /** 该 agent 真正可以被 restrict 遮掉的名字（全局继承层的工具）。 */
  function restrictableOf(agent) {
    const view = viewOf(agent)
    const names = view?.restrictableNames
    return names instanceof Set ? names : new Set()
  }

  /**
   * 重算并重装该会话的遮罩。
   * 只有「关闭集合非空且 allow 掩码变了」才会真的动注册表，避免无谓的
   * tools/change 抖动（每次重装都会让提示词前缀失效一次）。
   */
  function syncSession(sessionId) {
    const agent = live.get(sessionId)
    if (agent === undefined) {
      installed.delete(sessionId)
      return
    }
    const disabled = store.disabled(sessionId)
    const restrictable = restrictableOf(agent)
    const allow = [...restrictable].filter((name) => !disabled.has(name))
    const signature = disabled.size === 0 ? 'all' : `allow:${allow.slice().sort().join('\u0000')}`
    const current = installed.get(sessionId)
    if (current !== undefined && current.signature === signature) return

    if (current !== undefined) {
      try {
        current.dispose()
      } catch (error) {
        warn(`lifting previous restriction failed (${sessionId})`, error)
      }
      installed.delete(sessionId)
    }
    if (disabled.size === 0) return

    try {
      // 关键一行：必须走 agent.ctx，遮罩才只作用于这个 agent。
      const dispose = agent.ctx.tools.restrict({ allow })
      installed.set(sessionId, { signature, dispose })
    } catch (error) {
      warn(`restrict() failed (${sessionId})`, error)
    }
  }

  function track(agent) {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    live.set(sessionId, agent)
    syncSession(sessionId)
  }

  function forget(agent) {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    live.delete(sessionId)
    installed.delete(sessionId)
  }

  // --- 生命周期接线 -------------------------------------------------------

  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent ?? payload
    if (agent === undefined || agent === null) return
    try {
      track(agent)
    } catch (error) {
      warn('tracking a created agent failed', error)
    }
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent ?? payload
    if (agent === undefined || agent === null) return
    try {
      forget(agent)
    } catch (error) {
      warn('forgetting a disposed agent failed', error)
    }
  })

  // 工具集合变化（MCP 服务器连接、插件启停）后 allow 掩码可能过期：重算一次。
  let resyncTimer
  ctx.effect(() => () => clearTimeout(resyncTimer), 'tool-switch: resync timer')

  ctx.on('tools/change', () => {
    clearTimeout(resyncTimer)
    resyncTimer = setTimeout(() => {
      for (const sessionId of [...live.keys()]) {
        try {
          syncSession(sessionId)
        } catch (error) {
          warn(`resync after tools/change failed (${sessionId})`, error)
        }
      }
    }, 250)
    resyncTimer.unref?.()
  })

  // 插件卸载时把遮罩全部撤掉：插件不在，就不该继续改会话能力。
  ctx.effect(
    () => () => {
      for (const [, record] of installed) {
        try {
          record.dispose()
        } catch {
          /* 关闭路径不抛 */
        }
      }
      installed.clear()
      live.clear()
    },
    'tool-switch: restrictions',
  )

  // 插件激活前就已经存在的会话也要接上。
  try {
    const existing = ctx.agents.list?.() ?? []
    for (const agent of existing) track(agent)
  } catch (error) {
    warn('enumerating live agents failed', error)
  }

  // --- 只读目录 / 读写状态 ------------------------------------------------

  function descriptionOf(name, fallback) {
    const raw = typeof fallback === 'string' && fallback.length > 0 ? fallback : ''
    const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? ''
    if (firstLine.length === 0) return ''
    return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine
  }

  /** 参数签名：`(a, b?, c)` —— 只列前 12 个，避免几十个参数把行撑爆。 */
  function signatureOf(definition) {
    const schema = definition?.parameters ?? definition?.schema ?? definition?.inputSchema
    const properties = schema?.properties
    if (properties === null || typeof properties !== 'object') return ''
    const required = new Set(Array.isArray(schema?.required) ? schema.required : [])
    const keys = Object.keys(properties)
    if (keys.length === 0) return '()'
    const shown = keys.slice(0, 12).map((key) => (required.has(key) ? key : `${key}?`))
    if (keys.length > shown.length) shown.push('…')
    return `(${shown.join(', ')})`
  }

  /** 展开时显示的完整说明（首行已单独显示，这里保留换行后的细节）。 */
  function detailOf(name, fallback, total) {
    const raw = typeof fallback === 'string' ? fallback.trim() : ''
    if (raw.length === 0) return ''
    const body = raw.length > 1200 ? `${raw.slice(0, 1197)}…` : raw
    if (total !== undefined && total > 0) return `被调用 ${total} 次\n${body}`
    return body
  }

  function buildState(sessionId, options) {
    const detail = options?.detail === true
    const agent = live.get(sessionId)
    const view = agent === undefined ? undefined : viewOf(agent)

    const descriptions = new Map()
    const signatures = new Map()
    let globalNames = []
    try {
      const definitions = ctx.tools.definitions()
      if (Array.isArray(definitions)) {
        globalNames = definitions.map((definition) => definition?.name).filter((entry) => typeof entry === 'string')
        for (const definition of definitions) {
          if (typeof definition?.name === 'string') {
            descriptions.set(definition.name, definition.description ?? '')
            signatures.set(definition.name, signatureOf(definition))
          }
        }
      }
    } catch (error) {
      warn('reading the tool catalog failed', error)
    }

    const knownNames = view?.knownNames instanceof Set ? [...view.knownNames] : globalNames
    const restrictable = view?.restrictableNames instanceof Set ? view.restrictableNames : new Set(globalNames)
    const disabled = store.disabled(sessionId)

    const groups = new Map()
    let enabledCount = 0
    let fixedCount = 0
    const missing = []
    for (const name of disabled) if (!knownNames.includes(name)) missing.push(name)

    for (const name of [...knownNames].sort()) {
      const isRestrictable = restrictable.has(name)
      const enabled = !isRestrictable || !disabled.has(name)
      if (enabled) enabledCount += 1
      if (!isRestrictable) fixedCount += 1
      const group = groupOf(name)
      let bucket = groups.get(group.id)
      if (bucket === undefined) {
        bucket = { id: group.id, label: group.label, order: group.order, tools: [] }
        groups.set(group.id, bucket)
      }
      bucket.tools.push({
        name,
        label: group.tool,
        description: descriptionOf(name, descriptions.get(name)),
        signature: signatures.get(name) ?? '',
        detail: detail ? detailOf(name, descriptions.get(name)) : '',
        enabled,
        locked: !isRestrictable,
      })
    }

    const ordered = [...groups.values()].sort((left, right) => left.order - right.order || left.label.localeCompare(right.label))
    for (const group of ordered) group.tools.sort((left, right) => left.label.localeCompare(right.label))

    return {
      ok: true,
      session: sessionId,
      live: agent !== undefined,
      mode: disabled.size === 0 ? 'all' : 'custom',
      disabled: [...disabled].sort(),
      missing,
      counts: { total: knownNames.length, enabled: enabledCount, disabled: knownNames.length - enabledCount, fixed: fixedCount },
      groups: ordered,
      updatedAt: new Date().toISOString(),
    }
  }

  // --- HTTP 路由 ---------------------------------------------------------

  function send(res, status, payload) {
    const body = `${JSON.stringify(payload)}\n`
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  }

  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (text.length === 0) return {}
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') throw new Error('请求体必须是 JSON 对象')
    return parsed
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? ROUTE, 'http://localhost')
      if (req.method === 'GET' || req.method === 'HEAD') {
        const sessionId = url.searchParams.get('session') ?? ''
        if (sessionId.length === 0) {
          send(res, 400, { ok: false, error: 'missing ?session=<id>' })
          return
        }
        send(res, 200, buildState(sessionId, { detail: url.searchParams.get('detail') === '1' }))
        return
      }
      if (req.method !== 'POST') {
        const body = `${JSON.stringify({ ok: false, error: `method not allowed: ${req.method}` })}\n`
        res.writeHead(405, {
          allow: 'GET, HEAD, POST',
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
        return
      }

      const body = await readJsonBody(req)
      const sessionId = typeof body.session === 'string' ? body.session : ''
      if (sessionId.length === 0) {
        send(res, 400, { ok: false, error: 'missing session' })
        return
      }
      if (!Array.isArray(body.disabled)) {
        send(res, 400, { ok: false, error: 'missing disabled[]' })
        return
      }
      // 走同一个写入路径：过滤掉「永远不许关」的 tool_switch，再重装遮罩。
      send(res, 200, applySelection(sessionId, body.disabled))
    } catch (error) {
      try {
        send(res, 500, { ok: false, error: String(error?.message ?? error) })
      } catch {
        /* 响应已经开始写了 */
      }
    }
  }

  /**
   * 调用次数统计。和状态路由分开挂：冷启动要把 ~150MB 会话日志全解一遍（约 4 秒），
   * 放在同一个请求里会让面板白屏，所以 UI 先拿工具列表，再单独补这批数字。
   * 只有 GET/HEAD；统计本身是只读的，不需要写通道。
   */
  const usageHandler = async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, {
          allow: 'GET, HEAD',
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(`${JSON.stringify({ ok: false, error: `method not allowed: ${req.method}` })}\n`)
        return
      }
      const url = new URL(req.url ?? USAGE_ROUTE, 'http://localhost')
      const sessionId = url.searchParams.get('session') ?? ''
      if (sessionId.length === 0) {
        send(res, 400, { ok: false, error: 'missing ?session=<id>' })
        return
      }
      send(res, 200, await usageIndex.scan(sessionId))
    } catch (error) {
      try {
        send(res, 500, { ok: false, error: String(error?.message ?? error) })
      } catch {
        /* 响应已经开始写了 */
      }
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: ROUTE, handler }), 'tool-switch: state route')
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: USAGE_ROUTE, handler: usageHandler }),
      'tool-switch: usage route',
    )
    try {
      ctx.logger?.info?.(`[tool-switch] ready — ${ROUTE} on ${webCtx.webServer.getOrigin?.() ?? 'webServer'}`)
    } catch {
      /* origin 只在绑定后可用 */
    }
  })

  // ---------------------------------------------------------------------------
  // 不依赖 UI 的两条通道
  //
  // 桌面版/网页版靠 composer 下那个按钮；但 CLI、QQ 这类入口没有按钮，也没有
  // 一定存在的 webServer。所以同一个选择逻辑再开两条口：
  //   · 模型可调用的工具 `tool_switch`（任何入口都通，用户在聊天里说一句就行）
  //   · 斜杠命令 `/tools`（有命令适配器的交互式入口，直接给用户用，不进模型上下文）
  // 三者写的是同一份 store、走同一个 syncSession，选哪个都一样生效。
  // ---------------------------------------------------------------------------

  /** 这个会话现在能看见的工具（按 agent 视图）。 */
  function catalogOf(sessionId) {
    const state = buildState(sessionId)
    const tools = []
    for (const group of state.groups) {
      for (const tool of group.tools) {
        tools.push({ name: tool.name, group: group.id, label: group.label, locked: tool.locked })
      }
    }
    return { state, tools }
  }

  /**
   * 把用户/模型写的目标解析成工具名集合。
   * 支持：all、分组 id（shell / mcp:rea / x:comfyui）、分组标签（终端与执行 / rea / rea · MCP）、
   * 精确工具名、前缀（mcp__rea__）、通配（mcp__rea__*）。
   */
  function resolveTargets(sessionId, spec) {
    const needle = String(spec ?? '').trim()
    if (needle.length === 0) return { error: '缺少目标' }
    const { tools } = catalogOf(sessionId)
    const restrictable = tools.filter((tool) => !tool.locked)
    if (restrictable.length === 0) return { error: '这个会话没有可开关的工具' }

    if (/^all$/i.test(needle) || needle === '全部') {
      return { names: restrictable.map((tool) => tool.name), label: '全部可关闭工具' }
    }

    const byName = restrictable.filter((tool) => tool.name === needle)
    if (byName.length > 0) return { names: byName.map((tool) => tool.name), label: needle }

    const normalise = (text) => text.toLowerCase().replace(/\s+/g, '').replace(/·/g, '').replace(/mcp$/u, '')
    const wanted = normalise(needle)
    const groups = new Map()
    for (const tool of restrictable) {
      const list = groups.get(tool.group) ?? []
      list.push(tool.name)
      groups.set(tool.group, list)
    }
    const groupIds = [...groups.keys()]
    const hitGroup = groupIds.find((id) => id.toLowerCase() === needle.toLowerCase())
      ?? groupIds.find((id) => normalise(id) === wanted)
      ?? groupIds.find((id) => id.startsWith('mcp:') && normalise(id.slice(4)) === wanted)
    if (hitGroup !== undefined) {
      const label = restrictable.find((tool) => tool.group === hitGroup)?.label ?? hitGroup
      return { names: groups.get(hitGroup), label }
    }
    const hitLabel = [...new Set(restrictable.map((tool) => tool.label))]
      .find((label) => normalise(label) === wanted)
    if (hitLabel !== undefined) {
      return { names: restrictable.filter((tool) => tool.label === hitLabel).map((tool) => tool.name), label: hitLabel }
    }

    if (needle.includes('*')) {
      const pattern = new RegExp(`^${needle.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
      const names = restrictable.filter((tool) => pattern.test(tool.name)).map((tool) => tool.name)
      if (names.length > 0) return { names, label: needle }
      return { error: `「${needle}」没有匹配到工具` }
    }

    const prefixed = restrictable.filter((tool) => tool.name.startsWith(needle)).map((tool) => tool.name)
    if (prefixed.length > 0) return { names: prefixed, label: `${needle}*` }

    return { error: `「${needle}」没有匹配到工具或分组（用 /tools 看分组名）` }
  }

  /** 写选择并立刻重装遮罩。`tool_switch` 自己永不被关掉，免得把唯一的入口关了。 */
  function applySelection(sessionId, disabled) {
    const next = new Set()
    for (const name of disabled) if (name !== SWITCH_TOOL_NAME) next.add(name)
    store.set(sessionId, next)
    syncSession(sessionId)
    return buildState(sessionId)
  }

  function summaryLines(sessionId) {
    const state = buildState(sessionId)
    const lines = []
    for (const group of state.groups) {
      const closeable = group.tools.filter((tool) => !tool.locked)
      const off = closeable.filter((tool) => !tool.enabled).length
      const closed = closeable.length > 0 && off === closeable.length
      lines.push(`  ${closed ? '✕' : '·'} ${group.label} ${group.tools.length - off}/${group.tools.length}`)
    }
    return { state, lines }
  }

  function summaryText(sessionId) {
    const { state, lines } = summaryLines(sessionId)
    return [
      `工具：${state.counts.enabled}/${state.counts.total} 可用${state.mode === 'custom' ? '（有工具被关）' : ''}`,
      ...lines,
      '用法：/tools off <分组|工具|前缀> ｜ /tools on <…> ｜ /tools all on ｜ /tools all off',
    ].join('\n')
  }

  /** 工具执行时拿到的 agent：优先用 exec 上的，其次用驱动链上的发起者。 */
  function agentOf(exec) {
    if (exec?.agent !== undefined && exec.agent !== null) return exec.agent
    try {
      return ctx.agents.currentInitiator?.()
    } catch {
      return undefined
    }
  }

  /**
   * 执行一个开关动作。action: list | off | on | reset。
   * 返回给命令/工具的文本与状态。
   */
  function runAction(sessionId, action, target) {
    const verb = String(action ?? '').trim().toLowerCase()
    if (verb === '' || verb === 'list') return { ok: true, state: buildState(sessionId), text: summaryText(sessionId) }

    const disabled = store.disabled(sessionId)

    if (verb === 'reset') {
      const state = applySelection(sessionId, [])
      return { ok: true, state, text: `已恢复全部启用（${state.counts.total}/${state.counts.total}）` }
    }
    if (verb !== 'off' && verb !== 'on') return { ok: false, text: `不认识的动作「${action}」（用 list/off/on/reset）` }

    const specs = String(target ?? '').trim().split(/[\s,]+/).filter((part) => part.length > 0)
    if (specs.length === 0) return { ok: false, text: `要 ${verb} 什么？例如 /tools ${verb} rea` }

    const applied = []
    for (const spec of specs) {
      const resolved = resolveTargets(sessionId, spec)
      if (resolved.error !== undefined) return { ok: false, text: resolved.error }
      for (const name of resolved.names) {
        if (verb === 'off') disabled.add(name)
        else disabled.delete(name)
      }
      applied.push(`${resolved.label}（${resolved.names.length}）`)
    }

    const state = applySelection(sessionId, disabled)
    const now = verb === 'off' ? '已关闭' : '已启用'
    return {
      ok: true,
      state,
      text: `${now}：${applied.join('、')} → 现在 ${state.counts.enabled}/${state.counts.total} 可用（下一条消息生效）`,
    }
  }

  // --- 斜杠命令（有命令适配器的入口：CLI / 网页 composer） -------------------
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(
      () =>
        commandCtx.commands.register({
          name: 'tools',
          description: '查看或开关本会话里模型可用的工具',
          input: { hint: '[off|on] <分组|工具名|前缀> | all on|all off | reset' },
          handler: ({ agent, rawInput }) => {
            const sessionId = sessionIdOf(agent)
            if (sessionId === undefined) return { kind: 'error', text: '拿不到会话 id' }
            const input = String(rawInput ?? '').trim()
            // `all on` / `all off` 这种「动词在前」的写法也认
            const allFirst = /^(all|全部)\s+(on|off|启用|关闭)$/i.exec(input)
            const [word, ...rest] = input.split(/\s+/)
            const result = allFirst !== null
              ? runAction(sessionId, allFirst[2].toLowerCase().replace('启用', 'on').replace('关闭', 'off'), 'all')
              : runAction(sessionId, word === undefined ? 'list' : word, rest.join(' '))
            return { kind: result.ok ? 'success' : 'error', text: result.text }
          },
        }),
      'tool-switch: /tools command',
    )
  })

  // --- 模型可调用的工具（任何入口都通，包括 QQ / headless） -------------------
  try {
    const definition = {
      name: SWITCH_TOOL_NAME,
      description:
        '查看或开关当前会话里模型可用的工具。用户说「把 XX 类工具关掉/打开」时用它；关掉的工具会从工具清单里消失，下一条消息生效。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'off', 'on', 'reset'],
            description: 'list 只看；off 关闭；on 启用；reset 全部启用',
          },
          target: {
            type: 'string',
            description: '分组名（如 rea、终端与执行、mcp:rea）、精确工具名、前缀（mcp__rea__）或 all；list/reset 可省略',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            action: { type: 'string' },
            enabled: { type: 'number' },
            total: { type: 'number' },
            message: { type: 'string' },
          },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
      },
      async execute(args, exec) {
        const sessionId = sessionIdOf(agentOf(exec) ?? {})
        if (sessionId === undefined) {
          return { ok: false, action: String(args?.action ?? ''), message: '拿不到当前会话，无法改工具开关' }
        }
        const result = runAction(sessionId, args?.action, args?.target)
        return {
          ok: result.ok,
          action: String(args?.action ?? ''),
          enabled: result.state?.counts?.enabled ?? 0,
          total: result.state?.counts?.total ?? 0,
          message: result.text,
        }
      },
    }
    ctx.effect(() => ctx.tools.register(definition), 'tool-switch: tool_switch tool')
  } catch (error) {
    warn('registering tool_switch failed', error)
  }
}

