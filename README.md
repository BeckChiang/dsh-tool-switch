# dsh-tool-switch

会话级「工具开关」：在输入框下面加一个**工具**按钮，点开按分组勾选这个会话里模型可以用的工具。
关掉的工具不会出现在系统提示词的工具清单里，模型也调不到（调用会得到 `UNKNOWN_TOOL`），改完下一条消息就生效，随时可以再改。

```
┌──────────────────────────────────────────────┐
│ 本会话可用工具                     12/330  ×  │
│ [ 搜索工具… ]                      [全开][全关]│
│ ▾ 会话与计划            12/12                 │
│ ▾ 终端与执行             4/4                  │
│    ☑ pwsh           Run a PowerShell command. │
│    ☐ job_list       List background jobs.     │
│ ▾ rea · MCP            205/207                │
│ ▸ 图像与音视频           5/5   （点组名=整组开关）│
│ 改动从下一条消息开始生效；被关闭的工具模型既看不到也调用不了。│
└──────────────────────────────────────────────┘
```

## 它做了什么

- **按钮位置**：`conversation.composer.dock`——输入框（那个带花边的输入卡片）**正下方那一行**，
  靠右、紧挨着上下文档位圆环（`56%` 那个）左边，是个描边胶囊：`⚙ 工具`。
  关过工具后会变成强调色 + 一个小数字徽章（`工具 3` = 关了 3 个），悬停有提示。
- **默认全收起**：面板一打开（以及切换会话后）所有分类都是收起的，只列 `▸ 分类名 已开/总数 [全关][全开]`，
  想看某一组再点 `▸` 展开。工具栏上有 `展开` / `收起` 一次铺开或收拢所有分类；搜索时命中项会自动展开。
- **一键整组**：每个分组标题行右侧有 `全关` / `全开` 两个小按钮——`全关` 一次关掉这一组下所有可关闭的
  工具（锁定的那些自动跳过），`全开` 一次恢复。当前已经是目标状态的那个按钮会置灰，不会点了没反应还让人怀疑人生。
  点组名本身也还是整组开关（老入口保留）。
- **分组浏览**：内置能力按 会话与计划 / 终端与执行 / 文件与检索 / 网络检索 / 子代理与编排 /
  文档与演示 / 图像与音视频 / MCP 资源 / 社交与发布 / 工具链与维护 分类；MCP 工具按服务器
  （`mcp__<server>__*`）单独成组；认不出来的按名字前缀兜底。支持搜索、折叠（搜索时自动展开）。
- **按会话记忆**：选择存在 `state.json` 里，按 sessionId 记「关掉了哪些」，重启后仍然生效。
- **可放进对话中途改**：直接改就行，下一次模型请求开始用新的集合。
- 面板用 `Esc` 或点面板外任意处关闭；`Esc` 在捕获阶段被面板吃掉并阻止冒泡，所以**不会**顺手把正在跑的回合停掉。
- 折叠状态是「一次性」的：关掉面板或换会话就回到全收起，不会记住你上次展开了哪组（刻意的，省得下次点开一堆）。

## 原理（为什么它真的能挡住工具）

Host 侧用的是框架自带的按 agent 遮罩：

```js
// 只有通过 agent 作用域上下文调用，遮罩才只作用于这个 agent
agent.ctx.tools.restrict({ allow: [...这个会话允许的工具名] })
```

- 遮罩会同时作用于「提示词里的工具清单」「PTC 绑定」和「执行时的工具集合」，所以不是把 UI 藏起来，
  而是模型真的看不到、也调不到。
- 插件记的是**关闭集合**而不是开启集合：`allow = 该 agent 可限制的工具 − 关闭集合`。这样后来才连上的
  MCP 工具默认就是可用的，不会被悄悄藏掉。
