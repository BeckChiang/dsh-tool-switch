// 打印某个会话的工具分组情况（只读）。
//
//   $env:SESSION="session-<uuid>"; node test\dump-groups.mjs
import { BASE_URL, requireSession } from './paths.mjs'

const session = requireSession()
const response = await fetch(`${BASE_URL}/tool-switch/state?session=${encodeURIComponent(session)}`)
const data = await response.json()

console.log(`live=${data.live} total=${data.counts?.total} groups=${data.groups?.length}`)
for (const group of data.groups) {
  console.log(`\n### ${group.label} (${group.id}) — ${group.tools.length}`)
  if (!group.id.startsWith('mcp:')) console.log(group.tools.map((tool) => tool.name).join(', '))
}
