# 安装指南

> 适用：**DSH Desktop 0.13.x**（内置 DeepSeek Harness `0.2.2-alpha.x`）与同版本的 `dsh` CLI。
> 插件本身**零依赖、无需构建**：`index.js` 是 Host 半侧（Node ESM），`lib/client.js` 是手写的
> 客户端 bundle（`window.__ModuleLoader__.load({ id, factory })` 格式，与官方插件产物同构）。

安装有两条路，选一条就好：

| 方式 | 适合谁 | 特点 |
|---|---|---|
| **A. 作为「组合包」安装**（推荐） | 一般用户 | 插件页点几下就装上；升级 DSH 后仍在；可随时停用/卸载 |
| **B. 在补丁层里手工挂载** | 想直接对着源码改、或不想让包管理器动 profile | 立刻热生效，改完就见效；但 profile 重装/清理时可能丢 |

> 两条路**不要同时用**——同一份插件被两个 Loader 入口解析到，客户端会报
> `package dsh-tool-switch resolves from multiple active Loader sources` 并拒绝组图。

---

## 0. 先认清三个位置

| 名字 | 是什么 | 怎么找 |
|---|---|---|
| **插件目录** `<PLUGIN_DIR>` | 这个仓库放在哪 | 你自己放的地方，例如 `C:\Users\<你>\Documents\Codex\dsh-tool-switch` |
| **Profile 目录** `<PROFILE_DIR>` | 当前正在跑的那套插件组合 | 见下表；有 `cordis.patch.yml`、`package.json`、`node_modules` |
| **Harness 数据目录** `<HARNESS_DIR>` | 会话、日志、`cordis.patch.yml` 所在 | 见下表；日志在 `<HARNESS_DIR>\logs\harness.log` |

| 系统 | `<HARNESS_DIR>` | `<PROFILE_DIR>`（默认 profile 名 `web`） |
|---|---|---|
| Windows | `%APPDATA%\dsh-desktop\harness` | `<HARNESS_DIR>\profiles\web` |
| macOS | `~/Library/Application Support/dsh-desktop/harness` | `<HARNESS_DIR>/profiles/web` |
| Linux | `~/.config/dsh-desktop/harness` | `<HARNESS_DIR>/profiles/web` |

**怎么确认自己找对了**：`<PROFILE_DIR>\package.json` 里有 `"dsh": { "profile": { "bundles": [...] } }`，
`<PROFILE_DIR>\cordis.patch.yml` 里有你装过的其它插件（`dsh-ops`、`dsh-market` 之类）。

想在命令行里确认（Desktop 拉起 Harness 时会注入这些变量，普通终端里没有）：

```powershell
# PowerShell（Windows 预设）
$env:DSH_PROFILE_DIR      # -> <PROFILE_DIR>
$env:DSH_PROFILE          # -> web
```

```bash
# bash（macOS / Linux）
echo "$DSH_PROFILE_DIR" "$DSH_PROFILE"
# 或者：dsh --profile web --dump-config | head -40
```

---

## 方式 A：作为组合包安装（推荐）

这个仓库根目录带着 `package.json` 的 `dsh.bundle.patch` 与 `cordis.patch.yml`，
所以它本身就是一个可安装的**组合包**：装上去之后，它自带的补丁层会把 Host 入口接进插件树，
不需要你手改任何 profile 配置。

### A-1 用界面装（最省事）

1. 左侧栏点 **插件**（不是「设置 → 插件」，那里是只读列表）。
2. 点 **安装**，把 **插件目录的绝对路径** 贴进去，例如
   `C:\Users\<你>\Documents\Codex\dsh-tool-switch`。
   也可以粘这个仓库的地址：`https://github.com/suqing114/dsh-tool-switch`。
3. 确认安装 → 等日志跑完（本插件没有依赖，通常一两秒）。
4. 安装完它会自动被选中/启用。**刷新页面（Ctrl+R）**，输入框下方出现 `⚙ 工具` 胶囊即成功。

> 装的是本地目录时，profile 记录的是 `link:<绝对路径>`：以后你在这个仓库里改代码，
> 效果直接跟着变（Host 侧改完仍需重启，客户端 bundle 会热替换）。

### A-2 用 agent / CLI 装

在 DSH 里让 agent 装（Full access 下不会弹审批）：

```
用 plugin_manager 的 install_bundle，target 指向 C:\Users\<你>\Documents\Codex\dsh-tool-switch
```

