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

/** 极简 React 桩：createElement + hooks（useState/useCallback/useEffect 带 deps）+ flush 重渲染。 */
function createReactStub() {
  const cells = []
  const effectStates = []
  let cursor = 0
  let dirty = false
  let effectQueue = []

  const sameDeps = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i])

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
    useEffect(fn, deps) {
      const index = cursor++
      const previous = effectStates[index]
      const hasDeps = Array.isArray(deps)
      // 不传 deps 时按 React 语义“每次渲染都跑”会无限循环；夹具里降级为只跑一次。
      const changed = previous === undefined || (hasDeps && !sameDeps(previous.deps, deps))
      if (!changed) return
      const record = { deps: hasDeps ? deps : null, cleanup: previous !== undefined ? previous.cleanup : undefined }
      effectStates[index] = record
      effectQueue.push(() => {
        if (typeof record.cleanup === 'function') record.cleanup()
        const cleanup = fn()
        if (typeof cleanup === 'function') record.cleanup = cleanup
      })
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

/** 载入 client.js 并返回 factory 产出的 body（inject/apply）+ 剪贴板/键盘记录。 */
function loadClient(react) {
  let captured
  const clipboardCalls = []
  const keyHandlers = []
  const documentStub = {
    addEventListener(type, fn) { if (type === 'keydown') keyHandlers.push(fn) },
    removeEventListener(type, fn) {
      if (type !== 'keydown') return
      const at = keyHandlers.indexOf(fn)
      if (at >= 0) keyHandlers.splice(at, 1)
    },
    querySelector() { return null },
    body: { appendChild() {}, removeChild() {} },
    createElement() { return { style: {}, setAttribute() {}, select() {} } },
    execCommand() { return false },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(entry) { captured = entry } } },
    console,
    AbortController,
    navigator: { clipboard: { writeText(text) { clipboardCalls.push(String(text)); return Promise.resolve() } } },
    document: documentStub,
  }
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' })
  assert.ok(captured, 'client.js 应调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-capability-loop-bundle', 'id 必须等于包名')
  const body = captured.factory((name) => {
    if (name === 'react') return react
    throw new Error('unexpected require: ' + name)
  })
  body.clipboardCalls = clipboardCalls
  body.pressKey = (key) => {
    for (const handler of keyHandlers.slice()) {
      handler({ key, preventDefault() {}, shiftKey: false })
    }
  }
  return body
}

/**
 * 造插件 ctx 并 apply，返回 main 面板组件。
 * - sessions：remote.session.list 返回的条目（含 sessionId / cwd / updatedAt）
 * - files：`<sessionId>|.dsh/loop/state.json` → 文本
 * - calls：记录每次 workspaceFiles.read
 */
