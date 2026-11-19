// 兜底路径验证：沙箱里**不放** @deepseek-ai/dsh-llm 桩，
// 插件必须走「手工构造 UserMessage」而不是整行不激活。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_SRC = path.resolve(HERE, '..', 'index.js')
const ACTIONS_SRC = path.resolve(HERE, '..', 'actions.js')

test('无 dsh-llm 可解析时：回退手工构造，仍能注入且消息形状正确', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-nostub-'))
  const pluginDir = path.join(sandbox, 'plugin')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.copyFileSync(PLUGIN_SRC, path.join(pluginDir, 'index.js'))
  // index.js 现在静态 import './actions.js'，夹具要一并拷进去
  fs.copyFileSync(ACTIONS_SRC, path.join(pluginDir, 'actions.js'))
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ type: 'module' }))
  // 关键：不创建 node_modules/@deepseek-ai/dsh-llm

  const { apply } = await import(pathToFileURL(path.join(pluginDir, 'index.js')).href)

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-nostub-ws-'))
  fs.mkdirSync(path.join(cwd, '.dsh', 'loop'), { recursive: true })
  fs.writeFileSync(path.join(cwd, '.dsh', 'loop', 'project.json'), JSON.stringify({ name: 'p', mode: 'on' }))
  fs.writeFileSync(path.join(cwd, '.dsh', 'loop', 'state.json'), JSON.stringify({ mode: 'on', stage: 'WIRE' }))

  const service = {
    async resolve(p, opts) { return { path: path.isAbsolute(p) ? p : path.resolve((opts && opts.cwd) || cwd, p) } },
    async stat(t) {
      try {
        const st = fs.statSync(t.path)
        return { type: st.isDirectory() ? 'directory' : 'file' }
      } catch { return undefined }
    },
    async readText(t) { return fs.readFileSync(t.path, 'utf8') },
    async writeText(t, c) { fs.writeFileSync(t.path, c); return {} },
  }
  const handlers = new Map()
  const warnings = []
  const ctx = {
    get: (k) => (k === 'fs' ? service : undefined),
    workingDirectory: { ensure: async () => cwd },
    logger: { info() {}, warn: (...a) => warnings.push(a.join(' ')) },
    on: (e, h) => handlers.set(e, h),
    inject: (keys, cb) => { cb({ effect: (fn) => { fn() }, commands: { register() {} } }) },
  }
  apply(ctx, {})

  const USER = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }
  const agent = { session: { header: { id: 's1' }, surface: { nodes: [] }, eventAt() {} } }
  const out = await handlers.get('agent/pre-step')(
    { agent, messages: [USER], turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages: [USER] }),
  )
  const ours = out.messages.filter((m) => m.source && m.source.kind === 'capability-loop')
  assert.equal(ours.length, 1, '回退路径也必须注入')
  const msg = ours[0]
  assert.equal(msg.role, 'user')
  assert.equal(typeof msg.id, 'string')
  assert.ok(msg.id.length > 0, 'id 非空')
  assert.equal(msg.content[0].type, 'text')
  assert.match(msg.content[0].text, /硬约束/)
  assert.ok(Object.isFrozen(msg), '消息应被冻结')
  assert.ok(warnings.some((w) => w.includes('回退') || w.includes('无法解析')), '应记录降级日志')
})