或命令行：

```powershell
dsh plugin install "C:\Users\<你>\Documents\Codex\dsh-tool-switch"
dsh plugin list                     # 确认 dsh-tool-switch 在列表里且已启用
```

### A-3 卸载

- 界面：**插件** 页找到 `dsh-tool-switch` → 取消选择 / 移除。
- CLI：`dsh plugin remove dsh-tool-switch`。
- 移除后刷新页面，按钮消失；`<HARNESS_DIR>\dsh-tool-switch\state.json`（或
  `~/.dsh-tool-switch/state.json`）可以留着，也可以删掉。

---

## 方式 B：在补丁层里手工挂载

适合「我就在改这份源码」的场景。两种写法二选一。

### B-1 直接指向目录（file URL，本机现在用的就是这种）

编辑 `<HARNESS_DIR>\cordis.patch.yml`，在**末尾**追加（注意 YAML 顶层是数组，前面的条目不要动）：

```yaml
- insert:
    - id: dsh-tool-switch
      name: "file:///C:/Users/<你>/Documents/Codex/dsh-tool-switch/index.js?v=1"
      config:
        stateDir: C:\Users\<你>\AppData\Roaming\dsh-desktop\harness\dsh-tool-switch
```

- Windows 路径写成 `file:///C:/...`（正斜杠，三个斜杠）；macOS/Linux 例如
  `"file:///Users/<你>/code/dsh-tool-switch/index.js?v=1"`。
- `?v=1` 是 **ESM 模块缓存版本后缀**：Host 侧代码改过之后，把这个数字 +1（或重启 DSH）
  才会加载新代码；客户端 `lib/client.js` 不用管，它按 mtime 自动热替换。
- `config` 可以整段省略（默认状态目录是 `~/.dsh-tool-switch`）。
- **热生效**：保存文件后 Loader 会自己重挂，不用重启；页面刷新一次即可看到按钮。
- **卸载**：删掉 `- insert:` 这整块（连同它下面的两行），保存即可热卸载；
  插件卸载时会自动撤销它装过的所有工具遮罩。

### B-2 拷进 profile 的 node_modules，用包名挂

```powershell
# Windows：把仓库复制进 profile 的 node_modules（不要用符号链接，pnpm 清理时容易断）
Copy-Item -Recurse "C:\Users\<你>\Documents\Codex\dsh-tool-switch" `
  "$env:APPDATA\dsh-desktop\harness\profiles\web\node_modules\dsh-tool-switch"
```

```yaml
- insert:
    - id: dsh-tool-switch
      name: "dsh-tool-switch"
```

> 注意：这种方式下次 `pnpm install` / 插件页装别的包时，可能把这份拷贝清掉。
> 要长期用请走**方式 A**。

---

## 方式 C：用包管理器装（Git / tarball / 注册表）

先弄清一件事：`pnpm add` 只把包放进 `node_modules`，DSH 还要知道「这个组合包要参与组合」。
所以是**两步**——先装包，再让 profile 认它（插件页做的就是这两步）。

### C-1 从 GitHub 直接装

```powershell
cd <PROFILE_DIR>
pnpm add github:suqing114/dsh-tool-switch#v0.2.0     # 建议锁 tag，别跟 main 漂移
```

然后二选一让 profile 认它：

- 把 `"dsh-tool-switch"` 加进 `<PROFILE_DIR>\package.json` 的 `dsh.profile.bundles` 数组
  （它自带补丁层，会自动插入 Host 入口）；
- 或者在 `<HARNESS_DIR>\cordis.patch.yml` 里 insert 一行 `name: 'dsh-tool-switch'`（用包名）。

> 实测（2026-11-13，pnpm 10.34.5）：空目录里 `pnpm add github:suqing114/dsh-tool-switch` →
> `+ dsh-tool-switch 0.2.0`；装出来的 `index.js`、`lib/client.js` 都能过 `node --check`，
> `dsh.bundle.patch` / `dsh.client` 声明完整。

### C-2 从本地 tarball 装

```powershell
cd <PLUGIN_DIR>
npm pack                                    # 产出 dsh-tool-switch-0.2.0.tgz，28 kB，只含发布文件
cd <PROFILE_DIR>
pnpm add "file:C:\Users\<你>\Documents\Codex\dsh-tool-switch\dsh-tool-switch-0.2.0.tgz"
```

### C-3 从 npm 注册表装

#### 现状（2026-11）

**已发布**：[`dsh-tool-switch`](https://www.npmjs.com/package/dsh-tool-switch) 在 npm 上，`latest` = **0.2.1**。

```powershell
pnpm add dsh-tool-switch        # 或在插件页里直接装
```

> 发布时踩到的两件事，记在这儿省得下次重复：
> ① 账号开了**通行密钥 2FA**，CLI 发布产生不了 OTP，`npm publish` 只会给个被脱敏的
> `https://www.npmjs.com/auth/cli/***` 然后 `EOTP` 退出——即使给它真 TTY。
> ② 用一次性 bypass-2FA 令牌 `npm publish` 时，npm 会先把版本放进「staged」队列并回一句
> `Your package is being processed…`，**过一两分钟才真的出现在注册表**；同一版本号重发会得到
> `E409 Cannot publish over previously staged version`。所以别急着重试，等一等再 `npm view`。
> 另外这种令牌**做不了 `npm unpublish`**（`403 ... bypass two-factor authentication may not perform this action`）。

