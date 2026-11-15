/**
 * dsh-cetwt 客户端半区。
 *
 * 形态与左侧「插件市场」「CET-6 工作台」一致：
 *   - 左侧栏图标（sidebar.panellist，order 43）→ 点开在主区打开工作台面板（main，key=dsh-cetwt）
 *   - 工作台里点「浮窗」→ 切换成可拖动 / 可缩放的浮窗（shell.overlay），边看对话边写译
 * 面板本体仍是 iframe（/cetwt/app/index.html），与 dsh-cet6 同一套做法。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cetwt',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useLayoutEffect, useRef, useState } = React

    const PANEL_ID = 'dsh-cetwt'
    const TITLE = '四六级写译'
    const FRAME_SRC = '/cetwt/app/index.html'
    const BG = 'var(--dsw-alias-bg-base, #fff)'
    const WIN_KEY = 'dsh-cetwt:win'
    const GAP = 8
    const MIN_W = 340
    const MIN_H = 380

    /** 由 apply() 注入，供面板内按钮回到对话 */
    let layoutService = null
    /** 浮窗组件的 open 句柄，供工作台「浮窗」按钮调用 */
    let openPopup = null

    /* ───────────── 左侧栏图标 ───────────── */

    function CetwtIcon(props) {
      const size = props && props.size ? props.size : 18
      return h(
        'span',
        {
          'data-dsh-plugin': PANEL_ID,
          'data-dsh-part': 'sidebar-icon',
          style: { display: 'inline-flex' },
        },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
          h('path', {
            d: 'M4.5 3.5h15a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z',
            opacity: 0.42,
          }),
          h('path', { d: 'M8.2 16.4 12 7.6l3.8 8.8' }),
          h('path', { d: 'M9.7 13.3h4.6' }),
        ),
      )
    }

    /* ───────────── 主区工作台（与 CET-6 工作台同形态） ───────────── */

    function Workbench() {
      const boxRef = useRef(null)
      const frameRef = useRef(null)
      const [fallbackHeight, setFallbackHeight] = useState(0)

      // flex 撑不起来时按视口兜底（与 dsh-cet6 相同策略）
      useLayoutEffect(() => {
        const el = boxRef.current
        if (!el) return undefined
        let frame = 0
        const measure = () => {
          const rect = el.getBoundingClientRect()
          const iframe = el.firstElementChild
          const filled = iframe ? iframe.clientHeight : 0
          if (filled > 200) {
            setFallbackHeight((prev) => (prev === 0 ? prev : 0))
            return
          }
          const available = Math.max(320, Math.floor(window.innerHeight - rect.top - 2))
          setFallbackHeight((prev) => (Math.abs(prev - available) > 2 ? available : prev))
        }
        const schedule = () => {
          if (frame) cancelAnimationFrame(frame)
          frame = requestAnimationFrame(measure)
        }
        schedule()
        const timers = [window.setTimeout(measure, 120), window.setTimeout(measure, 480)]
        window.addEventListener('resize', schedule)
        let observer = null
        if (typeof ResizeObserver !== 'undefined' && el.parentElement) {
          observer = new ResizeObserver(schedule)
          observer.observe(el.parentElement)
        }
        return () => {
          if (frame) cancelAnimationFrame(frame)
          timers.forEach((timer) => window.clearTimeout(timer))
          window.removeEventListener('resize', schedule)
          if (observer) observer.disconnect()
        }
      }, [])

      // 面板内「收起」→ 回对话；「浮窗」→ 换成浮窗
      useEffect(() => {
        const onMessage = (event) => {
          const data = event?.data
          if (!data || typeof data !== 'object') return
          if (frameRef.current && event.source !== frameRef.current.contentWindow) return
          if (data.type === 'cetwt:minimize') {
            try {
              layoutService?.selectPanel?.(null)
            } catch {
              /* ignore */
            }
            return
          }
          if (data.type === 'cetwt:float') {
            openPopup?.()
            try {
              layoutService?.selectPanel?.(null)
            } catch {
              /* ignore */
            }
          }
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])

      return h(
        'div',
        {
          ref: boxRef,
          className: 'cetwt-work',
          'data-dsh-plugin': PANEL_ID,
          'data-dsh-part': 'panel',
          // 内联样式兜底：即使 <style> 还没注入，iframe 也不会缩成默认 300×150
          style: {
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            height: fallbackHeight ? `${fallbackHeight}px` : '100%',
            minHeight: 0,
            overflow: 'hidden',
            boxSizing: 'border-box',
            background: BG,
            paddingTop: 'var(--dsh-frame-top-clearance, 0px)',
          },
        },
        h(StyleOnce),
        h('iframe', {
          ref: frameRef,
          className: 'cetwt-work-frame',
          src: FRAME_SRC,
          title: TITLE,
          allow: 'clipboard-write',
          style: {
            flex: '1 1 auto',
            width: '100%',
            height: '100%',
            minHeight: 0,
            border: 0,
            display: 'block',
            background: '#fff',
          },
        }),
      )
    }

    /* ───────────── 浮窗（可移动 / 可缩放） ───────────── */

    function readWin() {
      try {
        const raw = window.localStorage.getItem(WIN_KEY)
        if (!raw) return null
        const value = JSON.parse(raw)
        return value && typeof value === 'object' ? value : null
      } catch {
        return null
      }
    }

    function writeWin(value) {
      try {
        window.localStorage.setItem(WIN_KEY, JSON.stringify(value))
      } catch {
        /* ignore */
      }
    }

    function viewport() {
      return {
        w: window.innerWidth || 1440,
        h: window.innerHeight || 900,
      }
    }

    function clampBox(left, top, w, hgt) {
      const { w: vw, h: vh } = viewport()
      const width = Math.min(Math.max(MIN_W, Math.round(w || 452)), Math.max(MIN_W, vw - 24))
      const height = Math.min(Math.max(MIN_H, Math.round(hgt || 620)), Math.max(MIN_H, vh - 40))
      const maxLeft = Math.max(8, vw - width - 8)
      const maxTop = Math.max(8, vh - 60)
      return {
        left: Math.min(Math.max(-width + 120, Math.round(left)), maxLeft),
        top: Math.min(Math.max(0, Math.round(top)), maxTop),
        w: width,
        h: height,
      }
    }

    function measureSidebarWidth(node) {
      const layer = node?.closest?.('[data-shell-overlay]')
      const frame = layer?.parentElement
      const first = frame?.firstElementChild
      const width = first ? first.getBoundingClientRect().width : 0
      return Number.isFinite(width) && width > 0 ? Math.round(width) : 0
    }

    function defaultBox(sidebar) {
      const { h: vh } = viewport()
      return clampBox(sidebar + 16, 64, 452, Math.round(Math.min(880, vh * 0.86)))
    }

    function FloatPopup() {
      const layerRef = useRef(null)
      const popRef = useRef(null)
      const frameRef = useRef(null)
      const dragRef = useRef(null)
      const resizeRef = useRef(null)

      const saved = useRef(readWin())
      const [open, setOpen] = useState(() => saved.current?.open === true)
      const [pos, setPos] = useState(() => ({
        left: typeof saved.current?.left === 'number' ? saved.current.left : null,
        top: typeof saved.current?.top === 'number' ? saved.current.top : null,
        w: typeof saved.current?.w === 'number' ? saved.current.w : 452,
        h: typeof saved.current?.h === 'number' ? saved.current.h : null,
      }))
      const [sidebar, setSidebar] = useState(240)
      const [dragging, setDragging] = useState(false)

      // 供工作台按钮唤起
      useEffect(() => {
        openPopup = () => {
          setPos((prev) => {
            if (prev.left != null && prev.top != null) {
              const next = clampBox(prev.left, prev.top, prev.w, prev.h ?? Math.round(viewport().h * 0.86))
              return { ...prev, ...next }
            }
            return defaultBox(sidebar)
          })
          setOpen(true)
        }
        return () => {
          openPopup = null
        }
      }, [sidebar])

      // 跟随侧边栏宽度
      useEffect(() => {
        const node = layerRef.current
        if (!node) return undefined
        const sync = () => setSidebar(measureSidebarWidth(node))
        sync()
        const layer = node.closest('[data-shell-overlay]')
        const frame = layer?.parentElement
        const target = frame?.firstElementChild ?? frame ?? document.body
        const observer = new ResizeObserver(sync)
        observer.observe(target)
        window.addEventListener('resize', sync)
        const timer = window.setTimeout(sync, 400)
        return () => {
          observer.disconnect()
          window.removeEventListener('resize', sync)
          window.clearTimeout(timer)
        }
      }, [])

      useEffect(() => {
        const onResize = () => {
          setPos((prev) => {
            if (prev.left == null || prev.top == null) return prev
            const next = clampBox(prev.left, prev.top, prev.w, prev.h)
            return { ...prev, left: next.left, top: next.top, w: next.w, h: next.h }
          })
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      useEffect(() => {
        writeWin({ open, left: pos.left, top: pos.top, w: pos.w, h: pos.h })
      }, [open, pos])

      // 面板内「收起」→ 关闭浮窗
      useEffect(() => {
        const onMessage = (event) => {
          const data = event?.data
          if (!data || typeof data !== 'object') return
          if (data.type !== 'cetwt:minimize') return
          if (frameRef.current && event.source !== frameRef.current.contentWindow) return
          setOpen(false)
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])

      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const box = clampBox(
        pos.left == null ? sidebar + 16 : pos.left,
        pos.top == null ? 64 : pos.top,
        pos.w,
        pos.h ?? Math.round(Math.min(880, viewport().h * 0.86)),
      )

      const place = () => setPos(defaultBox(sidebar))

      const onHeadDown = (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        if (event.target?.closest?.('button')) return
        const rect = popRef.current?.getBoundingClientRect()
        if (!rect) return
        dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
        setDragging(true)
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* ignore */
        }
      }

      const onHeadMove = (event) => {
        const drag = dragRef.current
        if (!drag) return
        const next = clampBox(event.clientX - drag.dx, event.clientY - drag.dy, pos.w, pos.h ?? box.h)
        setPos((prev) => ({ ...prev, left: next.left, top: next.top }))
      }

      const onHeadUp = (event) => {
        if (!dragRef.current) return
        dragRef.current = null
        setDragging(false)
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch {
          /* ignore */
        }
      }

      const onGripDown = (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        event.stopPropagation()
        resizeRef.current = { x: event.clientX, y: event.clientY, w: box.w, h: box.h }
        setDragging(true)
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* ignore */
        }
      }

      const onGripMove = (event) => {
        const start = resizeRef.current
        if (!start) return
        const next = clampBox(
          pos.left ?? box.left,
          pos.top ?? box.top,
          start.w + (event.clientX - start.x),
          start.h + (event.clientY - start.y),
        )
        setPos((prev) => ({ ...prev, w: next.w, h: next.h }))
      }

      const onGripUp = (event) => {
        if (!resizeRef.current) return
        resizeRef.current = null
        setDragging(false)
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch {
          /* ignore */
        }
      }

      return h(
        'div',
        { ref: layerRef, className: 'cetwt-layer', 'data-cetwt-layer': '' },
        open
          ? h(
              'div',
              {
                ref: popRef,
                className: `cetwt-pop${dragging ? ' is-dragging' : ''}`,
                style: { left: `${box.left}px`, top: `${box.top}px`, width: `${box.w}px`, height: `${box.h}px` },
                'data-cetwt-pop': 'open',
              },
              h(
                'div',
                {
                  className: 'cetwt-pop-head',
                  onPointerDown: onHeadDown,
                  onPointerMove: onHeadMove,
                  onPointerUp: onHeadUp,
                  onPointerCancel: onHeadUp,
                  title: '按住拖动可移动窗口',
                },
                h('span', { className: 'cetwt-pop-title' }, '四六级写译训练'),
                h('span', { className: 'cetwt-pop-grip' }, '拖动移动'),
                h('span', { className: 'cetwt-pop-spacer' }),
                h(
                  'button',
                  { type: 'button', className: 'cetwt-icon-btn', onClick: place, title: '复位位置' },
                  '⟲',
                ),
                h(
                  'button',
                  { type: 'button', className: 'cetwt-icon-btn', onClick: () => setOpen(false), title: '收起（Esc）' },
                  '×',
                ),
              ),
              h(
                'div',
                { className: 'cetwt-pop-body' },
                h('iframe', {
                  ref: frameRef,
                  className: 'cetwt-frame',
                  src: FRAME_SRC,
                  title: TITLE,
                  allow: 'clipboard-write',
                }),
                h('div', {
                  className: 'cetwt-pop-grip-corner',
                  onPointerDown: onGripDown,
                  onPointerMove: onGripMove,
                  onPointerUp: onGripUp,
                  onPointerCancel: onGripUp,
                  title: '拖动调整大小',
                }),
              ),
            )
          : null,
      )
    }

    /* ───────────── 样式 ───────────── */

    const CSS = `
/* 主区工作台：与 CET-6 工作台同样是整块 iframe，顶部让开窗口 chrome */
.cetwt-work{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;
  box-sizing:border-box;padding-top:var(--dsh-frame-top-clearance,0px);background:${BG}}
.cetwt-work-frame{flex:1 1 auto;width:100%;height:100%;min-height:0;border:0;display:block;background:#fff}

/* 浮窗 */
.cetwt-layer{position:fixed;inset:0;z-index:70;pointer-events:none}
.cetwt-layer > *{pointer-events:auto}
.cetwt-pop{position:fixed;display:flex;flex-direction:column;overflow:hidden;border-radius:14px;
  background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,#e6e9ef);
  box-shadow:0 18px 48px rgba(16,24,40,.20),0 2px 8px rgba(16,24,40,.08);pointer-events:auto;
  animation:cetwt-pop-in .16s ease-out}
@keyframes cetwt-pop-in{from{opacity:0;transform:translateY(6px) scale(.994)}to{opacity:1;transform:none}}
.cetwt-pop.is-dragging{animation:none;box-shadow:0 24px 60px rgba(16,24,40,.26);transition:none}
.cetwt-pop-head{display:flex;align-items:center;gap:8px;height:38px;padding:0 6px 0 12px;flex:0 0 auto;
  background:linear-gradient(180deg,var(--dsw-alias-bg-layer-1,#f7f8fa),var(--dsw-alias-bg-base,#fff));
  border-bottom:1px solid var(--dsw-alias-border-l1,#e6e9ef);cursor:grab;user-select:none;touch-action:none}
.cetwt-pop.is-dragging .cetwt-pop-head{cursor:grabbing}
.cetwt-pop-title{font:600 13px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary,#2b2f36);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cetwt-pop-grip{color:var(--dsw-alias-label-tertiary,#98a2b3);font-size:11px;letter-spacing:.06em;white-space:nowrap}
.cetwt-pop-spacer{flex:1}
.cetwt-icon-btn{width:26px;height:26px;display:flex;align-items:center;justify-content:center;border:0;border-radius:7px;
  background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;font:500 15px/1 system-ui,sans-serif}
.cetwt-icon-btn:hover{background:var(--dsw-alias-bg-layer-2,#eef1f6);color:var(--dsw-alias-label-primary,#2b2f36)}
.cetwt-pop-body{position:relative;flex:1;min-height:0;background:#fff}
.cetwt-pop-body iframe{display:block;width:100%;height:100%;border:0;background:#fff}
.cetwt-pop-grip-corner{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;touch-action:none;
  background:linear-gradient(135deg,transparent 50%,var(--dsw-alias-border-l2,#d5dbe5) 50%,var(--dsw-alias-border-l2,#d5dbe5) 62%,transparent 62%)}
@media (max-width:760px){.cetwt-pop-grip{display:none}}
`

    function StyleOnce() {
      useEffect(() => {
        const id = 'dsh-cetwt-style'
        if (document.getElementById(id)) return
        const style = document.createElement('style')
        style.id = id
        style.textContent = CSS
        document.head.appendChild(style)
      }, [])
      return null
    }

    function Overlay() {
      return h(React.Fragment, null, h(StyleOnce), h(FloatPopup))
    }

    /* ───────────── 注册 ───────────── */

    const module = { exports: {} }
    module.exports.name = PANEL_ID
    module.exports.inject = ['slots', 'layout']

    module.exports.apply = function apply(ctx) {
      layoutService = ctx.layout ?? null

      // 主区工作台：面板本体
      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              { name: 'main', key: PANEL_ID, label: () => TITLE },
              Workbench,
            ),
          ),
        'cetwt: 主区工作台面板',
      )

      // 左侧栏图标：与插件市场 / CET-6 工作台同一位置、同一观感
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 43, label: () => TITLE },
              CetwtIcon,
            ),
          ),
        'cetwt: 左侧栏图标',
      )

      // 浮层：可移动浮窗（工作台里点「浮窗」时才出现）
      ctx.effect(
        () =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: PANEL_ID, order: 60, label: () => TITLE },
              Overlay,
            ),
          ),
        'cetwt: 可移动浮窗',
      )
    }
    return module.exports
  },
})