function mount(react, options) {
  const { sessions = [], files = {}, calls = [], listThrows = false, readThrows = false, home, noCommands = false, commandsResult, hangCommands = false } = options || {}

  const commandsCalls = []
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
  if (!noCommands) {
    remote.commands = {
      async execute(sessionId, line, attachments, signal) {
        commandsCalls.push({ sessionId, line, attachments, signal })
        if (hangCommands) return new Promise(() => {})
        if (commandsResult !== undefined) return commandsResult
        return { ok: true, value: { commandId: 'cmd-1', result: { kind: 'success', text: '[' + line + '] ok' } } }
      },
    }
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
  return {
    api,
    ctx,
    registrations,
    page: main ? main.component : undefined,
    side,
    calls,
    commandsCalls,
    clipboardCalls: api.clipboardCalls,
    pressKey: api.pressKey,
  }
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

/** 在渲染树里找一个按钮（按可见文字，children 是字符串，不递归组件）。 */
function findButton(node, label) {
  if (node === null || node === undefined) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label)
      if (found !== null) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (node.type === 'button') {
    const text = collectText(node.children).join(' ')
    if (text.indexOf(label) >= 0) return node
    return null
  }
  // 组件元素：展开它（面板里这些子组件都不用 hooks，安全）
  if (typeof node.type === 'function') return findButton(node.type(node.props === undefined ? {} : node.props), label)
  return findButton(node.children, label)
}

/** 在渲染树里找一个 select（按选项文字）。 */
function findSelectWithOption(node, label) {
  if (node === null || node === undefined) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findSelectWithOption(child, label)
      if (found !== null) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (node.type === 'select') {
    const text = collectText(node.children).join(' ')
    return text.indexOf(label) >= 0 ? node : null
  }
  if (typeof node.type === 'function') return findSelectWithOption(node.type(node.props === undefined ? {} : node.props), label)
  return findSelectWithOption(node.children, label)
}

/** 在渲染树里找一个输入框（按 placeholder）。 */
function findInput(node, placeholder) {
  if (node === null || node === undefined) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findInput(child, placeholder)
      if (found !== null) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (node.type === 'input') {
    const text = String(node.props.placeholder === undefined ? '' : node.props.placeholder)
    return text.indexOf(placeholder) >= 0 ? node : null
  }
  if (typeof node.type === 'function') return findInput(node.type(node.props === undefined ? {} : node.props), placeholder)
  return findInput(node.children, placeholder)
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

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
  assert.equal(Array.from(api.inject).join(','), 'slots,connection,remote,remote.session,remote.workspaceFiles,remote.commands')
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
  // 工程归属：工程条 + 每张卡片都带工程名 chip，单工程也能看出阻断属于谁
  assert.match(text, /工程 气量平衡月表 E:\/proj-b/, '工程条显示名称与路径')
  assert.match(text, /列出全部有会话的工作区/, '单工程时说明列出范围')
  assert.match(text, /阻断与下一步 气量平衡月表/, '阻断卡片带工程名')
  assert.match(text, /门禁与证据 气量平衡月表/, '门禁卡片带工程名')
  assert.match(text, /运行中心 气量平衡月表/, '运行中心卡片带工程名')

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
  assert.match(text, /可用工作区/, '多工程时应有切换器')
  assert.match(text, /proj-a/)
  assert.ok(calls.some((c) => c.sessionId === 'sa') && calls.some((c) => c.sessionId === 'sb'))
})

test('多工程：切换工程会重读该工程状态，内容跟着换', async () => {
  const react = createReactStub()
  const files = {
    'sa|.dsh/loop/project.json': JSON.stringify({ name: 'proj-a', mode: 'shadow' }),
    'sa|.dsh/loop/state.json': JSON.stringify({
      mode: 'shadow', stage: 'GATE', checks: {}, updatedAt: '2026-11-19T10:00:00+08:00',
      blockers: [{ id: 'D-09', text: 'A 工程的阻断', owner: 'lead' }], next: { label: 'A 的下一步' },
    }),
    'sb|.dsh/loop/project.json': PROJECT,
    'sb|.dsh/loop/state.json': STATE,
  }
  const { page, calls } = mount(react, {
    sessions: [session('sa', 'E:/proj-a', 2000), session('sb', 'E:/proj-b', 1000)],
    files,
  })
  let tree = await react.render(page, {})
  let text = collectText(tree).join(' ')
  assert.match(text, /共 2 个可用工作区/)
  assert.match(text, /阻断与下一步 proj-a/, '默认选中最近会话的工程（proj-a）')
  assert.match(text, /D-09 A 工程的阻断/)

  const before = calls.length
  const select = findSelectWithOption(tree, '气量平衡月表')
  assert.ok(select, '应有工程下拉')
  select.props.onChange({ target: { value: '1' } })
  await tick()
  tree = await react.render(page, {})
  text = collectText(tree).join(' ')

  assert.ok(calls.length > before, '切换后应重读该工程状态')
  assert.match(text, /阻断与下一步 气量平衡月表/, '切到 proj-b 后卡头跟着换')
  assert.match(text, /D-01 缺 1440 截图/, '阻断内容跟着换')
  assert.doesNotMatch(text, /D-09 A 工程的阻断/)
})

test('未接入的工作区 → 仍列在下拉里并给一键接入（不再被过滤掉）', async () => {
  const react = createReactStub()
  const { page } = mount(react, { sessions: [session('s1', 'E:/proj-x', 1000)], files: {} })
  const text = collectText(await react.render(page, {})).join(' ')
  assert.match(text, /尚未接入治理闭环/, '未接入的要显示接入引导')
  assert.match(text, /接入这个工作区（影子档）/, '要有接入按钮')
  assert.match(text, /E:\/proj-x/, '下拉/路径里能看到该工作区')
})

