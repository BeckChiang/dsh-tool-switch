// 浏览器半侧的离线验证：
//  1) bundle 协议（window.__ModuleLoader__.load + factory 返回 apply/inject）
//  2) slot 注册形状（name/id/order/inject）
//  3) 用真实 React 把按钮渲染成 HTML，确认结构可渲染
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { APP_PACKAGE } from './paths.mjs'

const appRequire = createRequire(APP_PACKAGE)

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    },
  },
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

assert.ok(loaded !== null, 'bundle 应通过 window.__ModuleLoader__.load 注册')
assert.equal(loaded.id, 'dsh-tool-switch')
assert.equal(typeof loaded.factory, 'function')

const requireStub = (specifier) => {
  if (specifier === 'react') return appRequire('react')
  if (specifier === 'react-dom') return appRequire('react-dom')
  if (specifier === 'react/jsx-runtime') return appRequire('react/jsx-runtime')
  throw new Error(`意外的模块请求: ${specifier}`)
}

const moduleExports = loaded.factory(requireStub)
assert.equal(typeof moduleExports.apply, 'function', 'factory 应导出 apply')
assert.deepEqual([...moduleExports.inject], ['slots'], 'factory 应声明 slots 依赖')
console.log('✓ bundle 协议与导出')

// --- slot 注册 --------------------------------------------------------------
const registrations = []
const injections = []
const fakeCtx = {
  slots: {
    inject(name, callback) {
      injections.push(name)
      callback()
    },
    register(entry, component) {
      registrations.push({ entry, component })
      return () => {}
    },
  },
}

moduleExports.apply(fakeCtx)

assert.deepEqual(injections, ['conversation.composer.dock'], '应等待输入框下方 dock 的声明')
assert.equal(registrations.length, 1)
const { entry, component } = registrations[0]
assert.equal(entry.name, 'conversation.composer.dock')
assert.equal(entry.id, 'tool-switch')
assert.equal(typeof entry.order, 'number')
assert.equal(typeof entry.inject, 'function')
assert.deepEqual(entry.inject('sess-1'), { sessionId: 'sess-1' })
assert.equal(typeof component, 'function')
console.log('✓ 注册进 conversation.composer.dock')

// --- 渲染冒烟 ---------------------------------------------------------------
const React = appRequire('react')
const { renderToStaticMarkup } = appRequire('react-dom/server')

const closed = renderToStaticMarkup(React.createElement(component, { sessionId: 'sess-1' }))
assert.ok(closed.includes('工具'), '按钮文案应包含「工具」')
assert.ok(closed.includes('<button'), '应渲染成一个 button')
assert.ok(closed.includes('<svg'), '应带图标')
assert.equal(closed.includes('role="dialog"'), false, '关闭状态不应渲染面板')
console.log('✓ 按钮渲染:', closed.slice(0, 120).replace(/\s+/g, ' '))

// 无 sessionId 时不应渲染任何东西（composer 只在有会话时挂载，这里是额外保险）
const empty = renderToStaticMarkup(React.createElement(component, {}))
assert.equal(empty, '', '缺少 sessionId 时应渲染为空')
console.log('✓ 无 sessionId 时渲染为空')

// 面板本体（loading 阶段）：直接渲染组件，renderToStaticMarkup 不跑 effect
const panelMarkup = renderToStaticMarkup(
  React.createElement(component, { sessionId: 'sess-1', __openForTest: true }),
)
assert.ok(panelMarkup.length > 0)

// --- 工具树（真正的分组/折叠/搜索逻辑）-------------------------------------
const { renderToolTree, filterGroups } = moduleExports.__internals

const state = {
  ok: true,
  mode: 'custom',
  counts: { total: 6, enabled: 4, disabled: 2, fixed: 1 },
  disabled: ['pwsh', 'mcp__rea__open_binary'],
  groups: [
    {
      id: 'shell',
      label: '终端与执行',
      tools: [
        { name: 'pwsh', label: 'pwsh', description: 'Run a command.', enabled: false, locked: false },
        { name: 'bash', label: 'bash', description: '', enabled: true, locked: false },
      ],
    },
    {
      id: 'web',
      label: '网络检索',
      tools: [{ name: 'web_search', label: 'web_search', description: 'Search the web.', enabled: true, locked: false }],
    },
    {
      id: 'mcp:rea',
      label: 'rea · MCP',
      tools: [{ name: 'mcp__rea__open_binary', label: 'open_binary', description: 'Open a binary.', enabled: false, locked: false }],
    },
    {
      id: 'session',
      label: '会话与计划',
      tools: [{ name: 'preset_only_tool', label: 'preset_only_tool', description: 'Agent scoped.', enabled: true, locked: true }],
    },
  ],
}

const treeProps = {
  state,
  needle: '',
  expanded: {},
  setExpanded: () => {},
  toggleGroup: () => {},
  toggleTool: () => {},
}

// 1) 默认：全部收起 —— 只有组头，没有工具行
const treeDefault = renderToStaticMarkup(React.createElement('div', null, renderToolTree(treeProps)))
assert.ok(treeDefault.includes('终端与执行') && treeDefault.includes('rea · MCP'), '默认应渲染各分组标题')
assert.equal(treeDefault.includes('Run a command.'), false, '默认应全部收起，不渲染工具行')
assert.equal(treeDefault.includes('checkbox'), false, '收起状态下不应有勾选框')
assert.ok(treeDefault.includes('▸'), '收起状态下折叠指示应是 ▸')