- 监听了 `agent/created` / `agent/disposed` / `tools/change`：新建会话、工具集合变化（MCP 晚了注册、
  插件热插拔）都会自动重算；只有 allow 集合真的变了才重装遮罩，避免无谓地让提示词前缀失效。
- 插件卸载时会撤掉自己装的所有遮罩（插件不在，就不该继续改会话能力）。

浏览器半侧是一个手写的客户端 bundle（`lib/client.js`，与官方插件产物同构的
`window.__ModuleLoader__.load({ id, factory })` 形式），注册进 `conversation.composer.dock`
这个 list slot，通过同源 `fetch` 和 Host 通信：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/tool-switch/state?session=<id>` | 工具目录 + 当前选择（分组、描述、是否可关闭） |
| `POST` | `/tool-switch/state` | body `{ session, disabled: [工具名…] }`，空数组=全部启用 |

路由挂在框架的 `webServer` 上，同源、只监听回环；`/api` 那套鉴权不覆盖它，所以页面里 `fetch` 直接用。

## 三个入口，同一份状态

按钮只是壳。真正改状态的路径有三条，写的是同一份 `state.json`、走同一个重装逻辑：

| 入口 | 谁用 | 依赖 |
|---|---|---|
| 输入框下方的 `⚙ 工具` 按钮 | 桌面版 / 网页版 | 需要页面（客户端 bundle） |
| `/tools` 斜杠命令 | 有命令适配器的交互式入口（CLI、网页 composer） | 需要 `ctx.commands`，不需要 webServer、不进模型上下文 |
| `tool_switch` 工具 | **任何入口，包括 QQ / headless** | 只需要模型能调工具 |

```text
/tools                       看分组和当前开关
/tools off rea               关掉 rea 这一组（也认 终端与执行 / mcp:rea / mcp__rea__* / 精确工具名 / all）
/tools on mcp__rea__         按前缀整片打开
/tools all off | all on      全关 / 全开（动词在前后都认）
/tools reset                 全部恢复
```

模型那边同理：用户说「把 XX 类工具关掉」时它会调用 `tool_switch`（`action: off|on|list|reset` + `target`），
QQ 这种没有 UI、也没有 webServer 的部署就靠这条。`tool_switch` 自己**永远不会被关掉**——否则唯一的
headless 入口就没了，所以即使 `all off` 它也留在 allow 集合里。

## 安装 / 卸载

**完整步骤看 [INSTALL.md](INSTALL.md)**（三条验证命令、常见问题、跨平台路径都在那儿）。三步速览：

1. 把仓库放到任意目录，例如 `C:\Users\<你>\Documents\Codex\dsh-tool-switch`。
2. 二选一挂上去：
   - **A（推荐）当作组合包安装**：DSH 左侧栏 **插件 → 安装**，填这个目录的绝对路径
     （或本仓库地址），确认后再刷新页面。仓库自带的 `cordis.patch.yml` 会负责接好 Host 入口。
   - **B 手工挂进补丁层**：在 `<HARNESS_DIR>\cordis.patch.yml` 末尾追加
     （Windows 下 `<HARNESS_DIR>` = `%APPDATA%\dsh-desktop\harness`）：

     ```yaml
     - insert:
         - id: dsh-tool-switch
           name: "file:///C:/Users/<你>/Documents/Codex/dsh-tool-switch/index.js?v=1"
           config:
             stateDir: C:\Users\<你>\AppData\Roaming\dsh-desktop\harness\dsh-tool-switch
     ```

     `?v=1` 只是 ESM 模块缓存的版本后缀：Host 侧代码改过之后把它 +1（或重启 DSH）才会重新加载。
     **卸载**：删掉这整块即可（loader 会热卸载，插件装过的遮罩会一起撤销）。
3. 刷新页面（Ctrl+R），输入框下方出现 `⚙ 工具` 胶囊。

> A、B **不要同时用**：同一份插件被两个 Loader 入口解析到，客户端会报
> `resolves from multiple active Loader sources` 并拒绝组图。

状态文件：`<HARNESS_DIR>\dsh-tool-switch\state.json`（走 A 且没配 `stateDir` 时是 `~/.dsh-tool-switch/state.json`），
格式 `{ version, sessions: { "<sessionId>": { disabled: [...] } } }`；删掉它等于把所有会话恢复成「全部启用」。

### 测试脚本的路径

`test\paths.mjs` 集中解析路径与端口，都可用环境变量覆盖，仓库里没有写死任何个人目录：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `DSH_APP` | `C:\Program Files\DSH Desktop\resources\app\package.json` | 借 app 自带的 React 做渲染测试 / 读前端 chunk |
| `DSH_HARNESS` | `%APPDATA%\dsh-desktop\harness` | 补丁层、profile node_modules、日志 |
| `DSH_URL` | `http://127.0.0.1:43129` | 探针打哪个 web GUI |
| `SESSION` | 无 | 活会话探针要探测的 `session-<uuid>` |

