// 探测运行中的 harness：路由状态码（不修改任何状态）。
//
//   node test\probe-route.mjs
//   期望：不带 session -> 400；POST 空列表 -> 200；别的路径 -> 404
import { BASE_URL } from './paths.mjs'

async function probe(path, init) {
  try {
    const response = await fetch(BASE_URL + path, init)
    const text = await response.text()
    console.log(`${path} -> ${response.status} :: ${text.slice(0, 200).replace(/\s+/g, ' ')}`)
  } catch (error) {
    console.log(`${path} -> ERR ${error.message}`)
  }
}

await probe('/tool-switch/state')
await probe('/tool-switch/state', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ session: 'probe-unsaved', disabled: [] }),
})
await probe('/nonexistent-path-probe')