test('全部工作区都未接入 → 每个都列出来（不被过滤）', async () => {
  const react = createReactStub()
  const { page } = mount(react, {
    sessions: [session('sa', 'E:/proj-a', 3000), session('sb', 'E:/proj-b', 2000), session('sc', 'E:/proj-c', 1000)],
    files: {},
  })
  const text = collectText(await react.render(page, {})).join(' ')
  assert.match(text, /共 3 个可用工作区/)
  assert.match(text, /proj-a/)
  assert.match(text, /proj-b/)
  assert.match(text, /proj-c/)
})

test('会话列表为空 → 空态 + 诊断说明需要会话', async () => {
  const react = createReactStub()
  const { page } = mount(react, { sessions: [] })
  const text = collectText(await react.render(page, {})).join(' ')
  assert.match(text, /没有可用|尚未接入|还没有可用的工作区会话/)
  assert.match(text, /还没有可用的工作区会话/)
})

test('session.list 抛错 → 空态不崩', async () => {
  const react = createReactStub()
  const { page } = mount(react, { listThrows: true })
  const text = collectText(await react.render(page, {})).join(' ')
  assert.match(text, /没有可用|尚未接入|还没有可用的工作区会话/)
})

test('workspaceFiles.read 抛错 → 空态不崩', async () => {
  const react = createReactStub()
  const { page } = mount(react, { sessions: [session('s1', 'E:/proj-y', 1)], readThrows: true })
  const text = collectText(await react.render(page, {})).join(' ')
  assert.match(text, /没有可用|尚未接入|还没有可用的工作区会话/)
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
  assert.match(text, /没有可用|尚未接入|还没有可用的工作区会话/)
})

// ---------------- 运行中心（P2 动作） ----------------

test('运行中心：动作按钮 + 档位切换都在面板里', async () => {
  const react = createReactStub()
  const files = { 's1|.dsh/loop/project.json': PROJECT, 's1|.dsh/loop/state.json': STATE }
  const { page } = mount(react, { sessions: [session('s1', 'E:/proj-b', 1000)], files })
  const text = collectText(await react.render(page, {})).join(' ')
  assert.match(text, /运行中心/)
  assert.match(text, /运行门禁/)
  assert.match(text, /交接体检/)
  assert.match(text, /模块预检/)
  assert.match(text, /上架打包/)
  assert.match(text, /能力体检/)
  assert.match(text, /视觉探测/)
  assert.match(text, /版本检查/)
  assert.match(text, /影子计数/)
  assert.match(text, /接管 影子 关闭/, '头部三段档位切换')
})

test('切档位：点按钮 → 确认弹窗展示完整命令 → 确认后走 remote.commands.execute', async () => {
  const react = createReactStub()
  const files = { 's1|.dsh/loop/project.json': PROJECT, 's1|.dsh/loop/state.json': STATE }
  const { page, commandsCalls } = mount(react, {
    sessions: [session('s1', 'E:/proj-b', 1000)],
    files,
    commandsResult: { ok: true, value: { commandId: 'cmd-2', result: { kind: 'success', text: '[切档位] 已切换到 shadow' } } },
  })

  let tree = await react.render(page, {})
  const shadowBtn = findButton(tree, '影子')
  assert.ok(shadowBtn, '应有「影子」档位按钮')
  shadowBtn.props.onClick()

  tree = await react.render(page, {})
  const modalText = collectText(tree).join(' ')
  assert.match(modalText, /确认运行：切到影子（shadow）/)
  assert.match(modalText, /\/capability-loop mode shadow/)
  assert.match(modalText, /只会影响后续注入|只影响后续注入/)

  const confirmBtn = findButton(tree, '确认运行')
  assert.ok(confirmBtn, '应有确认按钮')
  confirmBtn.props.onClick()
  await tick()

  tree = await react.render(page, {})
  const resultText = collectText(tree).join(' ')
  assert.match(resultText, /最近一次运行/)
  assert.match(resultText, /\[切档位\] 已切换到 shadow/)

  assert.equal(commandsCalls.length, 1)
  assert.equal(commandsCalls[0].sessionId, 's1', '用该工程的会话作凭据')
  assert.equal(commandsCalls[0].line, '/capability-loop mode shadow')
  assert.equal(commandsCalls[0].attachments.length, 0, '命令不带附件')
})