包里还残留两个历史版本（`0.0.0-stage` 占位、`0.2.0` 早期尝试），删不掉是因为上面的 403；
配好下面的 Trusted Publishing 后，可以在 npmjs 网页上删，或走 CI 的 OIDC 发一条清理命令。

#### 发布新版本：走 OIDC，不用任何 token

npmjs.com → `dsh-tool-switch` → **Settings → Trusted publishing**（GitHub Actions）：

| 字段 | 值 |
|---|---|
| Organization or user | `suqing114` |
| Repository | `dsh-tool-switch` |
| Workflow filename | `publish.yml` |
| Allowed actions | `npm publish` |

再把 **Publishing access** 改成 **“Require two-factor authentication and disallow tokens”**。
之后连 bypass token 都不允许，只有仓库里 `.github/workflows/publish.yml` 能发它走 OIDC +
provenance（`permissions: id-token: write`，全程没有密钥）。

发版流程：

```powershell
# 改 package.json 的 version
git tag v0.2.2; git push --tags     # 工作流自动发布 + 生成 provenance
```

#### 历史记录：首次发布是怎么过的

包必须先在注册表里存在，才能在网页上配 trusted publisher，所以首次那一次用了短期凭据
（Granular token + bypass 2FA，Expiration 7 天，发出后立刻吊销）：

