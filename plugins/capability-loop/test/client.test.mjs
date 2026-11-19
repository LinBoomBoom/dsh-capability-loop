// client half 的离线夹具：用极简 React 桩（能跑 hooks + 重渲染）驱动
// factory → apply(ctx) → 渲染，验证：
//   ① 两个 slot 注册（main key / sidebar.panellist id/order/label/icon）
//   ② 数据通道：remote.session.list → remote.workspaceFiles.read(sessionId, 相对路径)
//   ③ 空态 / 有工程 / 读不到 三态渲染不抛错
// 不覆盖真实浏览器渲染（那需要桌面版/浏览器实跑）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = path.resolve(HERE, '..', 'client.js')
const CLIENT_SOURCE = fs.readFileSync(CLIENT_SRC, 'utf8')

/** 极简 React 桩：createElement + hooks（useState/useCallback/useEffect）+ flush 重渲染。 */
function createReactStub() {
  const cells = []
  const ranEffects = {}
  let cursor = 0
  let dirty = false
  let effectQueue = []

  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      const setter = (next) => {
        cells[index] = typeof next === 'function' ? next(cells[index]) : next
        dirty = true
      }
      return [cells[index], setter]
    },
    useCallback(fn) { cursor += 1; return fn },
    useEffect(fn) {
      const index = cursor++
      if (!(index in ranEffects)) { ranEffects[index] = true; effectQueue.push(fn) }
    },
    async render(Component, props, maxRounds = 8) {
      let tree
      for (let round = 0; round < maxRounds; round += 1) {
        cursor = 0
        dirty = false
        effectQueue = []
        tree = Component(props)
        for (const effect of effectQueue) effect()
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (!dirty) return tree
      }
      return tree
    },
  }
}

/** 载入 client.js 并返回 factory 产出的 body（inject/apply）。 */
function loadClient(react) {
  let captured
  const sandbox = { window: { __ModuleLoader__: { load(entry) { captured = entry } } }, console }
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' })
  assert.ok(captured, 'client.js 应调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-capability-loop-bundle', 'id 必须等于包名')
  return captured.factory((name) => {
    if (name === 'react') return react
    throw new Error('unexpected require: ' + name)
  })
}

/**
 * 造插件 ctx 并 apply，返回 main 面板组件。
 * - sessions：remote.session.list 返回的条目（含 sessionId / cwd / updatedAt）
 * - files：`<sessionId>|.dsh/loop/state.json` → 文本
 * - calls：记录每次 workspaceFiles.read
 */
function mount(react, options) {
  const { sessions = [], files = {}, calls = [], listThrows = false, readThrows = false, home } = options || {}

  const remote = {
    $host: { home },
    session: {
      async list() {
        if (listThrows) throw new Error('list-boom')
        return { ok: true, value: { items: sessions } }
      },
    },
    workspaceFiles: {
      async read(sessionId, relPath) {
        calls.push({ sessionId, relPath })
        if (readThrows) {
          const error = new Error('read-boom')
          throw error
        }
        const key = sessionId + '|' + String(relPath).replace(/\\/g, '/')
        if (!(key in files)) {
          const error = new Error('workspace-file/not-found')
          error.code = 'workspace-file/not-found'
          throw error
        }
        return { ok: true, value: { text: files[key], offset: 1, lines: 1, eof: true, absolutePath: relPath, version: 1 } }
      },
    },
  }

  const services = { remote, connection: undefined }
  const registrations = []
  const ctx = {
    get(name) { return services[name] },
    slots: {
      inject(owner, cb) { cb() },
      register(options_, component) { registrations.push({ owner: options_.name, options: options_, component }) },
    },
  }
  const api = loadClient(react)
  api.apply(ctx)
  const main = registrations.find((r) => r.owner === 'main')
  const side = registrations.find((r) => r.owner === 'sidebar.panellist')
  return { api, ctx, registrations, page: main ? main.component : undefined, side, calls }
}

function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') {
      collectText(node.type(node.props === undefined ? {} : node.props), out)
      return out
    }
    collectText(node.children, out)
  }
  return out
}

/** 一条会话语义：workspace = 该会话 cwd。 */
function session(id, cwd, updatedAt) {
  return { sessionId: id, cwd, updatedAt, running: false, blank: false, agentAvailable: true }
}

const PROJECT = JSON.stringify({ name: '气量平衡月表', mode: 'on' })
const STATE = JSON.stringify({
  mode: 'on', skillVersion: '2.12.0', stage: 'WIRE', updatedAt: '2026-11-19T09:00:00+08:00',
  checks: { design: { status: 'FAIL', exit: 1, at: '2026-11-19T09:00:00+08:00' }, grill: { status: 'MISSING' } },
  blockers: [{ id: 'D-01', text: '缺 1440 截图', owner: 'lead', due: '2026-11-20' }],
  next: { label: '补 design-context 后重跑设计门', command: 'loop-gate -Kind design' },
})

// ---------------- 注册契约 ----------------

test('body 暴露 inject 与 apply', () => {
  const api = loadClient(createReactStub())
  assert.equal(typeof api.apply, 'function')
  assert.equal(Array.from(api.inject).join(','), 'slots,connection,remote,remote.session,remote.workspaceFiles')
})

