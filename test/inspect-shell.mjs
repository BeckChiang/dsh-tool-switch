// 看前端 shell 的平台模块表（确认 react / react-dom 这类 require 是白名单内的）。
//
//   node test\inspect-shell.mjs
import fs from 'node:fs'
import path from 'node:path'
import { APP_ROOT } from './paths.mjs'

const assets = path.join(APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets')
const entry = fs.readdirSync(assets).find((name) => /^index-.*\.js$/.test(name))
if (entry === undefined) {
  console.error('没找到前端入口 chunk；DSH_APP 指对了吗？')
  process.exit(2)
}

const file = path.join(assets, entry)
const source = fs.readFileSync(file, 'utf8')
console.log('chunk:', file, source.length)

for (const needle of ['__ModuleLoader__', 'react-dom', 'react/jsx-runtime', 'staticModules']) {
  const index = source.indexOf(needle)
  console.log(`\n=== ${needle} @${index}`)
  if (index >= 0) console.log(source.slice(Math.max(0, index - 200), index + 320).replace(/\n/g, ' '))
}
