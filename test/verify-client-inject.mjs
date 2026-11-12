// 确认 dsh.client.inject 里点名的包在启动图里确实是「行」，否则组合会拒绝。
//
//   node test\verify-client-inject.mjs
import fs from 'node:fs'
import path from 'node:path'
import { BASE_URL } from './paths.mjs'

const pluginDir = path.resolve(import.meta.dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
const wanted = manifest.dsh?.client?.inject ?? []

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 8000)
let buffer = ''
try {
  const response = await fetch(`${BASE_URL}/plugins/events`, { signal: controller.signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  while (buffer.length < 500000) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    if (buffer.includes('"graph"')) break
  }
  controller.abort()
} catch {
  /* 下面的解析会给出结论 */
} finally {
  clearTimeout(timer)
}

let graph = null
for (const line of buffer.split('\n').filter((entry) => entry.startsWith('data:'))) {
  try {
    const frame = JSON.parse(line.slice(5).trim())
    if (frame?.type === 'graph') graph = frame.graph
  } catch {
    /* 忽略半截帧 */
  }
}

if (graph === null) {
  console.error('拿不到启动图：DSH 没在跑，或端口不是', BASE_URL)
  process.exit(2)
}

const ids = new Set(graph.entries.map((entry) => entry.id))
console.log('启动图里的客户端行:', ids.size)
let failures = 0
for (const name of [...wanted, manifest.name]) {
  const ok = ids.has(name)
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failures += 1
}
console.log('')
console.log(failures === 0 ? 'inject 目标都在图里，组合不会因为缺提供方失败' : `${failures} 个目标不在图里`)
process.exit(failures === 0 ? 0 : 1)