```powershell
$tmp = "$env:TEMP\npmrc-publish"; "//registry.npmjs.org/:_authToken=`${NODE_AUTH_TOKEN}" | Set-Content $tmp -Encoding ascii
$env:NODE_AUTH_TOKEN = "npm_xxx"        # 短命 token，别写进仓库、别进 CI
npm publish --userconfig $tmp
Remove-Item $tmp                        # 立刻删
```

### C-4 本地开发：link 进去

```powershell
cd <PROFILE_DIR>
pnpm add "link:C:\Users\<你>\Documents\Codex\dsh-tool-switch"
```

之后你改仓库里的代码，profile 里的那份立刻跟着变（Host 侧仍需重启或换 `?v=`）。

> ⚠️ 已经用方式 A / B 装过的，**不要再用 pnpm 装一遍**：同一份插件被两个 Loader
> 来源解析到，客户端会报 `resolves from multiple active Loader sources` 并拒绝组图。
> 换方式之前先把旧的那条摘掉。

## 装完怎么验（三条，从底层往上）

```powershell
# 1) Host 路由活着：200 + JSON；不带 session 应 400；随便一个路径应 404
curl.exe "http://127.0.0.1:43129/tool-switch/state?session=test"
curl.exe "http://127.0.0.1:43129/tool-switch/state"
```

```powershell
# 2) 客户端启动图里有这一行（bundle 也能取到）
cd <PLUGIN_DIR>
node test\probe-client-graph.mjs
# 期望：entries 里出现 {"id":"dsh-tool-switch","url":"plugins/??dsh-tool-switch/client.js&rev=…"}
#      并且 bundle … 含我的代码: true
```

3. 页面里：输入框卡片**正下方那一行**、靠右、紧挨 `56%` 上下文档位左边 → `⚙ 工具` 胶囊。
   点开是分组面板（默认全部收起），每类后面有 `全关 / 全开`。

端口不是 43129 的话（`dsh web --port` 或用别的方式起的），把地址换成实际端口；
`test\paths.mjs` 里所有路径/端口都能用环境变量覆盖：

```powershell
$env:DSH_URL = "http://127.0.0.1:38999"
$env:DSH_HARNESS = "D:\elsewhere\harness"
node test\probe-route.mjs
```

---

## headless / QQ 这类没有输入框的入口

按钮是给页面用的。没有页面（甚至没有 `webServer`）的时候，用另外两条通道——它们和按钮写同一份状态：

1. **直接跟模型说**：在会话里说「把 rea 那类工具关掉 / 打开」，模型会调用 `tool_switch`
   （`action: off|on|list|reset`，`target` 认分组名、`mcp__rea__` 前缀、精确工具名或 `all`）。
   这条**不需要 webServer**，只要有 agent 能跑工具就行，QQ 那种转发式入口最合适。
2. **斜杠命令**（需要该入口有命令适配器，例如 CLI 或网页 composer）：

   ```
   /tools                     看分组与当前开关
   /tools off rea             关掉整组
   /tools on mcp__rea__       按前缀打开
   /tools all off｜all on      全关 / 全开
   /tools reset               全部恢复
   ```

3. **HTTP**（有 `webServer` 时，脚本/外部程序用）：

   ```bash
   curl "http://127.0.0.1:43129/tool-switch/state?session=session-<uuid>"
   curl -X POST "http://127.0.0.1:43129/tool-switch/state" \
        -H 'content-type: application/json' \
        -d '{"session":"session-<uuid>","disabled":["mcp__rea__open_binary"]}'
   ```

> `webServer` 只有 `dsh-web-app` 这个组合包会挂（桌面版、`dsh web` 自带；纯 CLI 组合没有），
> 所以脚本方案在没有页面的部署里要先确认这条路由存在（404 = 没挂，改用前两条）。
> `tool_switch` 自己不会被关掉，`all off` 之后它也还在，所以永远留着一个人能改回来的入口。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `curl …/tool-switch/state` 返回 **404** | 补丁没生效：确认 `- insert:` 块在 `cordis.patch.yml` 末尾、`id` 没拼错、文件保存了；看 `<HARNESS_DIR>\logs\harness.log` 里有没有 `patch: entry … not found` 之类的行；方式 B 下重新触发一次热加载（随便改一下该文件）即可 |
| 路由 200，但页面**没有按钮** | 客户端半侧没加载：先 Ctrl+R 硬刷；再跑第 2 条验证。若启动图里没有这一行，说明 `package.json` 的 `dsh.client` 没被读到——方式 B-1 改 `package.json` 后需要重启 DSH |
| 日志里 `resolves from multiple active Loader sources` | 同一份插件被挂了两遍（比如方式 A 和 B 同时开）。留一条，删掉另一条 |
| 改了 `index.js`，行为没变 | Host 侧代码只在条目重启时重新导入：方式 B-1 把 `?v=` 数字 +1，或重启 DSH |
| 改了 `lib/client.js`，样式没变 | 客户端 bundle 按 mtime 热替换，通常几秒内生效；没生效就 Ctrl+R |
| 面板里有些工具标 `· 会话固定`、勾选框是灰的 | 那是 agent 作用域内注册的工具，框架规定 `tools.restrict` 管不到它们（例如某些预设注册的 `ops_discover_tools`） |
| 关掉工具后模型“看不见”了，但我想验证真的挡住了 | 关掉某工具后让它调用一次，会得到 `UNKNOWN_TOOL`；`test\probe-live-restrict.mjs` 是同一路径的自动版（不会真的隐藏任何工具） |
| 想一次性恢复默认 | 删掉状态文件（`<HARNESS_DIR>\dsh-tool-switch\state.json` 或 `~/.dsh-tool-switch/state.json`），或在面板里点 `全开` |

## 安全边界

- 路由只监听 loopback（Harness 的 `webServer` 本来就这么绑），同源访问；
  `/api` 那套鉴权不覆盖它，因此**本机**任何进程都能读写这个状态——它只影响“本会话模型能用哪些工具”，
  不涉及凭证、文件内容或执行权限。
- 插件不联网、不读环境变量里的密钥；唯一的磁盘写入是它自己的 `state.json`。
- 状态按 sessionId 存，换会话互不影响；插件被卸载/停用时所有遮罩会被撤销，工具集合回到全开。
