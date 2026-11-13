/**
 * 面板挂载测试：真把 ToolSwitchButton 挂进 DOM，点一下按钮，断言面板真的出来了。
 *
 * 存在的理由：`renderToolTree` 是纯函数，之前的测试只覆盖了它；面板组件里的
 * 自由变量错误（`usageReady is not defined`）不会被纯函数测试发现，却在真实
 * 页面里让整个 composer dock 子树崩掉 —— 症状是「点一下按钮就消失」。
 *
 * 依赖：react 18 / react-dom 18 / jsdom，装在 DSH_APP 指向的目录里
 * （本机是 C:/Users/recko/DSH/tmp/react-test）。
 *
 *   node test/test-panel.mjs
 *   DSH_APP=C:/path/to/dir/package.json node test/test-panel.mjs
 */

import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const appPackage = process.env.DSH_APP ?? 'C:/Users/recko/DSH/tmp/react-test/package.json'
const appRequire = createRequire(appPackage)

const { JSDOM } = appRequire('jsdom')
const React = appRequire('react')
const { createRoot } = appRequire('react-dom/client')

// ---------------------------------------------------------------------------
// 最小浏览器环境
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body><div id="dock"></div></body></html>', {
  url: 'http://127.0.0.1:50544/',
  pretendToBeVisual: true,
})

globalThis.window = dom.window
globalThis.document = dom.window.document
// Node 24 的 globalThis.navigator 只有 getter，只能重定义不能赋值。
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Node = dom.window.Node
globalThis.Event = dom.window.Event
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = false

// ---------------------------------------------------------------------------
// 假的 Host 响应
// ---------------------------------------------------------------------------

const STATE = {
  ok: true,
  session: 'session-abc',
  live: true,
  mode: 'custom',
  counts: { total: 3, enabled: 1, disabled: 2, fixed: 0 },
  disabled: ['ops_bash', 'read'],
  missing: [],
  groups: [
    {
      id: 'shell',
      label: '终端与执行',
      tools: [
        {
          name: 'ops_bash',
          label: 'ops_bash',
          enabled: false,
          locked: false,
          description: 'Execute a Bash command',
          signature: '(command, description)',
          detail: 'Execute a Bash command in a fresh non-login shell.',
        },
      ],
    },
    {
      id: 'fs',
      label: '文件',
      tools: [
        {
          name: 'read',
          label: 'read',
          enabled: false,
          locked: false,
          description: 'Read a file',
          signature: '(file_path, offset?, limit?)',
          detail: 'Read bounded UTF-8 text lines.',
        },
        {
          name: 'write',
          label: 'write',
          enabled: true,
          locked: false,
          description: 'Write a file',
          signature: '(file_path, content)',
          detail: 'Create or fully replace a UTF-8 text file.',
        },
      ],
    },
  ],
}

const USAGE = {
  ok: true,
  usage: {
    read: { session: 3, d30: 12, all: 400 },
    write: { session: 0, d30: 0, all: 7 },
    // ops_bash 故意缺席：面板必须显示「未用」而不是崩。
  },
  meta: { at: 1, ms: 5, files: 2, parsedFiles: 0, parsedBytes: 0, sessionMatched: true },
}

const calls = []
globalThis.fetch = async (input, init) => {
  const url = String(input)
  calls.push(`${init?.method ?? 'GET'} ${url}`)
  const body = url.startsWith('/tool-switch/usage') ? USAGE : STATE
  return {
    ok: true,
    status: 200,
    json: async () => structuredClone(body),
  }
}

// ---------------------------------------------------------------------------
// 载入客户端 bundle
// ---------------------------------------------------------------------------

let spec
globalThis.window.__ModuleLoader__ = { load: (next) => (spec = next) }
const moduleUrl = pathToFileURL(path.join(here, '..', 'lib', 'client.js')).href
await import(moduleUrl)
assert.ok(spec, '客户端 bundle 没有调用 window.__ModuleLoader__.load')
assert.equal(spec.id, 'dsh-tool-switch')

const requireShim = (name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return appRequire('react-dom')
  if (name === 'react-dom/client') return appRequire('react-dom/client')
  if (name === 'react/jsx-runtime') return appRequire('react/jsx-runtime')
  return appRequire(name)
}

const bundle = spec.factory(requireShim)
const { ToolSwitchButton } = bundle.__internals

// ---------------------------------------------------------------------------
// 挂载 → 点一下 → 面板必须还在
// ---------------------------------------------------------------------------

const container = document.getElementById('dock')
const root = createRoot(container)
root.render(React.createElement(ToolSwitchButton, { sessionId: 'session-abc' }))

const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
await wait(80)

const button = container.querySelector('button[aria-label]')
assert.ok(button, '没有渲染出「工具」按钮')
assert.equal(button.getAttribute('aria-expanded'), 'false')
assert.match(button.getAttribute('aria-label') ?? '', /已关闭 2 个/)

button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
await wait(120)

// 这条是本次回归的核心：面板打开后按钮和面板都必须在。
assert.ok(
  container.querySelector('button[aria-label]'),
  '点一下之后按钮消失了（组件树被卸载）—— 面板渲染期间抛了异常',
)
const dialog = document.body.querySelector('[role="dialog"]')
assert.ok(dialog, '点一下之后没有渲染出面板')
assert.equal(container.querySelector('button[aria-label]').getAttribute('aria-expanded'), 'true')

// 面板内容：三个口径、关闭按钮、工具行、统计徽章
const metrics = [...dialog.querySelectorAll('[data-metric]')].map((node) => node.getAttribute('data-metric'))
assert.deepEqual(metrics, ['session', 'd30', 'all'])
assert.match(dialog.textContent, /本会话可用工具/)
assert.match(dialog.textContent, /1\/3/)

// 分组默认收起：点「展开」把所有组打开（只影响显示）
const expandAll = [...dialog.querySelectorAll('button')].find((node) => node.textContent === '展开')
assert.ok(expandAll, '面板里没有「展开」按钮')
expandAll.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
await wait(60)

const live = () => document.body.querySelector('[role="dialog"]')
assert.match(live().textContent, /ops_bash/)
assert.match(live().textContent, /未用/)
assert.match(live().textContent, /3 次 · 2 未用/)
assert.match(live().textContent, /Execute a Bash command/)

// 展开说明：点描述行
const detailToggle = live().querySelector('[data-detail="ops_bash"]')
assert.ok(detailToggle, '没有可展开的说明入口')
detailToggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
await wait(40)
assert.match(live().textContent, /fresh non-login shell/)

// 改口径：切到全局，read 的说明文字变成「全局调用 400 次」
const allButton = live().querySelector('[data-metric="all"]')
allButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
await wait(40)
assert.ok(
  live().querySelector('[title="全局调用 400 次"]'),
  '切到全局口径后 read 的徽章没有变成 400 次',
)

// 再点一次关闭按钮：面板消失，按钮还在
const close = live().querySelector('button[title^="关闭"]')
close.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
await wait(80)
assert.equal(document.body.querySelector('[role="dialog"]'), null, '关闭后面板还在')
assert.ok(container.querySelector('button[aria-label]'), '关闭后按钮消失了')

assert.ok(calls.some((line) => line.includes('/tool-switch/usage?session=session-abc')), '没有请求调用次数')

root.unmount()

console.log('全部面板挂载检查通过')
