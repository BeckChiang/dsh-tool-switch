// 只读探测：确认某个会话的 agent 是否被跟踪、目录是否按 agent 视图统计。
//
//   $env:SESSION="session-<uuid>"; node test\probe-live.mjs
import { BASE_URL, requireSession } from './paths.mjs'

const session = requireSession()
const response = await fetch(`${BASE_URL}/tool-switch/state?session=${encodeURIComponent(session)}`)
const data = await response.json()

console.log(`session ${session}`)
console.log(`live=${data.live} total=${data.counts?.total} fixed=${data.counts?.fixed} groups=${data.groups?.length}`)

if (data.live !== true) {
  console.log('这个会话当前没有活着的 Agent（打开它以创建）：只读目录仍可用')
  process.exit(0)
}

console.log('分组:', data.groups.map((group) => `${group.label}:${group.tools.length}`).join(' | '))
const all = data.groups.flatMap((group) => group.tools)
const locked = all.filter((tool) => tool.locked)
console.log('会话固定（restrict 管不到）的工具:', locked.map((tool) => tool.name).join(', ') || '(无)')
console.log('样例:', all.slice(0, 6).map((tool) => `${tool.name}[${tool.label}]`).join(', '))
