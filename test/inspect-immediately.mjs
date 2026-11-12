// 看客户端 boot 图里 immediately 的含义（只影响 bootstrap 预取，不影响条目是否创建）。
//
//   node test\inspect-immediately.mjs
import fs from 'node:fs'
import path from 'node:path'
import { APP_ROOT } from './paths.mjs'

const assets = path.join(APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets')
const entry = fs.readdirSync(assets).find((name) => /^index-.*\.js$/.test(name))
if (entry === undefined) {
  console.error('没找到前端入口 chunk；DSH_APP 指对了吗？')
  process.exit(2)
}

const source = fs.readFileSync(path.join(assets, entry), 'utf8')
let count = 0
for (const match of source.matchAll(/immediately/g)) {
  console.log(`\n--- @${match.index}`)
  console.log(source.slice(Math.max(0, match.index - 420), match.index + 260).replace(/\n/g, ' '))
  if (++count >= 6) break
}
console.log('\ncount', count)
