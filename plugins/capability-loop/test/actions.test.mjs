// 运行中心（actions.js）夹具：验证白名单、参数校验、argv 构造、输出裁剪。
// 不真跑脚本（真机由 panel 触发的命令覆盖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const ACTIONS = pathToFileURL(path.resolve(HERE, '..', 'actions.js')).href
const { executeAction } = await import(ACTIONS)

/** 假 fs：只回 resolve/stat/listDir，用来验证 skillDir 解析。 */
function makeFs(skillDir) {
  return {
    async resolve(target, options) {
      const abs = path.isAbsolute(target) ? target : path.resolve((options && options.cwd) || process.cwd(), target)
      return { path: abs }
    },
    async stat(target) {
      if (target.path === skillDir) return { type: 'directory' }
      if (target.path === path.join(skillDir, 'scripts', 'loop-state.ps1')) return { type: 'file' }
      return undefined
    },
    async listDir() { return [] },
  }
}

/** 假 subprocess：记录 spawn 请求，回放预设结果。 */
function makeSubprocess(record, outcome) {
  return {
    async resolveExecutable(name) { return name === 'powershell' ? 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : name },
    spawn(request) {
      record.push(request)
      const text = outcome === undefined ? 'line-1\nline-2 exit ok' : outcome.output
      const exitCode = outcome === undefined ? 0 : outcome.exitCode
      const fail = outcome !== undefined && outcome.spawnError !== undefined
      if (fail) throw new Error(outcome.spawnError)
      return {
        done: Promise.resolve({ exitCode, signal: null }),
        collected: {
          stdout: { readFrom() { return text } },
          stderr: { readFrom() { return '' } },
        },
      }
    },
  }
}

const SKILL = path.join(os.tmpdir(), 'cl-skill-' + Date.now())
const WS = path.join(os.tmpdir(), 'cl-ws-' + Date.now())

function makeCtx(record, outcome) {
  const services = { fs: makeFs(SKILL), subprocess: makeSubprocess(record, outcome) }
  return { get(name) { return services[name] } }
}

const CFG = { skillDir: SKILL, workspaceRoot: WS, pythonExecutable: '' }

test('空输入 → 返回用法（success）', async () => {
  const record = []
  const out = await executeAction(makeCtx(record), CFG, '')
  assert.equal(out.ok, true)
  assert.match(out.text, /用法/)
  assert.equal(record.length, 0)
})

test('未知动作 → 错误 + 用法', async () => {
  const out = await executeAction(makeCtx([]), CFG, 'rm -rf /')
  assert.equal(out.ok, false)
  assert.match(out.text, /未知动作/)
})

