# dsh-tool-switch

> **这是 fork**：`BeckChiang/dsh-tool-switch`，基于 [suqing114/dsh-tool-switch](https://github.com/suqing114/dsh-tool-switch)（MIT，0.2.2）。
> 上游 = 会话级工具开关本体；本 fork 在原功能之上加了**工具调用次数统计**（本会话 / 近 30 天 / 全局，
> 面板可切换口径、可按频率排序）与**参数签名 / 完整说明**（详见下文「调用次数」）。上游升级时以
> `upstream` remote 合并，冲突优先保留上游行为。

给 DeepSeek Harness 用的**会话级工具开关**：点开输入框下方的「工具」按钮，按分组勾选这个会话里模型
**可以**用哪些工具。关掉的工具会从系统提示词的工具清单里消失，模型也调不到（调用得到 `UNKNOWN_TOOL`），
改完下一条消息生效，随时可以再改。

```
┌──────────────────────────────────────────────┐
│ 本会话可用工具                     328/330  ×  │
│ [ 搜索工具… ]              展开 收起 │ 全开 全关 │
│ ▸ 会话与计划            12/12      [全关] 全开 │
│ ▸ 终端与执行             4/4       [全关] 全开 │
│ ▾ rea · MCP            205/207     [全关] 全开 │
│    ☑ mcp__rea__open_binary                   │
│    ☐ mcp__rea__analyze_function              │
│ 改动从下一条消息开始生效；被关闭的工具模型既看不到也调用不了。│
└──────────────────────────────────────────────┘
```

## 功能

- **按钮**：输入框**正下方那一行**的最右端（`⚙ 工具` 描边胶囊，紧挨 `56%` 上下文档位左边）。
  关过工具后变强调色 + 数字徽章（`工具 3` = 关了 3 个）。
- **默认全收起**：打开面板、切换会话都回到「只列分类头」，点 `▸` 展开；工具栏 `展开/收起` 一次铺开或收拢，
  搜索时命中项自动展开。
- **一键整组**：每个分类右侧 `全关/全开`，一次关掉/恢复整组（`· 会话固定` 的自动跳过，已是目标状态的按钮置灰）。
- **分组**：内置能力按 会话与计划 / 终端与执行 / 文件与检索 / 网络检索 / 子代理与编排 / 文档与演示 /
  图像与音视频 / MCP 资源 / 社交与发布 / 工具链与维护 分类；MCP 工具按服务器（`mcp__<server>__*`）单独成组；
  认不出来的按名字前缀兜底。
- **按会话记忆**：选择存在 `state.json`（按 sessionId 记「关掉了哪些」），重启后仍生效；对话中途随时改。
- 面板 `Esc` 或点面板外关闭；`Esc` 被面板在捕获阶段吃掉，**不会**顺手把正在跑的回合停掉。

## 调用次数

面板打开时同时按一次统计：扫描本机会话日志（`~/.dsh/sessions/**/session.v4.jsonl.zstd`，多帧 zstd），
数出每个工具被 `tool/call` 调用了多少次，给出三个口径，工具栏中间的三段开关随时切换：

| 口径 | 含义 |
|---|---|
| 本会话 | 只数当前会话的那份日志，关掉哪个工具最直接影响它 |
| 30 天 | 最近 30 天所有会话（滚动窗口，按天分桶） |
| 全局 | 本机有日志以来的全部调用 |

- 左边显示次数徽章，**一次都没调用过**的工具标虚线「未用」——这是排除干扰项最直接的依据。
- 「按频率 ↓」把调用多的组和工具排到前面（默认仍按固定分组顺序）。
- 分组头 `·N` 是该组在当前口径下的总次数；面板标题右侧是总调用数与未用个数。
- 统计只进界面，**不进提示词**：不改工具清单、不影响前缀缓存，也不会让模型看到「你自己用得少」。
- 解析结果按文件 `size + mtime` 缓存在 `~/.dsh-tool-switch/usage-cache.json`，只有增长的日志会重解析
  （缓存命中时打开面板约几十毫秒；首次冷扫约 4 秒，几十万条调用）。
- 统计失败只是面板底部一行提示，不影响开关本身。

工具行还带两样辅助信息：名字后面的**参数签名**（`(command, timeout?)`，鼠标悬停即可看），
以及可点击展开的**完整说明**（默认只显示首行）。

## 三个入口，同一份状态

按钮只是壳。下面三条路径写同一份 `state.json`、走同一个重装逻辑：

| 入口 | 谁用 | 依赖 |
|---|---|---|
| `⚙ 工具` 按钮 | 桌面版 / 网页版 | 页面（客户端 bundle） |
| `/tools` 斜杠命令 | 有命令适配器的交互式入口（CLI、网页 composer） | `ctx.commands`；不需要 webServer，也不进模型上下文 |
| `tool_switch` 工具 | **任何入口，含 QQ / headless** | 只需要模型能调工具 |

```text
/tools                       看分组和当前开关
/tools off rea               关掉 rea 整组（也认 终端与执行 / mcp:rea / mcp__rea__* / 精确工具名 / all）
/tools on mcp__rea__         按前缀整片打开
/tools all off | all on      全关 / 全开（动词在前后都认）
/tools reset                 全部恢复
```

用户说「把 XX 类工具关掉」时，模型会调 `tool_switch`（`action: list|off|on|reset` + `target`）。
`tool_switch` 自己**永远不会被关掉**，所以即使 `all off` 也留着一条回来的路。

脚本/外部程序用 HTTP（挂在框架 `webServer` 上，只监听回环；`/api` 那套鉴权不覆盖它）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/tool-switch/state?session=<id>` | 工具目录 + 当前选择（分组、描述、是否可关闭） |
| `POST` | `/tool-switch/state` | body `{ session, disabled: [工具名…] }`，空数组=全部启用 |

## 原理

用的是框架自带的按 agent 遮罩：

```js
// 只有通过 agent 作用域上下文调用，遮罩才只作用于这个 agent
agent.ctx.tools.restrict({ allow: [...这个会话允许的工具名] })
```

- 遮罩同时作用于「提示词里的工具清单」「PTC 绑定」和「执行时的工具集合」——不是把 UI 藏起来，
  而是模型真的看不到、也调不到。
- 记的是**关闭集合**而不是开启集合：`allow = 可限制工具 − 关闭集合`，所以后来才连上的 MCP 工具默认可用，
  不会被悄悄吞掉。
- 监听 `agent/created` / `agent/disposed` / `tools/change`：新会话、工具集合变化（MCP 晚到、插件热插拔）
  自动重算；只有 allow 真的变了才重装，避免白白让提示词前缀失效。
- 卸载时撤掉自己装的所有遮罩（插件不在，就不该继续改会话能力）。

客户端半侧是手写的 bundle（`lib/client.js`，与官方插件产物同构的
`window.__ModuleLoader__.load({ id, factory })`），注册进 `conversation.composer.dock` 这个 slot。

## 安装

已在 npm 上：**`dsh-tool-switch@0.2.1`**（[npm](https://www.npmjs.com/package/dsh-tool-switch)）。

**① 插件页装（推荐）**：DSH 左侧栏 **插件 → 安装**，填 `dsh-tool-switch`（或本仓库地址、或本地目录的
绝对路径），确认后刷新页面。它会调用 pnpm，并把包记进 profile 的 `dsh.profile.bundles`。

**② 自己用包管理器装**：

```powershell
cd <PROFILE_DIR>                                   # …\harness\profiles\web
pnpm add dsh-tool-switch                           # 或 github:suqing114/dsh-tool-switch#v0.2.1
                                                   #    file:<本地 tgz>
                                                   #    link:<本地仓库目录>
# 再把 "dsh-tool-switch" 加进本目录 package.json 的 dsh.profile.bundles 数组
```

`pnpm add` 只负责把包放进 `node_modules`；profile 还得知道这个组合包要参与组合——**两步都要做**
（插件页替你做了第二步）。仓库自带的 `cordis.patch.yml` 负责把 Host 入口接进插件树。

**卸载**：插件页里取消选择 / 移除；或 `pnpm remove dsh-tool-switch` 并从 `dsh.profile.bundles` 删掉。
移除后刷新页面，按钮消失，装过的遮罩会一起撤销。

状态文件：`~/.dsh-tool-switch/state.json`，格式
`{ version, sessions: { "<sessionId>": { disabled: [...] } } }`；删掉它等于全部恢复「全开」。

## 装完怎么验

```powershell
# 1) Host 路由活着：200；不带 session 应 400；随便一个路径应 404
curl.exe "http://127.0.0.1:43129/tool-switch/state?session=test"
curl.exe "http://127.0.0.1:43129/tool-switch/state"

# 2) 客户端启动图里有这一行（bundle 也能取到）
node test\probe-client-graph.mjs
```

3. 页面里：输入框正下方那行最右端出现 `⚙ 工具`。看不到就先 Ctrl+R，再查下面常见问题。

## 常见问题

| 现象 | 处理 |
|---|---|
| `/tool-switch/state` 返回 **404** | 插件没被组合进来：确认它在 `dsh.profile.bundles` 里且已启用；看 `<HARNESS_DIR>\logs\harness.log` |
| 路由 200 但**没有按钮** | 客户端半侧没加载：Ctrl+R；再跑 `node test\probe-client-graph.mjs` 看启动图 |
| `resolves from multiple active Loader sources` | 同一份插件被两个来源解析到（装了两遍），删掉一处 |
| 改了代码没反应 | 客户端 bundle 按 mtime 热替换；Host 侧 `index.js` 需要重启 DSH 才重新导入 |
| 面板里有灰勾选的 `· 会话固定` | agent 作用域内注册的工具，框架规定 `tools.restrict` 管不到 |
| 想一次性恢复 | 面板点 `全开`，或删掉 `state.json` |

## 已知边界

- **agent 作用域里注册的工具关不掉**：框架规定「查看作用域自己的注册不受 restrict 影响」，这类工具标
  `· 会话固定` 且勾选框禁用（例如某些 preset 注册的 `ops_discover_tools`）。
- **只有按会话，没有全局默认**：新会话默认全开。
- **面板文案没走 i18n**：中文硬编码在 bundle 里。
- **HTTP 只监听回环、没有额外鉴权**：它只能改「本会话能用哪些工具」，不碰凭证、文件内容和执行权限。

## 开发

- `index.js` 是 Host 半侧（Cordis 插件，`inject: ['tools', 'agents']`），`lib/client.js` 是手写客户端 bundle，
  `cordis.patch.yml` 是组合包自带的补丁层（用包名挂载 Host 入口）。
- 自测脚本在 `test/`：`node test\test-host.mjs`（Host 逻辑，最小 ctx 桩）、`node test\test-client.mjs`
  （借 app 自带 React 做静态渲染）、`node test\test-usage.mjs`（调用次数统计：合成多帧 zstd 日志 + 缓存增量 +
  徽章/排序/展开说明，复用同一套 React，`DSH_APP` 指向任意装了 react 18 的 package.json 即可）、
  `node test/test-panel.mjs`（把面板真挂进 jsdom 后点一下按钮，断言面板和按钮都还在——纯函数测试抓不到
  「面板里少一个变量就让整块消失」这类崩）、
  `node test\probe-*.mjs`（打真实实例）。路径与端口由
  [test/paths.mjs](test/paths.mjs) 解析，可用 `DSH_APP` / `DSH_HARNESS` / `DSH_URL` / `SESSION` 覆盖。
