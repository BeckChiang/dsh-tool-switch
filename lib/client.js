// dsh-tool-switch — 会话级工具可见性开关（浏览器半侧）
//
// 这是一个手写的 DSH 客户端 bundle：协议是「用 window.__ModuleLoader__.load
// 注册一个 factory，factory 收到同步 require，返回 { apply, inject }」。
// 与官方插件产物同构，不需要构建步骤。
//
// 挂载点：`conversation.composer.dock` —— 输入框卡片正下方的那一条（上下文用量
// 指示器也在那里），所以按钮就长在对话框下面。
//
// 数据面：同源 fetch 到 Host 半侧注册的 /tool-switch/state。

window.__ModuleLoader__.load({
  id: 'dsh-tool-switch',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createPortal } = require('react-dom')

    const h = React.createElement

    /** Host 半侧注册的同源路由。 */
    const ROUTE = '/tool-switch/state'

    const COLOR = {
      text: 'var(--dsw-alias-label-primary, #e6e6e6)',
      secondary: 'var(--dsw-alias-label-secondary, #b4b4b4)',
      caption: 'var(--dsw-alias-label-caption, #8b8b8b)',
      border: 'var(--dsw-alias-border-l2, #3a3a3a)',
      panel: 'var(--dsw-specific-input-major, #1e1e1e)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))',
      accent: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
      radius: 'var(--dsw-radius-panel, 16px)',
    }

    // ---------------------------------------------------------------------
    // 网络
    // ---------------------------------------------------------------------

    async function requestState(sessionId) {
      const response = await fetch(`${ROUTE}?session=${encodeURIComponent(sessionId)}`, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    async function saveState(sessionId, disabled) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ session: sessionId, disabled }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    // ---------------------------------------------------------------------
    // 小组件
    // ---------------------------------------------------------------------

    function SlidersIcon({ size = 14 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M2 4.5h5M11 4.5h3M2 11.5h3M9 11.5h5', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('circle', { cx: 9, cy: 4.5, r: 1.6, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('circle', { cx: 7, cy: 11.5, r: 1.6, stroke: 'currentColor', strokeWidth: 1.3 }),
      )
    }

    function CheckMark({ checked, locked }) {
      return h(
        'span',
        {
          'aria-hidden': true,
          style: {
            width: 16,
            height: 16,
            flex: 'none',
            borderRadius: 4,
            border: `1px solid ${checked ? COLOR.accent : COLOR.border}`,
            background: checked ? COLOR.accent : 'transparent',
            opacity: locked ? 0.45 : 1,
            display: 'grid',
            placeItems: 'center',
            transition: 'background .12s, border-color .12s',
          },
        },
        checked
          ? h('svg', { width: 11, height: 11, viewBox: '0 0 12 12', fill: 'none' }, h('path', { d: 'M2.5 6.2 4.8 8.5 9.5 3.8', stroke: '#fff', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }))
          : null,
      )
    }

    function minimalButtonStyle(extra) {
      return Object.assign(
        {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          height: 24,
          padding: '0 8px',
          border: 'none',
          borderRadius: 999,
          background: 'transparent',
          color: COLOR.caption,
          font: 'inherit',
          fontSize: 12,
          lineHeight: '18px',
          cursor: 'pointer',
        },
        extra || {},
      )
    }

    /** 分组标题行上「全关 / 全开」这种一键按钮的样式；不可用时置灰。 */
    function groupActionStyle(active) {
      return minimalButtonStyle({
        height: 18,
        padding: '0 6px',
        borderRadius: 6,
        fontSize: 11,
        color: active ? COLOR.secondary : COLOR.caption,
        background: active ? 'color-mix(in srgb, currentColor 10%, transparent)' : 'transparent',
        opacity: active ? 1 : 0.4,
        cursor: active ? 'pointer' : 'default',
      })
    }

    function ActionButton({ children, onClick, disabled, title }) {
      const [hover, setHover] = React.useState(false)
      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled,
          title,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: minimalButtonStyle({
            color: disabled ? COLOR.caption : COLOR.secondary,
            background: hover && !disabled ? COLOR.hover : 'transparent',
            opacity: disabled ? 0.5 : 1,
            cursor: disabled ? 'default' : 'pointer',
          }),
        },
        children,
      )
    }

    // ---------------------------------------------------------------------
    // 工具树：给定 state 直接产出元素（纯函数，便于离线验证）
    // ---------------------------------------------------------------------

    function filterGroups(groups, needle) {
      if (needle.length === 0) return groups
      const result = []
      for (const group of groups) {
        const tools = group.tools.filter(
          (tool) =>
            tool.name.toLowerCase().includes(needle) ||
            tool.label.toLowerCase().includes(needle) ||
            (tool.description ?? '').toLowerCase().includes(needle),
        )
        if (tools.length > 0) result.push(Object.assign({}, group, { tools }))
      }
      return result
    }

    function renderToolTree({ state, needle, expanded, setExpanded, toggleGroup, toggleTool }) {
      const visibleGroups = filterGroups(state?.groups ?? [], needle)
      if (visibleGroups.length === 0) {
        return [h('div', { key: 'empty', style: { padding: '18px 14px', color: COLOR.caption, fontSize: 12 } }, '没有匹配的工具')]
      }

      const children = []
      for (const group of visibleGroups) {
        const closeable = group.tools.filter((tool) => !tool.locked)
        const offCount = closeable.filter((tool) => !tool.enabled).length
        const allEnabled = offCount === 0
        // 默认全部收起：只有用户手动展开的组、或者正在搜索时才铺开。
        const isOpen = needle.length > 0 || expanded[group.id] === true

        children.push(
          h(
            'div',
            {
              key: `g:${group.id}`,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px 4px',
                position: 'sticky',
                top: 0,
                background: COLOR.panel,
                borderTop: `1px solid ${COLOR.border}`,
              },
            },
            h(
              'button',
              {
                type: 'button',
                'data-group-id': group.id,
                'data-group-action': 'toggle',
                title: isOpen ? '收起这一组' : `展开这一组（${group.tools.length} 个）`,
                onClick: () =>
                  setExpanded((previous) => Object.assign({}, previous, { [group.id]: !isOpen })),
                style: minimalButtonStyle({ width: 18, height: 18, padding: 0, justifyContent: 'center' }),
              },
              isOpen ? '▾' : '▸',
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: () => toggleGroup(group, !allEnabled),
                disabled: closeable.length === 0,
                title: allEnabled ? '关闭本组' : '启用本组',
                style: minimalButtonStyle({ color: COLOR.secondary, fontSize: 12, fontWeight: 600, padding: '0 2px' }),
              },
              group.label,
            ),
            h(
              'span',
              { style: { color: COLOR.caption, fontSize: 11 } },
              `${group.tools.length - offCount}/${group.tools.length}`,
            ),
            h('span', { style: { flex: 1 } }),
            // 一键开关整组：全关 关掉这一组下所有可关闭的工具，全开 反过来。
            // 已经是目标状态的那个按钮置灰，避免看起来像还能再点。
            h(
              'button',
              {
                type: 'button',
                'data-group-id': group.id,
                'data-group-action': 'off',
                onClick: () => toggleGroup(group, false),
                disabled: closeable.length === 0 || offCount === closeable.length,
                title:
                  closeable.length === 0
                    ? '这一组的工具都由会话作用域固定，关不掉'
                    : `一键关闭「${group.label}」下的 ${closeable.length} 个工具`,
                style: groupActionStyle(closeable.length > 0 && offCount < closeable.length),
              },
              '全关',
            ),
            h(
              'button',
              {
                type: 'button',
                'data-group-id': group.id,
                'data-group-action': 'on',
                onClick: () => toggleGroup(group, true),
                disabled: closeable.length === 0 || allEnabled,
                title: `一键启用「${group.label}」下全部工具`,
                style: groupActionStyle(closeable.length > 0 && !allEnabled),
              },
              '全开',
            ),
          ),
        )

        if (!isOpen) continue

        for (const tool of group.tools) {
          children.push(
            h(
              'label',
              {
                key: `t:${tool.name}`,
                title: tool.description || tool.name,
                style: {
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '5px 12px 5px 30px',
                  cursor: tool.locked ? 'default' : 'pointer',
                  opacity: tool.enabled ? 1 : 0.55,
                },
              },
              h(CheckMark, { checked: tool.enabled, locked: tool.locked }),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 } },
                h(
                  'span',
                  {
                    style: {
                      color: tool.locked ? COLOR.caption : COLOR.text,
                      fontSize: 12,
                      lineHeight: '17px',
                      fontFamily: 'var(--dsw-font-mono, ui-monospace, Menlo, Consolas, monospace)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                  },
                  tool.label + (tool.locked ? ' · 会话固定' : ''),
                ),
                tool.description.length > 0
                  ? h(
                      'span',
                      {
                        style: {
                          color: COLOR.caption,
                          fontSize: 11,
                          lineHeight: '15px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        },
                      },
                      tool.description,
                    )
                  : null,
              ),
              h('input', {
                type: 'checkbox',
                checked: tool.enabled,
                disabled: tool.locked,
                onChange: (event) => toggleTool(tool.name, event.target.checked),
                style: { display: 'none' },
              }),
            ),
          )
        }
      }
      return children
    }

    // ---------------------------------------------------------------------
    // 面板
    // ---------------------------------------------------------------------

    function ToolPanel({ sessionId, anchor, onClose, onModeChange }) {
      const [state, setState] = React.useState(null)
      const [phase, setPhase] = React.useState('loading')
      const [error, setError] = React.useState('')
      const [query, setQuery] = React.useState('')
      // 展开状态（默认全收起）：{ [groupId]: true } 表示这一组被手动展开。
      const [expanded, setExpanded] = React.useState({})
      const chain = React.useRef(Promise.resolve())

      const disabledSet = React.useMemo(() => new Set(state?.disabled ?? []), [state])

      // 切换会话（或重新打开面板）时回到「全收起」。
      React.useEffect(() => {
        setExpanded({})
        setQuery('')
      }, [sessionId])

      React.useEffect(() => {
        let cancelled = false
        setPhase('loading')
        requestState(sessionId)
          .then((next) => {
            if (cancelled) return
            setState(next)
            setPhase('ready')
            setError('')
          })
          .catch((cause) => {
            if (cancelled) return
            setPhase('error')
            setError(String(cause?.message ?? cause))
          })
        return () => {
          cancelled = true
        }
      }, [sessionId])

      const commit = React.useCallback(
        (nextDisabled) => {
          const list = [...new Set(nextDisabled)].sort()
          // 先本地生效（点击即反馈），再按顺序落到 Host
          setState((previous) =>
            previous === null
              ? previous
              : Object.assign({}, previous, { disabled: list, mode: list.length === 0 ? 'all' : 'custom' }),
          )
          chain.current = chain.current
            .then(() => saveState(sessionId, list))
            .then((next) => {
              if (next && next.ok) {
                setState(next)
                setPhase('ready')
                setError('')
                onModeChange?.(next.mode, next.counts)
              }
            })
            .catch((cause) => {
              setError(String(cause?.message ?? cause))
            })
        },
        [sessionId, onModeChange],
      )

      const toggleTool = React.useCallback(
        (name, nextEnabled) => {
          const next = new Set(disabledSet)
          if (nextEnabled) next.delete(name)
          else next.add(name)
          commit([...next])
        },
        [commit, disabledSet],
      )

      const toggleGroup = React.useCallback(
        (group, nextEnabled) => {
          const next = new Set(disabledSet)
          for (const tool of group.tools) {
            if (tool.locked) continue
            if (nextEnabled) next.delete(tool.name)
            else next.add(tool.name)
          }
          commit([...next])
        },
        [commit, disabledSet],
      )

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [onClose])

      const width = 396
      const left = anchor === null ? 12 : Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))
      const bottom = anchor === null ? 96 : Math.max(12, window.innerHeight - anchor.top + 10)

      const groups = state?.groups ?? []
      const needle = query.trim().toLowerCase()

      const enabledCount = state?.counts?.enabled ?? 0
      const totalCount = state?.counts?.total ?? 0
      const allOff = totalCount > 0 && enabledCount === 0

      const header = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px 8px' } },
        h('span', { style: { color: COLOR.text, fontSize: 13, fontWeight: 600 } }, '本会话可用工具'),
        h(
          'span',
          { style: { color: COLOR.caption, fontSize: 12 } },
          `${enabledCount}/${totalCount}`,
        ),
        h('span', { style: { flex: 1 } }),
        h(
          'button',
          {
            type: 'button',
            onClick: onClose,
            title: '关闭 (Esc)',
            style: minimalButtonStyle({ color: COLOR.caption, fontSize: 16, height: 20, padding: '0 6px' }),
          },
          '×',
        ),
      )

      const toolbar = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px 8px', flexWrap: 'wrap' } },
        h(
          'input',
          {
            value: query,
            onChange: (event) => setQuery(event.target.value),
            placeholder: '搜索工具…',
            spellCheck: false,
            style: {
              flex: '1 1 130px',
              minWidth: 120,
              height: 26,
              padding: '0 8px',
              borderRadius: 8,
              border: `1px solid ${COLOR.border}`,
              background: 'transparent',
              color: COLOR.text,
              font: 'inherit',
              fontSize: 12,
              outline: 'none',
            },
          },
        ),
        h(
          ActionButton,
          {
            onClick: () => setExpanded(Object.fromEntries(groups.map((group) => [group.id, true]))),
            disabled: groups.length === 0,
            title: '展开所有分组（只影响显示，不动工具开关）',
          },
          '展开',
        ),
        h(
          ActionButton,
          {
            onClick: () => setExpanded({}),
            disabled: groups.length === 0,
            title: '收起所有分组',
          },
          '收起',
        ),
        h('span', {
          'aria-hidden': true,
          style: { width: 1, height: 14, background: COLOR.border, margin: '0 2px' },
        }),
        h(ActionButton, { onClick: () => commit([]), disabled: state === null || (state.disabled ?? []).length === 0, title: '启用所有工具' }, '全开'),
        h(
          ActionButton,
          {
            onClick: () => {
              const next = []
              for (const group of groups) for (const tool of group.tools) if (!tool.locked) next.push(tool.name)
              commit(next)
            },
            disabled: state === null || allOff,
            title: '关闭所有可关闭的工具',
          },
          '全关',
        ),
      )

      const bodyChildren =
        phase === 'loading' && state === null
          ? [h('div', { key: 'loading', style: { padding: '18px 14px', color: COLOR.caption, fontSize: 12 } }, '读取工具列表…')]
          : phase === 'error' && state === null
            ? [
                h('div', { key: 'error', style: { padding: '18px 14px', color: COLOR.caption, fontSize: 12, lineHeight: '18px' } }, [
                  h('div', { key: 'message' }, '无法连接到 Host 侧：', String(error || '未知错误')),
                  h(
                    'div',
                    { key: 'hint', style: { marginTop: 6 } },
                    '确认 dsh-tool-switch 主机插件已启用（设置 → 插件），然后刷新页面。',
                  ),
                ]),
              ]
            : renderToolTree({ state, needle, expanded, setExpanded, toggleGroup, toggleTool })

      const footer = h(
        'div',
        {
          style: {
            borderTop: `1px solid ${COLOR.border}`,
            padding: '8px 14px 10px',
            color: COLOR.caption,
            fontSize: 11,
            lineHeight: '16px',
          },
        },
        error.length > 0
          ? h('div', { style: { color: 'var(--dsw-alias-state-warning-primary, #f0a020)' } }, `保存失败：${error}`)
          : h(
              'div',
              null,
              state?.live === false
                ? '该会话当前没有运行中的 Agent：改动会在下次开始时生效。'
                : '改动从下一条消息开始生效；被关闭的工具模型既看不到也调用不了。',
            ),
        state?.missing?.length > 0 ? h('div', { style: { marginTop: 4 } }, `注意：${state.missing.length} 个已关闭的工具已不存在。`) : null,
      )

      return createPortal(
        h(
          React.Fragment,
          null,
          h('div', {
            onClick: onClose,
            style: { position: 'fixed', inset: 0, zIndex: 2147483000, background: 'transparent' },
          }),
          h(
            'div',
            {
              role: 'dialog',
              'aria-label': '本会话可用工具',
              style: {
                position: 'fixed',
                left,
                bottom,
                width,
                maxWidth: `calc(100vw - 24px)`,
                maxHeight: 'min(62vh, 560px)',
                display: 'flex',
                flexDirection: 'column',
                zIndex: 2147483001,
                background: COLOR.panel,
                color: COLOR.text,
                border: `1px solid ${COLOR.border}`,
                borderRadius: COLOR.radius,
                boxShadow: 'var(--dsw-elevation-soft, 0 12px 32px rgba(0,0,0,.35))',
                overflow: 'hidden',
                font: 'inherit',
              },
            },
            header,
            toolbar,
            h('div', { style: { overflowY: 'auto', flex: 1, paddingBottom: 6 } }, bodyChildren),
            footer,
          ),
        ),
        document.body,
      )
    }

    // ---------------------------------------------------------------------
    // 输入框下方的按钮
    // ---------------------------------------------------------------------

    function ToolSwitchButton(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined
      const [open, setOpen] = React.useState(false)
      const [hover, setHover] = React.useState(false)
      const [summary, setSummary] = React.useState(null)
      const anchorRef = React.useRef(null)
      const [anchor, setAnchor] = React.useState(null)

      const refreshSummary = React.useCallback(() => {
        if (sessionId === undefined) return
        requestState(sessionId)
          .then((next) => setSummary(next?.ok ? { mode: next.mode, counts: next.counts } : null))
          .catch(() => setSummary(null))
      }, [sessionId])

      React.useEffect(() => {
        refreshSummary()
      }, [refreshSummary])

      const openPanel = React.useCallback(() => {
        const rect = anchorRef.current?.getBoundingClientRect()
        setAnchor(rect === undefined ? null : { left: rect.left, top: rect.top })
        setOpen(true)
        refreshSummary()
      }, [refreshSummary])

      if (sessionId === undefined) return null

      const custom = summary?.mode === 'custom'
      const offCount = custom ? summary?.counts?.disabled ?? 0 : 0
      const label = '工具'

      const button = h(
        'button',
        {
          ref: anchorRef,
          type: 'button',
          onClick: () => (open ? setOpen(false) : openPanel()),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          title: custom
            ? `本会话已关闭 ${offCount} 个工具（点开调整）`
            : '选择本会话里模型可用的工具',
          'aria-label': custom ? `工具开关：已关闭 ${offCount} 个` : '工具开关',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          style: minimalButtonStyle({
            height: 24,
            gap: 6,
            padding: '0 10px 0 8px',
            fontWeight: 500,
            color: custom ? COLOR.accent : COLOR.secondary,
            background: custom
              ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 16%, transparent)'
              : hover || open
                ? COLOR.hover
                : 'color-mix(in srgb, currentColor 8%, transparent)',
            border: `1px solid ${custom ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 45%, transparent)' : COLOR.border}`,
          }),
        },
        h(SlidersIcon, { size: 14 }),
        h('span', null, label),
        custom
          ? h(
              'span',
              {
                style: {
                  minWidth: 16,
                  height: 16,
                  padding: '0 4px',
                  borderRadius: 999,
                  background: COLOR.accent,
                  color: '#fff',
                  fontSize: 10,
                  lineHeight: '16px',
                  textAlign: 'center',
                  fontWeight: 600,
                },
              },
              String(offCount),
            )
          : null,
      )

      return h(
        React.Fragment,
        null,
        button,
        open
          ? h(ToolPanel, {
              sessionId,
              anchor,
              onClose: () => {
                setOpen(false)
                refreshSummary()
              },
              onModeChange: (mode, counts) => setSummary({ mode, counts }),
            })
          : null,
      )
    }

    /** hover 时把说明文字提亮一点，面板标题固定用强调色。 */

    // ---------------------------------------------------------------------
    // 插件主体
    // ---------------------------------------------------------------------

    /** 需要的客户端服务：只有 slot 注册表。 */
    const inject = ['slots']

    function apply(ctx) {
      // 槽位声明可能晚于本插件加载，ctx.slots.inject 会等到声明就绪再注册。
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'tool-switch',
            order: 40,
            inject: (sessionId) => ({ sessionId }),
          },
          ToolSwitchButton,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    // 仅离线测试用（Host 侧 bundle loader 只用 apply / inject）：
    exports.__internals = { renderToolTree, filterGroups, ToolPanel, ToolSwitchButton }
    return module.exports
  },
})