test('注册 main(key) 与 sidebar.panellist(id/order/label)，icon 可渲染', () => {
  const { registrations } = mount(createReactStub(), {})
  assert.equal(registrations.length, 2, '只注册两个 slot')
  const main = registrations.find((r) => r.owner === 'main')
  assert.equal(main.options.key, 'capability-loop')
  assert.equal(typeof main.component, 'function')

  const side = registrations.find((r) => r.owner === 'sidebar.panellist')
  assert.equal(side.options.id, 'capability-loop')
  assert.equal(side.options.order, 20)
  assert.equal(side.options.label(), '能力闭环')

  const icon = side.component({ size: 16 })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 16)
  assert.ok(icon.children.length >= 4, '图标应含多条路径')
})

// ---------------- 渲染 ----------------

test('有已接入工程 → 渲染档位/阶段/门禁/阻断/下一步，且只用会话相对读', async () => {
  const react = createReactStub()
  const files = {
    's1|.dsh/loop/project.json': PROJECT,
    's1|.dsh/loop/state.json': STATE,
  }
  const { page, calls } = mount(react, { sessions: [session('s1', 'E:/proj-b', 1000)], files })
  const text = collectText(await react.render(page, {})).join(' ')

  assert.match(text, /能力闭环/)
  assert.match(text, /气量平衡月表/)
  assert.match(text, /接管/)
  assert.match(text, /完整契约随首步注入/)
  assert.match(text, /WIRE/)
  assert.match(text, /第 4 \/ 7 阶段/)
  assert.match(text, /设计门/)
  assert.match(text, /0 \/ 2 通过/, 'design FAIL + grill MISSING → 0/2')
  assert.match(text, /D-01 缺 1440 截图/)
  assert.match(text, /补 design-context 后重跑设计门/)
  assert.match(text, /loop-gate -Kind design/)
  assert.match(text, /E:\/proj-b\/\.dsh\/loop\/state\.json/)

  assert.ok(calls.length >= 2, '应读 project.json 与 state.json')
  assert.ok(calls.every((c) => c.sessionId === 's1'), '用该工作区最近会话作凭据')
  assert.ok(calls.every((c) => String(c.relPath).indexOf('.dsh/loop/') === 0), '只读 .dsh/loop 下的相对路径')
})

test('多个工作区 → 每个工作区各用自己的会话读取，并给出工程下拉', async () => {
  const react = createReactStub()
  const files = {
    'sa|.dsh/loop/project.json': JSON.stringify({ name: 'proj-a', mode: 'shadow' }),
    'sa|.dsh/loop/state.json': JSON.stringify({ mode: 'shadow', stage: 'GATE', checks: {}, blockers: [] }),
    'sb|.dsh/loop/project.json': PROJECT,
    'sb|.dsh/loop/state.json': STATE,
  }
  const { page, calls } = mount(react, {
    sessions: [session('sa', 'E:/proj-a', 2000), session('sb', 'E:/proj-b', 1000)],
    files,
  })
  const text = collectText(await react.render(page, {})).join(' ')
  assert.match(text, /已接入工程/, '多工程时应有切换器')
  assert.match(text, /proj-a/)
  assert.ok(calls.some((c) => c.sessionId === 'sa') && calls.some((c) => c.sessionId === 'sb'))
})

test('没有已接入工程 → 空态（显示接入命令）', async () => {
  const react = createReactStub()
  const { page } = mount(react, { sessions: [session('s1', 'E:/proj-x', 1000)], files: {} })
  const text = collectText(await react.render(page, {})).join(' ')
  assert.match(text, /还没有已接入的工程/)
  assert.match(text, /loop-state\.ps1 -Action init/)
})

test('会话列表为空 → 空态 + 诊断说明需要会话', async () => {
  const react = createReactStub()
  const { page } = mount(react, { sessions: [] })
  const text = collectText(await react.render(page, {})).join(' ')
  assert.match(text, /还没有已接入的工程/)
  assert.match(text, /还没有任何会话/)
})

test('session.list 抛错 → 空态不崩', async () => {
  const react = createReactStub()
  const { page } = mount(react, { listThrows: true })
  const text = collectText(await react.render(page, {})).join(' ')
  assert.match(text, /还没有已接入的工程/)
})

test('workspaceFiles.read 抛错 → 空态不崩', async () => {
  const react = createReactStub()
  const { page } = mount(react, { sessions: [session('s1', 'E:/proj-y', 1)], readThrows: true })
  const text = collectText(await react.render(page, {})).join(' ')
  assert.match(text, /还没有已接入的工程/)
})

test('无 remote 服务 → 空态 + 诊断（不抛错）', async () => {
  const react = createReactStub()
  const api = loadClient(react)
  let page
  api.apply({
    get() { return undefined },
    slots: { inject(owner, cb) { cb() }, register(options, component) { if (options.name === 'main') page = component } },
  })
  const text = collectText(await react.render(page, {})).join(' ')
  assert.match(text, /还没有已接入的工程/)
})
