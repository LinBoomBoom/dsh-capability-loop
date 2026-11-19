// 接管插件回归夹具（node --test）。
//
// 为什么不直接 import ../index.js：插件在真实运行时从 dsh 安装解析
// `@deepseek-ai/dsh-llm`，而仓库里没有 node_modules。所以本测试先在临时目录
// 搭一份「插件副本 + dsh-llm 桩」，再从那里 import，等价于真实解析路径。
//
// 运行：node --test plugins/capability-loop/test/takeover.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_SRC = path.resolve(HERE, '..', 'index.js')
const ACTIONS_SRC = path.resolve(HERE, '..', 'actions.js')

/** 搭临时沙箱：<tmp>/plugin/index.js + <tmp>/node_modules/@deepseek-ai/dsh-llm（桩）。 */
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-sandbox-'))
  const pluginDir = path.join(root, 'plugin')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.copyFileSync(PLUGIN_SRC, path.join(pluginDir, 'index.js'))
  // index.js 现在静态 import './actions.js'，夹具要一并拷进去
  fs.copyFileSync(ACTIONS_SRC, path.join(pluginDir, 'actions.js'))
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ type: 'module' }))

  const stubDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-llm')
  fs.mkdirSync(stubDir, { recursive: true })
  fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-llm',
    version: '0.0.0-test-stub',
    type: 'module',
    main: 'index.js',
    exports: { '.': './index.js' },
  }))
  fs.writeFileSync(path.join(stubDir, 'index.js'), [
    'let nextId = 0',
    'export function createUserMessage(input) {',
    "  nextId += 1",
    "  return Object.freeze({ id: 'msg-' + nextId, role: 'user', content: input.content, source: input.source })",
    '}',
    '',
  ].join('\n'))
  return { root, pluginUrl: pathToFileURL(path.join(pluginDir, 'index.js')).href }
}

const sandbox = makeSandbox()
const { apply } = await import(sandbox.pluginUrl)

/** 建一个已标记/未标记的工作区。 */
function makeWorkspace({ project, state, rawState } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ws-'))
  const loop = path.join(root, '.dsh', 'loop')
  fs.mkdirSync(loop, { recursive: true })
  if (project !== undefined) fs.writeFileSync(path.join(loop, 'project.json'), JSON.stringify(project, null, 2))
  if (state !== undefined) fs.writeFileSync(path.join(loop, 'state.json'), JSON.stringify(state, null, 2))
  if (rawState !== undefined) fs.writeFileSync(path.join(loop, 'state.json'), rawState)
  return root
}

/** 最小 ctx：只实现插件用到的 get('fs') / workingDirectory.ensure / on / logger。 */
function makeCtx(cwd, fsOverride) {
  const fsService = fsOverride || {
    async resolve(p, opts) {
      return { path: path.isAbsolute(p) ? p : path.resolve((opts && opts.cwd) || cwd, p) }
    },
    async stat(target) {
      try {
        const st = fs.statSync(target.path)
        return { type: st.isDirectory() ? 'directory' : 'file', size: st.size }
      } catch {
        return undefined
      }
    },
    async readText(target) {
      return fs.readFileSync(target.path, 'utf8')
    },
    async writeText(target, content) {
      fs.mkdirSync(path.dirname(target.path), { recursive: true })
      fs.writeFileSync(target.path, content)
      return { version: 1 }
    },
  }
  const handlers = new Map()
  const registered = []
  return {
    handlers,
    registered,
    get: (key) => (key === 'fs' ? fsService : undefined),
    workingDirectory: { ensure: async () => cwd },
    logger: { info() {}, warn() {} },
    on: (event, handler) => { handlers.set(event, handler) },
    // 真实 ctx 一定有 inject；命令注册会在这里被收集，便于夹具断言。
    inject: (keys, cb) => {
      const scoped = {
        effect: (fn) => { fn() },
        commands: { register: (definition) => registered.push(definition) },
      }
      cb(scoped)
    },
  }
}

function makeAgent(cwd) {
  const events = []
  return {
    session: {
      header: cwd === undefined ? { id: 'sess-1' } : { id: 'sess-1', cwd },
      surface: { nodes: [] },
      eventAt(seq) { return events[seq] },
    },
    push(event) {
      events.push(event)
      this.session.surface.nodes.push(events.length - 1)
    },
  }
}

const USER = { id: 'u1', role: 'user', content: [{ type: 'text', text: '帮我改一版页面' }], source: { kind: 'user' } }

