// 查看客户端启动图里有没有 dsh-tool-switch 这一行，以及 bundle 能否取到。
//
//   node test\probe-client-graph.mjs
import { BASE_URL } from './paths.mjs'

const base = BASE_URL
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 8000)

let buffer = ''
try {
  const response = await fetch(`${base}/plugins/events`, { signal: controller.signal })
  console.log('events status', response.status, response.headers.get('content-type'))
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  while (buffer.length < 400000) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    if (buffer.includes('"graph"') && buffer.includes('dsh-tool-switch')) break
  }
  controller.abort()
} catch (error) {
  if (error.name !== 'AbortError') console.log('events error', error.message)
} finally {
  clearTimeout(timeout)
}

const frames = buffer.split('\n').filter((line) => line.startsWith('data:'))
console.log('sse data frames:', frames.length)

let graph = null
for (const frame of frames) {
  try {
    const parsed = JSON.parse(frame.slice(5).trim())
    if (parsed?.type === 'graph') graph = parsed.graph
  } catch {
    /* 忽略半截帧 */
  }
}

if (graph === null) {
  console.log('没有拿到 graph 帧（前 200 字符）:', JSON.stringify(buffer.slice(0, 200)))
} else {
  console.log('release', graph.release)
  console.log('entries', graph.entries.length)
  const mine = graph.entries.filter((entry) => String(entry.id).includes('tool-switch'))
  console.log('tool-switch rows:', JSON.stringify(mine, null, 2))

  const batches = graph.batches.filter((batch) =>
    batch.entries.some((id) => String(id).includes('tool-switch')),
  )
  console.log('batches with my row:', JSON.stringify(batches.map((b) => ({ phase: b.phase, url: b.url })), null, 2))

  for (const batch of batches) {
    const response = await fetch(`${base}/${batch.url}`)
    const body = await response.text()
    const hit = body.includes('dsh-tool-switch') && body.includes('conversation.composer.dock')
    console.log(`bundle ${batch.phase} -> ${response.status}, ${body.length} bytes, 含我的代码: ${hit}`)
  }
}