## 找不到按钮时按这个顺序查

1. **它很小**：12px 字、在输入框正下方那行的最右端（`⚙ 工具`，描边胶囊，左边是 `缓存命中 …`、
   右边是 `56%` 上下文档位）。
2. **宿主半侧活着吗**：`curl http://127.0.0.1:43129/tool-switch/state?session=x` 应该返回
   `{"ok":true,...}`；`/tool-switch/state`（不带 session）返回 400；别的路径 404。
   若 404，说明补丁条目没生效（看 `harness\logs\harness.log`），把插件停掉再启用一次即可。
3. **客户端半侧加载了吗**：`node test\probe-client-graph.mjs`——启动图里应有
   `{"id":"dsh-tool-switch","url":"plugins/??dsh-tool-switch/client.js&rev=…"}` 且 bundle 里能找到
   我们的代码。改 `lib/client.js` 后 `rev` 会变，页面会自动热替换；改 `index.js`（Host 侧）需要
   换 `?v=` 或重启。
4. **页面太旧**：Ctrl+R 硬刷新一次。

## 已知边界

- **agent 作用域里注册的工具关不掉**：框架规定「查看作用域自己的注册不受 restrict 影响」。这类工具在面板里
  标成 `· 会话固定` 且勾选框禁用（例如 agent preset 注册的 `ops_discover_tools`）。
- **只有按会话，没有全局默认**：新会话默认全部启用；想要「默认关掉某些」需要再加一层设置命名空间。
- **遮罩按 allow 列表生效**：如果你先关了工具，之后又有同名工具被重新注册，`tools/change` 会重算并把它算进
  「默认启用」。
- **面板没有写 i18n 字典**：文案是中文硬编码（内联在 bundle 里），没有走 `ctx.locale`。

## 自测

```bat
node test\test-host.mjs             :: Host：分组/持久化/restrict 重装/HTTP 路由/卸载清理（10 项）
node test\test-client.mjs           :: 客户端：bundle 协议、slot 注册形状、默认收起、整组一键、真实 React 渲染（6 项）
node test\verify-config.mjs         :: 本机补丁层 + 本仓库的组合包声明（bundle patch / locale / icon）
node test\verify-client-inject.mjs  :: dsh.client.inject 点名的包确实是启动图里的行
node test\probe-route.mjs           :: 打真实实例，看 400 / 200 / 404
node test\probe-client-graph.mjs    :: 启动图里有没有这一行、bundle 能否取到
node test\probe-live.mjs            :: $env:SESSION=… 后看某个会话的目录/agent 视图
```

`test\test-host.mjs` 用最小 ctx 桩跑通主路径；`test\test-client.mjs` 借 app 自带的 React 做静态渲染。
路径与端口都由 [test/paths.mjs](test/paths.mjs) 解析，可用 `DSH_APP` / `DSH_HARNESS` / `DSH_URL` / `SESSION` 覆盖。