test('gate：argv 含 Workspace/Kind/TaskDir/RequireGrill，结果回尾部输出', async () => {
  const record = []
  const out = await executeAction(makeCtx(record), CFG, 'run gate kind=design taskDir=docs/design grill=1')
  assert.equal(out.ok, true)
  assert.equal(record.length, 1)
  const argv = record[0].argv
  assert.equal(argv[0], 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
  assert.ok(argv.includes('-File'))
  assert.ok(argv.some((a) => a.endsWith('loop-gate.ps1')))
  assert.deepEqual(argv.slice(argv.indexOf('-Workspace'), argv.indexOf('-Workspace') + 2), ['-Workspace', WS])
  assert.deepEqual(argv.slice(argv.indexOf('-Kind'), argv.indexOf('-Kind') + 2), ['-Kind', 'design'])
  assert.ok(argv.includes('-TaskDir') && argv.includes('docs/design'))
  assert.ok(argv.includes('-RequireGrill'))
  assert.match(out.text, /\[门禁\] PASS/)
  assert.match(out.text, /line-2 exit ok/)
  assert.equal(record[0].cwd, WS)
})

test('gate：非法 kind 拒绝', async () => {
  const out = await executeAction(makeCtx([]), CFG, 'run gate kind=whatever')
  assert.equal(out.ok, false)
  assert.match(out.text, /kind 只能是/)
})

test('gate：taskDir 带 .. 被当作非法（不进入 argv）', async () => {
  const record = []
  await executeAction(makeCtx(record), CFG, 'run gate kind=test taskDir=../../etc')
  const argv = record[0].argv
  assert.equal(argv.includes('-TaskDir'), false, '非法 taskDir 不应进入 argv')
})

test('audit：带 -Workspace', async () => {
  const record = []
  await executeAction(makeCtx(record), CFG, 'run audit')
  const argv = record[0].argv
  assert.ok(argv.some((a) => a.endsWith('capability-audit.ps1')))
  assert.deepEqual(argv.slice(argv.indexOf('-Workspace'), argv.indexOf('-Workspace') + 2), ['-Workspace', WS])
})

test('mode：走 loop-state.ps1 -Action set-mode', async () => {
  const record = []
  const out = await executeAction(makeCtx(record), CFG, 'mode on')
  assert.equal(out.ok, true)
  const argv = record[0].argv
  assert.ok(argv.some((a) => a.endsWith('loop-state.ps1')))
  assert.deepEqual(argv.slice(argv.indexOf('-Action'), argv.indexOf('-Action') + 2), ['-Action', 'set-mode'])
  assert.deepEqual(argv.slice(argv.indexOf('-Mode'), argv.indexOf('-Mode') + 2), ['-Mode', 'on'])
  assert.match(out.text, /\[切档位\]/)
})

test('mode：非法值拒绝', async () => {
  const out = await executeAction(makeCtx([]), CFG, 'mode everywhere')
  assert.equal(out.ok, false)
  assert.match(out.text, /on\|shadow\|off/)
})

test('sync-shadow：走 loop-state.ps1 -Action sync-shadow', async () => {
  const record = []
  await executeAction(makeCtx(record), CFG, 'run sync-shadow')
  const argv = record[0].argv
  assert.deepEqual(argv.slice(argv.indexOf('-Action'), argv.indexOf('-Action') + 2), ['-Action', 'sync-shadow'])
})

test('pack：handle 过滤非法字符', async () => {
  const record = []
  await executeAction(makeCtx(record), CFG, 'run pack handle=my-handle')
  const argv = record[0].argv
  assert.ok(argv.includes('-Handle') && argv.includes('my-handle'))
  assert.ok(argv.includes('-SkillRoot'))
})

test('handoff-audit：默认 workspace 用工程根', async () => {
  const record = []
  await executeAction(makeCtx(record), CFG, 'run handoff-audit slug=gas-ui')
  const argv = record[0].argv
  assert.ok(argv.some((a) => a.endsWith('handoff-audit.py')))
  assert.deepEqual(argv.slice(argv.indexOf('--workspace'), argv.indexOf('--workspace') + 2), ['--workspace', WS])
  assert.deepEqual(argv.slice(argv.indexOf('--slug'), argv.indexOf('--slug') + 2), ['--slug', 'gas-ui'])
})

test('handoff-audit：缺 slug 拒绝', async () => {
  const out = await executeAction(makeCtx([]), CFG, 'run handoff-audit')
  assert.equal(out.ok, false)
  assert.match(out.text, /slug=/)
})

test('非零退出 → FAIL 结果文本带 exit 码', async () => {
  const out = await executeAction(makeCtx([], { output: 'boom', exitCode: 1 }), CFG, 'run gate kind=design')
  assert.equal(out.ok, false)
  assert.match(out.text, /\[门禁\] FAIL（exit 1）/)
  assert.match(out.text, /boom/)
})

test('spawn 抛错 → 文本说明，不崩', async () => {
  const out = await executeAction(makeCtx([], { spawnError: 'nope' }), CFG, 'run audit')
  assert.equal(out.ok, false)
})

test('找不到 skill 目录 → 明确提示', async () => {
  const ctx = { get(name) { return name === 'fs' ? { async resolve(p) { return { path: p } }, async stat() { return undefined }, async listDir() { return [] } } : undefined } }
  const out = await executeAction(ctx, { skillDir: '', workspaceRoot: WS }, 'run audit')
  assert.equal(out.ok, false)
  assert.match(out.text, /找不到 skill 目录/)
})

test('没有 subprocess 服务 → 明确提示', async () => {
  const ctx = { get(name) { return name === 'fs' ? makeFs(SKILL) : undefined } }
  const out = await executeAction(ctx, CFG, 'run audit')
  assert.equal(out.ok, false)
  assert.match(out.text, /ctx\.subprocess/)
})

test('已 abort 的信号 → 不启动子进程，回「已取消」', async () => {
  const record = []
  const controller = new AbortController()
  controller.abort()
  const out = await executeAction(makeCtx(record), CFG, 'run audit', controller.signal)
  assert.equal(out.ok, false)
  assert.match(out.text, /已取消/)
  assert.equal(record.length, 0, '不应 spawn')
})
