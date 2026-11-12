// 看看当前安装里都有谁在抢 composer 相关 slot（排查「按钮为什么不在」）。
//
//   node test\inspect-composer-owners.mjs
import fs from 'node:fs'
import path from 'node:path'
import { APP_ROOT, PROFILE_NODE_MODULES } from './paths.mjs'

const roots = [PROFILE_NODE_MODULES, path.join(APP_ROOT, 'node_modules')]
const patterns = ['conversation.composer.bar', 'conversation.composer.dock', 'conversation.composer"', "'conversation.composer'"]

function walk(dir, depth = 0, out = []) {
  if (depth > 6) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === '.bin' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, depth + 1, out)
    else if (entry.isFile() && (entry.name === 'client.js' || entry.name.endsWith('.client.js'))) out.push(full)
  }
  return out
}

for (const root of roots) {
  for (const file of walk(root)) {
    const source = fs.readFileSync(file, 'utf8')
    const hits = patterns.filter((pattern) => source.includes(pattern))
    if (hits.length === 0) continue
    console.log(`${file.replace(root + path.sep, '')}  ->  ${hits.join(' , ')}`)
  }
}