/** 跑一次 pre-step；history 用于模拟 resume 后已有的会话事件。 */
async function preStep(ctx, agent, { history = [] } = {}) {
  for (const event of history) agent.push(event)
  const handler = ctx.handlers.get('agent/pre-step')
  assert.equal(typeof handler, 'function', '应注册 agent/pre-step')
  return handler(
    { agent, messages: [USER], turn: 1, step: 1, signal: undefined },
    async () => ({ kind: 'enter', messages: [USER] }),
  )
}

const ours = (decision) => decision.messages.filter((m) => m.source && m.source.kind === 'capability-loop')

// ---------------- 三档 ----------------

test('未标记工程：零注入', async () => {
  const ctx = makeCtx(makeWorkspace({}))
  apply(ctx, { defaultMode: 'on' })
  const out = await preStep(ctx, makeAgent())
  assert.equal(ours(out).length, 0)
})

test('off 档：标记了也不注入', async () => {
  const ctx = makeCtx(makeWorkspace({
    project: { name: 'p', mode: 'off' },
    state: { mode: 'off', stage: 'WIRE' },
  }))
  apply(ctx, { defaultMode: 'on' })
  const out = await preStep(ctx, makeAgent())
  assert.equal(ours(out).length, 0)
})

test('shadow 档：一行提示、不阻断、写影子日志且同会话只记一次', async () => {
  const cwd = makeWorkspace({
    project: { name: 'p', mode: 'shadow' },
    state: { mode: 'shadow', stage: 'WIRE', next: { label: '补 design-context', command: '' } },
  })
  const ctx = makeCtx(cwd)
  apply(ctx, { shadowLog: true })
  const out = await preStep(ctx, makeAgent())
  const injected = ours(out)
  assert.equal(injected.length, 1)
  assert.equal(injected[0].source.mode, 'shadow')
  const text = injected[0].content[0].text
  assert.match(text, /影子/)
  assert.match(text, /不阻断/)
  assert.ok(text.length <= 140, '影子提示应 ≤140 字符，实际 ' + text.length)

  const logPath = path.join(cwd, '.dsh', 'loop', 'shadow-log.jsonl')
  assert.ok(fs.existsSync(logPath), '影子日志应写入')
  await preStep(ctx, makeCtx(cwd))
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1, '同一会话只记一行')
})

test('on 档：契约含阶段/门禁/阻断/下一步，长度在预算内', async () => {
  const cwd = makeWorkspace({
    project: { name: '气量平衡月表', mode: 'on' },
    state: {
      mode: 'on',
      skillVersion: '2.10.0',
      stage: 'WIRE',
      checks: {
        design: { status: 'FAIL' },
        grill: { status: 'MISSING' },
        'environment-audit': { status: 'WARN' },
      },
      blockers: [{ id: 'D-01', text: '缺 1440 截图', owner: 'lead' }],
      next: { label: '补 design-context 后重跑设计门', command: 'loop-gate -Kind design' },
    },
  })
  const ctx = makeCtx(cwd)
  apply(ctx, { maxContractChars: 1600 })
  const out = await preStep(ctx, makeAgent())
  const injected = ours(out)
  assert.equal(injected.length, 1)
  const text = injected[0].content[0].text
  assert.match(text, /WIRE/)
  assert.match(text, /第 4\/7 阶段/)
  assert.match(text, /设计门=FAIL/)
  assert.match(text, /grill=MISSING/)
  assert.match(text, /能力体检=WARN/)
  assert.match(text, /D-01 缺 1440 截图/)
  assert.match(text, /loop-gate -Kind design/)
  assert.ok(text.length <= 1600, '契约应 ≤1600 字符，实际 ' + text.length)
  assert.ok(text.length >= 600, '契约不应过短，实际 ' + text.length)
})

// ---------------- 位置与去重 ----------------

test('注入位置：紧跟本步认领的用户消息之后', async () => {
  const ctx = makeCtx(makeWorkspace({ project: { name: 'p', mode: 'on' }, state: { mode: 'on', stage: 'GATE' } }))
  apply(ctx, {})
  const out = await preStep(ctx, makeAgent())
  assert.equal(out.messages[0], USER, '第一条仍是用户消息')
  assert.equal(out.messages[1].source.kind, 'capability-loop', '注入紧跟其后')
})

test('resume 去重：历史已有同 digest 则不再注入', async () => {
  const ctx = makeCtx(makeWorkspace({
    project: { name: 'p', mode: 'on' },
    state: { mode: 'on', skillVersion: '2.10.0', stage: 'WIRE' },
  }))
  apply(ctx, {})
  const first = await preStep(ctx, makeAgent())
  const injected = ours(first)[0]
  assert.ok(injected, '首次应注入')
  // 新进程 + 历史里已有：只能靠会话历史判定
  const resumed = await preStep(ctx, makeAgent(), { history: [{ type: 'user/message', data: injected }] })
  assert.equal(ours(resumed).length, 0, '历史已有则跳过')
})