test('运行门禁：命令组装带 kind/taskDir，输出回显并按结果标 PASS', async () => {
  const react = createReactStub()
  const files = { 's1|.dsh/loop/project.json': PROJECT, 's1|.dsh/loop/state.json': STATE }
  const { page, commandsCalls } = mount(react, {
    sessions: [session('s1', 'E:/proj-b', 1000)],
    files,
    commandsResult: { ok: true, value: { commandId: 'cmd-3', result: { kind: 'success', text: '[门禁] PASS（exit 0）\n设计门通过' } } },
  })

  let tree = await react.render(page, {})
  const dirInput = findInput(tree, 'taskDir')
  assert.ok(dirInput, '应有 taskDir 输入框')
  dirInput.props.onChange({ target: { value: 'docs/design' } })
  tree = await react.render(page, {})

  const gateBtn = findButton(tree, '运行门禁')
  assert.ok(gateBtn)
  gateBtn.props.onClick()
  tree = await react.render(page, {})
  assert.match(collectText(tree).join(' '), /\/capability-loop run gate kind=design taskDir=docs\/design/)

  findButton(tree, '确认运行').props.onClick()
  await tick()
  tree = await react.render(page, {})
  const text = collectText(tree).join(' ')
  assert.match(text, /\[门禁\] PASS/)
  assert.equal(commandsCalls[0].line, '/capability-loop run gate kind=design taskDir=docs/design')
})

test('门禁缺 taskDir：按钮禁用并提示；环境验收不需要 taskDir', async () => {
  const react = createReactStub()
  const files = { 's1|.dsh/loop/project.json': PROJECT, 's1|.dsh/loop/state.json': STATE }
  const { page, commandsCalls } = mount(react, {
    sessions: [session('s1', 'E:/proj-b', 1000)],
    files,
    commandsResult: { ok: true, value: { commandId: 'cmd-env', result: { kind: 'success', text: '[环境验收] PASS' } } },
  })

  let tree = await react.render(page, {})
  const gateBtn = findButton(tree, '运行门禁')
  assert.equal(gateBtn.props.disabled, true, '没有 taskDir 时不应允许运行门禁')
  assert.match(collectText(tree).join(' '), /先填 taskDir/)

  const envBtn = findButton(tree, '环境验收')
  assert.ok(envBtn)
  envBtn.props.onClick()
  tree = await react.render(page, {})
  assert.match(collectText(tree).join(' '), /\/capability-loop run env/)
  findButton(tree, '确认运行').props.onClick()
  await tick()
  assert.equal(commandsCalls[0].line, '/capability-loop run env')
})

test('含空格的 taskDir 用引号传，命令不被空格截断', async () => {
  const react = createReactStub()
  const files = { 's1|.dsh/loop/project.json': PROJECT, 's1|.dsh/loop/state.json': STATE }
  const { page, commandsCalls } = mount(react, { sessions: [session('s1', 'E:/proj-b', 1000)], files })

  let tree = await react.render(page, {})
  findInput(tree, 'taskDir').props.onChange({ target: { value: 'docs/my design' } })
  tree = await react.render(page, {})
  findButton(tree, '运行门禁').props.onClick()
  tree = await react.render(page, {})
  findButton(tree, '确认运行').props.onClick()
  await tick()
  assert.equal(commandsCalls[0].line, '/capability-loop run gate kind=design taskDir="docs/my design"')
})

test('确认框：可复制完整命令，并显示「已复制」', async () => {
  const react = createReactStub()
  const files = { 's1|.dsh/loop/project.json': PROJECT, 's1|.dsh/loop/state.json': STATE }
  const { page, clipboardCalls } = mount(react, { sessions: [session('s1', 'E:/proj-b', 1000)], files })

  let tree = await react.render(page, {})
  findButton(tree, '影子').props.onClick()
  tree = await react.render(page, {})
  assert.ok(findButton(tree, '复制命令'), '确认框应有复制命令按钮')
  findButton(tree, '复制命令').props.onClick()
  await tick()
  tree = await react.render(page, {})
  assert.equal(clipboardCalls[0], '/capability-loop mode shadow')
  const text = collectText(tree).join(' ')
  assert.match(text, /已复制/)
})

