/**
 * 客户端模块自检（不启动 DSH）：用最小 React / slots 桩验证
 *   - lib/client.js 能被 window.__ModuleLoader__ 加载，导出 name / inject / apply
 *   - apply(ctx) 注册三处：main（工作台面板）、sidebar.panellist（左侧栏图标）、shell.overlay（浮窗）
 *   - 图标是 24 viewBox 的描边 svg，尺寸跟随 props.size
 *   - 工作台渲染 div.cetwt-work > iframe(/cetwt/app/index.html)
 *   - 浮窗记住位置 / 尺寸，标题栏拖动与右下角缩放的处理器都在
 *   node build/test-client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ── 最小 React 桩 ── */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Fragment: Symbol.for('react.fragment'),
  useRef: (v) => ({ current: v }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useLayoutEffect: () => {},
  useEffect: () => {},
}

/* ── 最小 slots / layout 服务桩 ── */
const registered = []
const effects = []
const ctx = {
  slots: {
    inject(name, fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {
        const i = registered.findIndex((r) => r.options === options)
        if (i >= 0) registered.splice(i, 1)
      }
    },
  },
  effect(fn, label) {
    effects.push(label)
    return fn()
  },
  layout: { selectPanel: () => {} },
}

/* ── 加载客户端模块 ── */
let stored = null
let factory
const sandbox = {
  __ModuleLoader__: { load: ({ id, factory: f }) => ((factory = f), (sandbox.loadedId = id)) },
  localStorage: {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = String(value)
    },
  },
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
}
globalThis.window = sandbox
globalThis.document = { getElementById: () => null, head: { appendChild: () => {} }, createElement: () => ({}) }

const code = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
new Function('window', code)(sandbox)
if (!factory) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
console.log('loader id:', sandbox.loadedId)
if (sandbox.loadedId !== 'dsh-cetwt') throw new Error(`loader id 应为 dsh-cetwt，实际 ${sandbox.loadedId}`)

const mod = factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
console.log('exports:', Object.keys(mod).join(', '))
console.log('inject:', JSON.stringify(mod.inject))
if (typeof mod.apply !== 'function') throw new Error('缺少 apply')

mod.apply(ctx)
console.log('effects:', JSON.stringify(effects))
console.log('registrations:')
for (const { options } of registered) {
  console.log(`  - ${options.name} ${options.key || options.id} order=${options.order ?? '-'}`)
}
if (registered.length !== 3) throw new Error(`应注册 3 处（main / sidebar.panellist / shell.overlay），实际 ${registered.length}`)

const main = registered.find((r) => r.options.name === 'main')
const rail = registered.find((r) => r.options.name === 'sidebar.panellist')
const overlay = registered.find((r) => r.options.name === 'shell.overlay')
if (!main || main.options.key !== 'dsh-cetwt') throw new Error('缺少 main[key=dsh-cetwt]')
if (!rail || rail.options.id !== 'dsh-cetwt') throw new Error('缺少 sidebar.panellist[id=dsh-cetwt]')
if (rail.options.order !== 43) throw new Error(`左侧栏顺序应为 43，实际 ${rail.options.order}`)
if (typeof rail.options.label !== 'function' || !rail.options.label()) throw new Error('左侧栏 label 无效')
if (!overlay || overlay.options.id !== 'dsh-cetwt') throw new Error('缺少 shell.overlay 浮窗')

/* ── 左侧栏图标 ── */
const icon = rail.component({ size: 20 })
if (icon.type !== 'span') throw new Error('图标外层应是 span')
const svg = icon.children?.[0]
if (svg?.type !== 'svg') throw new Error('图标里没有 svg')
if (svg.props.width !== 20 || svg.props.height !== 20) throw new Error('图标未跟随 props.size')
if (String(svg.props.stroke) !== 'currentColor') throw new Error('图标应使用 currentColor 描边')
console.log('图标 viewBox:', svg.props.viewBox, 'size:', svg.props.width)

/* ── 工作台面板 ── */
const work = main.component({})
if (work.type !== 'div' || !String(work.props.className).includes('cetwt-work')) throw new Error('工作台外层不是 div.cetwt-work')
if (work.props['data-dsh-part'] !== 'panel') throw new Error('工作台缺少 data-dsh-part=panel')
const workChildren = work.children ?? []
const workFrame = workChildren.find((c) => c?.type === 'iframe')
if (!workFrame) throw new Error('工作台里没有 iframe')
if (workFrame.props.src !== '/cetwt/app/index.html') throw new Error(`工作台 iframe src 异常：${workFrame.props.src}`)
if (String(work.props.style?.display) !== 'flex') throw new Error('工作台外层缺少内联 flex 兜底')
if (workFrame.props.style?.width !== '100%' || workFrame.props.style?.height !== '100%') {
  throw new Error('工作台 iframe 缺少内联尺寸兜底')
}
if (!workChildren.some((c) => typeof c?.type === 'function')) throw new Error('工作台缺少样式注入（StyleOnce）')
console.log('工作台 iframe:', workFrame.props.src)

/* ── 浮窗：关闭态 / 打开态 ── */
stored = null
const overlayTree = overlay.component({})
if (overlayTree.type !== React.Fragment) throw new Error('浮层应返回 Fragment')
const floatFn = overlayTree.children?.[1]
if (typeof floatFn?.type !== 'function') throw new Error('浮层里没有 FloatPopup 组件')

const closed = floatFn.type({})
if (closed.children?.[0] != null) throw new Error('未开启时不应渲染浮窗')

stored = JSON.stringify({ open: true, left: 320, top: 120, w: 460, h: 640 })
const opened = floatFn.type({})
const pop = opened.children?.[0]
if (pop?.type !== 'div' || !String(pop.props.className).includes('cetwt-pop')) throw new Error('打开态没有浮窗')
if (pop.props.style.left !== '320px' || pop.props.style.top !== '120px') throw new Error('浮窗未使用记忆位置')
const [head, body] = pop.children
for (const handler of ['onPointerDown', 'onPointerMove', 'onPointerUp']) {
  if (typeof head.props[handler] !== 'function') throw new Error(`标题栏缺少拖动处理器 ${handler}`)
}
if (head.children.filter((c) => c?.type === 'button').length !== 2) throw new Error('标题栏应有 2 个按钮（复位/关闭）')
const [frame, grip] = body.children
if (frame?.type !== 'iframe' || frame.props.src !== '/cetwt/app/index.html') throw new Error('浮窗 iframe 异常')
if (typeof grip?.props?.onPointerMove !== 'function') throw new Error('缺少缩放手柄处理器')

console.log('浮窗位置:', pop.props.style.left, pop.props.style.top, pop.props.style.width, pop.props.style.height)
console.log('\n✅ 客户端模块自检通过')