test('同批已有同 digest：不重复插入', async () => {
  const ctx = makeCtx(makeWorkspace({ project: { name: 'p', mode: 'on' }, state: { mode: 'on', stage: 'WIRE' } }))
  apply(ctx, {})
  const agent = makeAgent()
  const first = await preStep(ctx, agent)
  const injected = ours(first)[0]
  const handler = ctx.handlers.get('agent/pre-step')
  const out = await handler(
    { agent, messages: [USER], turn: 1, step: 2, signal: undefined },
    async () => ({ kind: 'enter', messages: [USER, injected] }),
  )
  assert.equal(ours(out).length, 1, '仍只有那一条')
})

// ---------------- 降级 ----------------

test('fail-open：fs 抛错也不影响决策', async () => {
  const cwd = makeWorkspace({ project: { name: 'p', mode: 'on' }, state: { mode: 'on', stage: 'WIRE' } })
  const ctx = makeCtx(cwd, {
    resolve() { throw new Error('boom') },
    stat() { throw new Error('boom') },
    readText() { throw new Error('boom') },
    writeText() { throw new Error('boom') },
  })
  apply(ctx, {})
  const out = await preStep(ctx, makeAgent())
  assert.equal(out.kind, 'enter')
  assert.equal(out.messages.length, 1, '未注入、原样返回')
})

test('state 坏 JSON：降级为最小契约（不崩）', async () => {
  const cwd = makeWorkspace({ project: { name: 'p', mode: 'on' }, rawState: '{ this is not json' })
  const ctx = makeCtx(cwd)
  apply(ctx, {})
  const out = await preStep(ctx, makeAgent())
  const injected = ours(out)
  assert.equal(injected.length, 1)
  const text = injected[0].content[0].text
  assert.match(text, /INTAKE/, '坏 JSON 时按 INTAKE 兜底')
  assert.match(text, /硬约束/)
})

test('未标记但有 defaultMode=on：仍不注入（标记是前提）', async () => {
  const ctx = makeCtx(makeWorkspace({}))
  apply(ctx, { defaultMode: 'on' })
  const out = await preStep(ctx, makeAgent())
  assert.equal(ours(out).length, 0)
})

// ---------------- 命令通道（面板动作的 Host 半边） ----------------

test('命令通道：注册 capability-loop，带输入提示', async () => {
  const ctx = makeCtx(makeWorkspace({}))
  apply(ctx, {})
  assert.equal(ctx.registered.length, 1, '只注册一个会话命令')
  const definition = ctx.registered[0]
  assert.equal(definition.name, 'capability-loop')
  assert.match(definition.description, /门禁/)
  assert.match(definition.input.hint, /run gate/)
})

test('命令通道：空输入给用法；未知动作、缺 subprocess 都回 error 文本', async () => {
  const cwd = makeWorkspace({})
  const ctx = makeCtx(cwd)
  apply(ctx, {})
  const definition = ctx.registered[0]

  const usage = await definition.handler({ agent: makeAgent(cwd), rawInput: '' })
  assert.equal(usage.kind, 'success')
  assert.match(usage.text, /用法/)

  const unknown = await definition.handler({ agent: makeAgent(cwd), rawInput: 'rm -rf /' })
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /未知动作/)

  const noSubprocess = await definition.handler({ agent: makeAgent(cwd), rawInput: 'run audit' })
  assert.equal(noSubprocess.kind, 'error')
  assert.match(noSubprocess.text, /ctx\.subprocess/)
})

test('命令通道：拿不到会话 cwd 时不猜进程目录，直接报错', async () => {
  const ctx = makeCtx(makeWorkspace({}))
  apply(ctx, {})
  const definition = ctx.registered[0]
  const out = await definition.handler({ agent: makeAgent(), rawInput: 'run audit' })
  assert.equal(out.kind, 'error')
  assert.match(out.text, /拿不到会话工作目录/)
})

test('命令通道：aborted 信号回「已取消」', async () => {
  const cwd = makeWorkspace({})
  const ctx = makeCtx(cwd)
  apply(ctx, {})
  const definition = ctx.registered[0]
  const controller = new AbortController()
  controller.abort()
  const out = await definition.handler({ agent: makeAgent(cwd), rawInput: 'run audit', signal: controller.signal })
  assert.equal(out.kind, 'error')
  assert.match(out.text, /已取消/)
})
