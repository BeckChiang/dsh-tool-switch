// 校验 harness 补丁层里的 dsh-tool-switch 条目能被解析、结构正确。
//
//   node test\verify-config.mjs
//
// 补丁文件位置默认取 %APPDATA%\dsh-desktop\harness\cordis.patch.yml，
// 可用 DSH_HARNESS 指向别的数据目录。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { APP_PACKAGE, HARNESS_DIR, PATCH_FILE, PROFILE_NODE_MODULES } from './paths.mjs'

function loadYaml() {
  const candidates = [APP_PACKAGE, path.join(PROFILE_NODE_MODULES, '..', 'package.json')]
  for (const candidate of candidates) {
    try {
      return createRequire(candidate)('yaml')
    } catch {
      /* 换下一个 */
    }
  }
  throw new Error('找不到 yaml 解析库：请在 DSH Desktop 的安装目录或 profile 下运行')
}

const YAML = loadYaml()
const text = fs.readFileSync(PATCH_FILE, 'utf8')
const doc = YAML.parse(text)

console.log('补丁文件:', PATCH_FILE)
console.log('顶层条目数:', doc.length)

const mine = doc.find(
  (entry) => Array.isArray(entry?.insert) && entry.insert.some((row) => row?.id === 'dsh-tool-switch'),
)
console.log('找到 dsh-tool-switch 条目:', Boolean(mine))
if (mine !== undefined) console.log(JSON.stringify(mine, null, 2))

const pluginDir = path.resolve(import.meta.dirname, '..')
console.log('插件目录:', pluginDir)
console.log('index.js 存在:', fs.existsSync(path.join(pluginDir, 'index.js')))
console.log('lib\\client.js 存在:', fs.existsSync(path.join(pluginDir, 'lib', 'client.js')))
console.log('harness 目录:', HARNESS_DIR)
