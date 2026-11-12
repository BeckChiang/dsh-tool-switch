// 在真实运行的 harness 上验证 restrict 这条路走通，但**不真正隐藏任何工具**：
// 关掉一个不存在的工具名 -> allow 仍是完整集合 -> 调用 restrict({allow: 全部})，
// 验证通过且模型可用集合不变。最后把选择清空（不留残渣）。
//
//   $env:SESSION="session-<uuid>"; node test\probe-live-restrict.mjs
import { BASE_URL, requireSession } from './paths.mjs'

const session = requireSession()

const post = async (body) => {
  const response = await fetch(`${BASE_URL}/tool-switch/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, data: await response.json() }
}

const before = await (await fetch(`${BASE_URL}/tool-switch/state?session=${encodeURIComponent(session)}`)).json()
console.log('before: mode', before.mode, 'enabled', before.counts.enabled)

const applied = await post({ session, disabled: ['__probe_nonexistent_tool__'] })
console.log('after custom POST: status', applied.status, 'mode', applied.data.mode, 'missing', applied.data.missing)

const cleared = await post({ session, disabled: [] })
console.log('after clear POST: status', cleared.status, 'mode', cleared.data.mode, 'enabled', cleared.data.counts.enabled)

console.log('恢复一致:', cleared.data.counts.enabled === before.counts.enabled && cleared.data.mode === 'all')
