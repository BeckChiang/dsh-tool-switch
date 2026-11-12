// 校验两件事：
//   1) 本机 harness 补丁层里的 dsh-tool-switch 条目能被解析、结构正确；
//   2) 这个仓库自己的组合包声明是完整的（dsh.bundle.patch / dsh.client / locale / icon），
//      这样它才能被「插件页 → 安装」或 install_bundle 当一个组合包装上去。
//
//   node test\verify-config.mjs
//
// 补丁文件位置默认取 %APPDATA%\dsh-desktop\harness\cordis.patch.yml，
// 可用 DSH_HARNESS 指向别的数据目录。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { APP_PACKAGE, PATCH_FILE, PROFILE_NODE_MODULES } from './paths.mjs'

const pluginDir = path.resolve(import.meta.dirname, '..')

function loadYaml() {
  const candidates = [APP_PACKAGE, path.join(PROFILE_NODE_MODULES, '..', 'package.json')]
  for (const candidate of candidates) {
    try {
      return createRequire(candidate)('yaml')
    } catch {
      /* 换下一个 */
    }
  }
  throw new Error('找不到 yaml 解析库：请设置 DSH_APP 指向 DSH Desktop 的 app/package.json')
}

const YAML = loadYaml()
let failures = 0
const check = (label, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures += 1
}

// --- 1) 本机补丁层 ---------------------------------------------------------
console.log(`补丁文件: ${PATCH_FILE}`)
if (fs.existsSync(PATCH_FILE)) {
  const doc = YAML.parse(fs.readFileSync(PATCH_FILE, 'utf8'))
  check(`补丁层可解析（顶层 ${Array.isArray(doc) ? doc.length : '非数组'} 条）`, Array.isArray(doc))
  const mine = Array.isArray(doc)
    ? doc.find((entry) => Array.isArray(entry?.insert) && entry.insert.some((row) => row?.id === 'dsh-tool-switch'))
    : undefined
  check('补丁层里有 id=dsh-tool-switch 的 insert 条目', mine !== undefined)
  if (mine !== undefined) console.log(JSON.stringify(mine, null, 2))
} else {
  console.log('（本机没有这个补丁文件，跳过：说明本机可能走的是组合包安装方式）')
}

// --- 2) 仓库自身的组合包声明 ------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
check('package.json 有 name/version', typeof manifest.name === 'string' && typeof manifest.version === 'string')
check('name 与目录名一致（dsh-tool-switch）', manifest.name === 'dsh-tool-switch')

const patchRel = manifest.dsh?.bundle?.patch
check('声明了 dsh.bundle.patch', typeof patchRel === 'string')
const patchPath = typeof patchRel === 'string' ? path.join(pluginDir, patchRel) : undefined
check('bundle patch 文件存在', patchPath !== undefined && fs.existsSync(patchPath))

const bundlePatch = patchPath !== undefined && fs.existsSync(patchPath)
  ? YAML.parse(fs.readFileSync(patchPath, 'utf8'))
  : undefined
const bundleRow = Array.isArray(bundlePatch)
  ? bundlePatch.flatMap((entry) => entry?.insert ?? []).find((row) => row?.id === 'dsh-tool-switch')
  : undefined
check('bundle patch 插入了 dsh-tool-switch 行', bundleRow !== undefined)
check('bundle patch 用包名（不是文件路径）挂载', bundleRow?.name === manifest.name)
check('bundle patch 里没有写死个人状态目录', bundleRow?.config === undefined)

check('声明了 dsh.client(platform=web)', manifest.dsh?.client?.platform === 'web')
check('exports 里有 ./client', typeof manifest.exports?.['./client'] === 'string')
check('client bundle 存在', fs.existsSync(path.join(pluginDir, manifest.exports?.['./client'] ?? 'lib/client.js')))
check('Host 入口 index.js 存在', fs.existsSync(path.join(pluginDir, 'index.js')))

for (const locale of ['zh', 'en']) {
  const file = path.join(pluginDir, 'locale', `${locale}.json`)
  let ok = false
  try {
    const dict = JSON.parse(fs.readFileSync(file, 'utf8'))
    ok = typeof dict?.meta?.title === 'string' && typeof dict?.meta?.description === 'string'
  } catch {
    ok = false
  }
  check(`locale/${locale}.json 的 meta.title/description 可用`, ok)
}

check('icon.svg 存在', fs.existsSync(path.join(pluginDir, 'icon.svg')))
check('LICENSE 存在', fs.existsSync(path.join(pluginDir, 'LICENSE')))
check('README.md 存在', fs.existsSync(path.join(pluginDir, 'README.md')))
check('files[] 与磁盘一致（不该有 INSTALL.md 这类已删文档）', (manifest.files ?? []).every((entry) => {
  const target = path.join(pluginDir, entry.replace(/\/$/, ''))
  return fs.existsSync(target)
}))

console.log('')
console.log(failures === 0 ? '全部检查通过' : `${failures} 项检查未通过`)
process.exit(failures === 0 ? 0 : 1)