// 2) 手动展开指定分组：只铺开那一组
const treePartial = renderToStaticMarkup(
  React.createElement('div', null, renderToolTree(Object.assign({}, treeProps, { expanded: { web: true } }))),
)
assert.ok(treePartial.includes('Search the web.'), '展开的组应渲染工具行')
assert.equal(treePartial.includes('Run a command.'), false, '没展开的组仍然收着')

// 3) 全部展开：完整工具树（计数 / 描述 / 锁定 / 淡出）
const expandedAll = { shell: true, web: true, 'mcp:rea': true, session: true }
const tree = renderToStaticMarkup(
  React.createElement('div', null, renderToolTree(Object.assign({}, treeProps, { expanded: expandedAll }))),
)
assert.ok(tree.includes('1/2'), '关闭一个后组计数应为 1/2')
assert.ok(tree.includes('1/1'), '全开的组计数应为 1/1')
assert.ok(tree.includes('0/1'), '全关的组计数应为 0/1')
assert.ok(tree.includes('会话固定'), '不可关闭的工具应标注')
assert.ok(tree.includes('Run a command.'), '应展示工具描述')
assert.ok(tree.includes('opacity:0.55'), '已关闭的工具应淡出')
assert.ok(tree.includes('checkbox'), '每行应带一个（隐藏的）checkbox 以支持键盘/点击切换')

// 搜索：命中标题/描述/名字，而且搜索时自动展开
assert.equal(filterGroups(state.groups, 'web').length, 1, '搜索应只保留命中的分组')
assert.equal(filterGroups(state.groups, 'binary')[0].id, 'mcp:rea', '搜描述也应命中')
assert.equal(filterGroups(state.groups, 'zzz').length, 0)
const searched = renderToStaticMarkup(
  React.createElement('div', null, renderToolTree(Object.assign({}, treeProps, { needle: 'binary' }))),
)
assert.ok(searched.includes('Open a binary.'), '搜索时应收起状态下也自动展开命中项')
const emptyTree = renderToStaticMarkup(
  React.createElement('div', null, renderToolTree(Object.assign({}, treeProps, { needle: 'zzz' }))),
)
assert.ok(emptyTree.includes('没有匹配的工具'), '无命中应有提示')

// 一键整组开关：每个分组标题行上都有「全关 / 全开」，且已经是目标状态的那个置灰
{
  const buttonFor = (markup, groupId, action) => {
    const pattern = new RegExp(
      `<button[^>]*data-group-id="${groupId}"[^>]*data-group-action="${action}"[^>]*>([\\s\\S]*?)</button>`,
    )
    const found = markup.match(pattern)
    if (found === null) return null
    return { tag: found[0], label: found[1].replace(/<[^>]*>/g, '').trim() }
  }

  const shellOff = buttonFor(tree, 'shell', 'off')
  const shellOn = buttonFor(tree, 'shell', 'on')
  assert.ok(shellOff !== null && shellOff.label === '全关', `shell 组应有「全关」按钮，实际 ${JSON.stringify(shellOff?.label)}`)
  assert.ok(shellOn !== null && shellOn.label === '全开', 'shell 组应有「全开」按钮')
  // shell：一个关了一个开着 —— 两个方向都还可点
  assert.equal(shellOff.tag.includes('disabled'), false, '部分关闭时「全关」应可点')
  assert.equal(shellOn.tag.includes('disabled'), false, '部分关闭时「全开」应可点')

  // web：整组全开 -> 「全开」置灰
  const webOff = buttonFor(tree, 'web', 'off')
  const webOn = buttonFor(tree, 'web', 'on')
  assert.equal(webOff.tag.includes('disabled'), false, '全开时「全关」应可点')
  assert.equal(webOn.tag.includes('disabled'), true, '全开时「全开」应置灰')

  // rea 组只有一个工具且被关掉 -> 反过来
  const reaOff = buttonFor(tree, 'mcp:rea', 'off')
  const reaOn = buttonFor(tree, 'mcp:rea', 'on')
  assert.equal(reaOff.tag.includes('disabled'), true, '整组都关了时「全关」应置灰')
  assert.equal(reaOn.tag.includes('disabled'), false, '整组都关了时「全开」应可点')

  // 会话固定（locked）的组没有可关闭项，两个按钮都不可用
  const sessionOff = buttonFor(tree, 'session', 'off')
  assert.equal(sessionOff.tag.includes('disabled'), true, '不可关闭的组不能整组关')

  // 标题行还有一个「展开 / 收起」按钮，默认是 ▸
  const shellToggle = buttonFor(treeDefault, 'shell', 'toggle')
  assert.ok(shellToggle !== null && shellToggle.label === '▸', '收起时组头按钮应是 ▸')
  const shellToggleOpen = buttonFor(tree, 'shell', 'toggle')
  assert.ok(shellToggleOpen !== null && shellToggleOpen.label === '▾', '展开时组头按钮应是 ▾')

  console.log('✓ 一键整组开关：每组「全关/全开」按钮与置灰状态')
}
console.log('✓ 工具树：默认全收起 / 单组展开 / 计数 / 锁定标注 / 搜索自动展开')

console.log('\n全部浏览器侧检查通过')