test('结果区：可复制输出与命令', async () => {
  const react = createReactStub()
  const files = { 's1|.dsh/loop/project.json': PROJECT, 's1|.dsh/loop/state.json': STATE }
  const { page, clipboardCalls } = mount(react, {
    sessions: [session('s1', 'E:/proj-b', 1000)],
    files,
    commandsResult: { ok: true, value: { commandId: 'cmd-copy', result: { kind: 'success', text: '[门禁] PASS（exit 0）\n设计门通过' } } },
  })

  let tree = await react.render(page, {})
  findInput(tree, 'taskDir').props.onChange({ target: { value: 'docs/design' } })
  tree = await react.render(page, {})
  findButton(tree, '运行门禁').props.onClick()
  tree = await react.render(page, {})
  findButton(tree, '确认运行').props.onClick()
  await tick()
  tree = await react.render(page, {})

  findButton(tree, '复制输出').props.onClick()
  await tick()
  findButton(tree, '复制命令').props.onClick()
  await tick()
  assert.ok(clipboardCalls.some((t) => t.indexOf('[门禁] PASS') >= 0), '复制输出应写剪贴板')
  assert.ok(clipboardCalls.some((t) => t.indexOf('/capability-loop run gate') >= 0), '复制命令应写剪贴板：' + JSON.stringify(clipboardCalls))
  tree = await react.render(page, {})
  assert.match(collectText(tree).join(' '), /已复制/)
})

test('确认框：按 ESC 关闭', async () => {
  const react = createReactStub()
  const files = { 's1|.dsh/loop/project.json': PROJECT, 's1|.dsh/loop/state.json': STATE }
  const { page, pressKey } = mount(react, { sessions: [session('s1', 'E:/proj-b', 1000)], files })

  let tree = await react.render(page, {})
  findButton(tree, '影子').props.onClick()
  tree = await react.render(page, {})
  assert.match(collectText(tree).join(' '), /确认运行：切到影子/)
  pressKey('Escape')
  await tick()
  tree = await react.render(page, {})
  const text = collectText(tree).join(' ')
  assert.doesNotMatch(text, /确认运行：切到影子/)
  assert.match(text, /能力闭环/)
})

test('命令未被受理（value=undefined）→ 结果区提示需重启注册', async () => {
  const react = createReactStub()
  const files = { 's1|.dsh/loop/project.json': PROJECT, 's1|.dsh/loop/state.json': STATE }
  const { page } = mount(react, {
    sessions: [session('s1', 'E:/proj-b', 1000)],
    files,
    commandsResult: { ok: true, value: undefined },
  })
  let tree = await react.render(page, {})
  findButton(tree, '关闭').props.onClick()
  tree = await react.render(page, {})
  findButton(tree, '确认运行').props.onClick()
  await tick()
  tree = await react.render(page, {})
  const text = collectText(tree).join(' ')
  assert.match(text, /命令未被受理/)
  assert.match(text, /需要重启应用/)
})

test('没有 remote.commands → 结果区给明确提示（不崩）', async () => {
  const react = createReactStub()
  const files = { 's1|.dsh/loop/project.json': PROJECT, 's1|.dsh/loop/state.json': STATE }
  const { page } = mount(react, {
    sessions: [session('s1', 'E:/proj-b', 1000)],
    files,
    noCommands: true,
  })
  let tree = await react.render(page, {})
  findButton(tree, '关闭').props.onClick()
  tree = await react.render(page, {})
  findButton(tree, '确认运行').props.onClick()
  await tick()
  tree = await react.render(page, {})
  const text = collectText(tree).join(' ')
  assert.match(text, /没有 remote\.commands/)
})

test('取消运行：abort 信号传给命令通道，结果区标已取消', async () => {
  const react = createReactStub()
  const files = { 's1|.dsh/loop/project.json': PROJECT, 's1|.dsh/loop/state.json': STATE }
  const { page, commandsCalls } = mount(react, {
    sessions: [session('s1', 'E:/proj-b', 1000)],
    files,
    hangCommands: true,
  })
  let tree = await react.render(page, {})
  findButton(tree, '关闭').props.onClick()
  tree = await react.render(page, {})
  findButton(tree, '确认运行').props.onClick()
  await tick()
  tree = await react.render(page, {})

  const runningText = collectText(tree).join(' ')
  assert.match(runningText, /正在运行：切到关闭（off）/)
  const cancelBtn = findButton(tree, '取消')
  assert.ok(cancelBtn, '运行中应给取消按钮')
  cancelBtn.props.onClick()

  tree = await react.render(page, {})
  const text = collectText(tree).join(' ')
  assert.match(text, /已取消/)
  assert.equal(commandsCalls.length, 1)
  assert.equal(commandsCalls[0].signal.aborted, true, '取消应 abort 传给命令通道的信号')
})
