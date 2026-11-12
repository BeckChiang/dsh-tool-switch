// 测试脚本共用的路径/端口解析：不在仓库里写死任何个人目录。
//
// 环境变量（都可以不设）：
//   DSH_APP       DSH Desktop 资源目录里的 package.json 路径
//                 默认 C:\Program Files\DSH Desktop\resources\app\package.json
//   DSH_HARNESS   harness 数据目录（%APPDATA%\dsh-desktop\harness）
//   DSH_URL       web GUI 地址，默认 http://127.0.0.1:43129
//   SESSION       要探测的会话 id（session-<uuid>），live 探针必填
import os from 'node:os'
import path from 'node:path'

const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')

export const APP_PACKAGE =
  process.env.DSH_APP ?? 'C:\\Program Files\\DSH Desktop\\resources\\app\\package.json'

export const APP_ROOT = path.dirname(APP_PACKAGE)

export const HARNESS_DIR = process.env.DSH_HARNESS ?? path.join(appData, 'dsh-desktop', 'harness')

export const PROFILE_NODE_MODULES = path.join(HARNESS_DIR, 'profiles', 'web', 'node_modules')

export const PATCH_FILE = path.join(HARNESS_DIR, 'cordis.patch.yml')

export const BASE_URL = process.env.DSH_URL ?? 'http://127.0.0.1:43129'

/** 读 SESSION 环境变量；没设时给出人话提示。 */
export function requireSession() {
  const session = process.env.SESSION
  if (typeof session === 'string' && session.length > 0) return session
  console.error('需要 SESSION 环境变量，例如：')
  console.error('  $env:SESSION="session-<uuid>"; node test\\probe-live.mjs')
  console.error('（会话 id 可以在 harness\\sessions\\<工作区>\\ 下看到，或从 GUI 的地址里拿）')
  process.exit(2)
}
