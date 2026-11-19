// client half 的离线夹具：用极简 React 桩（能跑 hooks + 重渲染）驱动
// factory → apply(ctx) → 渲染，验证：
//   ① 两个 slot 注册（main key / sidebar.panellist id/order/label/icon）
//   ② 数据读取走 connection.fetch('/api/file?path=...')（带 peer）
//   ③ 空态 / 有工程 / 读不到 三态渲染不抛错
// 不覆盖真实浏览器渲染（那需要桌面版/浏览器实跑）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
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

/** 只响应 /api/file 的 connection 桩；files: 绝对路径 → 文本内容。 */
function makeConnection(files, calls) {
  return {
    browserPeer: { principal: 'owner' },
    async fetch(url, peer) {
      calls.push({ url, peer })
      const match = /\/api\/file\?path=([^&]+)/.exec(url)
      if (match === null) return { ok: false, status: 404 }
      const target = decodeURIComponent(match[1]).replace(/\\/g, '/')
      const hit = Object.keys(files).find((k) => k.replace(/\\/g, '/') === target)
      if (hit === undefined) return { ok: false, status: 404 }
      return { ok: true, status: 200, async text() { return files[hit] } }
    },
  }
}

/** 造插件 ctx（含 slots 桩）并 apply，返回 main 面板组件。 */
function mount(react, options) {
  const { files = {}, home, calls = [], fetchThrows = false } = options || {}
  const connection = fetchThrows
    ? { browserPeer: {}, async fetch() { throw new Error('boom') } }
    : makeConnection(files, calls)
  const services = { connection, remote: { $host: { home } } }
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

function workspaceJson(entries) {
  const table = {}
  for (const entry of entries) table[entry.id] = entry
  return JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: {}, tables: { workspaces: table } })
}

// ---------------- 注册契约 ----------------

test('body 暴露 inject 与 apply', () => {
  const api = loadClient(createReactStub())
  assert.equal(typeof api.apply, 'function')
  assert.equal(Array.from(api.inject).join(','), 'slots,connection,remote')
})

test('注册 main(key) 与 sidebar.panellist(id/order/label)，icon 可渲染', () => {
  const { registrations } = mount(createReactStub(), { files: {}, home: 'C:/home' })
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

test('无已接入工程 → 空态（显示接入命令）', async () => {
  const react = createReactStub()
  const home = path.join(os.tmpdir(), 'cl-home-' + Date.now())
  const files = {
    [path.join(home, 'storages/workspace.json')]: workspaceJson([
      { id: 'w1', path: 'E:/proj-a', title: 'proj-a', updatedAt: '2026-11-01T00:00:00Z' },
    ]),
  }
  const { page, calls } = mount(react, { files, home })
  const text = collectText(await react.render(page, {})).join(' ')
  assert.match(text, /还没有已接入的工程/)
  assert.match(text, /loop-state\.ps1 -Action init/)
  assert.ok(calls.length > 0, '应通过 connection.fetch 读取')
  assert.ok(calls.every((c) => c.peer !== undefined), '每次 fetch 都带 peer')
  assert.ok(calls.every((c) => c.url.startsWith('/api/file?path=')), '只走 /api/file')
})

test('有已接入工程 → 渲染档位/阶段/门禁/阻断/下一步', async () => {
  const react = createReactStub()
  const home = path.join(os.tmpdir(), 'cl-home2-' + Date.now())
  const wsPath = 'E:/proj-b'
  const files = {
    [path.join(home, 'storages/workspace.json')]: workspaceJson([
      { id: 'w2', path: wsPath, title: 'proj-b', updatedAt: '2026-11-18T00:00:00Z' },
    ]),
    [wsPath + '/.dsh/loop/project.json']: JSON.stringify({ name: '气量平衡月表', mode: 'on' }),
    [wsPath + '/.dsh/loop/state.json']: JSON.stringify({
      mode: 'on', skillVersion: '2.11.1', stage: 'WIRE', updatedAt: '2026-11-19T09:00:00+08:00',
      checks: { design: { status: 'FAIL', exit: 1, at: '2026-11-19T09:00:00+08:00' }, grill: { status: 'MISSING' } },
      blockers: [{ id: 'D-01', text: '缺 1440 截图', owner: 'lead', due: '2026-11-20' }],
      next: { label: '补 design-context 后重跑设计门', command: 'loop-gate -Kind design' },
    }),
  }
  const { page } = mount(react, { files, home })
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
})

test('shadow 档 → 显示影子与观察进度', async () => {
  const react = createReactStub()
  const home = path.join(os.tmpdir(), 'cl-home3-' + Date.now())
  const wsPath = 'E:/proj-c'
  const files = {
    [path.join(home, 'storages/workspace.json')]: workspaceJson([
      { id: 'w3', path: wsPath, title: 'proj-c', updatedAt: '2026-11-18T00:00:00Z' },
    ]),
    [wsPath + '/.dsh/loop/project.json']: JSON.stringify({ name: 'proj-c', mode: 'shadow' }),
    [wsPath + '/.dsh/loop/state.json']: JSON.stringify({
      mode: 'shadow', stage: 'GATE', shadow: { sessions: 2, target: 3, canUpgrade: false },
      checks: {}, blockers: [],
    }),
  }
  const { page } = mount(react, { files, home })
  const text = collectText(await react.render(page, {})).join(' ')
  assert.match(text, /影子/)
  assert.match(text, /已观察 2 \/ 3 个会话/)
})

test('home 未知 → 不抛错（空态）', async () => {
  const react = createReactStub()
  const { page } = mount(react, { files: {}, home: undefined })
  const text = collectText(await react.render(page, {})).join(' ')
  assert.match(text, /还没有已接入的工程/)
})

test('connection 抛错 → 不崩（空态）', async () => {
  const react = createReactStub()
  const { page } = mount(react, { fetchThrows: true, home: 'C:/home' })
  const text = collectText(await react.render(page, {})).join(' ')
  assert.match(text, /还没有已接入的工程/)
})
