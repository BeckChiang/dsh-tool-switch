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

export const name = 'dsh-tool-switch'

/** Cordis：这两个服务不存在时插件不激活。 */
export const inject = ['tools', 'agents']

/** 浏览器半侧使用的路由（同源，精确匹配）。 */
export const ROUTE = '/tool-switch/state'

/** 请求体上限，避免误传大文件。 */
const MAX_BODY_BYTES = 64 * 1024

/** 工具名长度上限（防止脏状态文件把 restrict 撑爆）。 */
const MAX_NAME_LENGTH = 200

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

  function buildState(sessionId) {
    const agent = live.get(sessionId)
    const view = agent === undefined ? undefined : viewOf(agent)

    const descriptions = new Map()
    let globalNames = []
    try {
      const definitions = ctx.tools.definitions()
      if (Array.isArray(definitions)) {
        globalNames = definitions.map((definition) => definition?.name).filter((entry) => typeof entry === 'string')
        for (const definition of definitions) {
          if (typeof definition?.name === 'string') descriptions.set(definition.name, definition.description ?? '')
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
        send(res, 200, buildState(sessionId))
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
      store.set(sessionId, body.disabled)
      syncSession(sessionId)
      send(res, 200, buildState(sessionId))
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
    try {
      ctx.logger?.info?.(`[tool-switch] ready — ${ROUTE} on ${webCtx.webServer.getOrigin?.() ?? 'webServer'}`)
    } catch {
      /* origin 只在绑定后可用 */
    }
  })
}
