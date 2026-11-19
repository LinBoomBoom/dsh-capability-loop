/**
 * dsh-capability-loop-bundle — 控制台（client half）
 *
 * 在侧边栏注册一个全局面板「能力闭环」，只读展示 `.dsh/loop/state.json`：
 * 档位 / 阶段 / 门禁 / 阻断 / 下一步。数据经 `GET /api/file?path=` 读取
 * （已认证的 connection 通道，不需要会话），不写任何文件。
 *
 * 依据（已核源码/README，DSH 0.2.2-rc.3）：
 *   - client 产物格式：dsh-doc `templates/decoration/client.js`（`window.__ModuleLoader__.load`）
 *   - 面板注册：`sidebar.panellist`（id/order/label/icon）+ `main`（同名 key）
 *   - 读文件通道：`dsh-api-session-controller` README §SessionMediaReferences —
 *     `GET|HEAD /api/file?path=<absolute path>`，`connection.fetch(request, peer)` +
 *     `ctx.connection.browserPeer`
 *   - `$host.home`：`dsh-api-gateway` README §Client service（`ctx.remote.$host`）
 */
window.__ModuleLoader__.load({
  id: 'dsh-capability-loop-bundle',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** apply() 收到的插件 ctx；面板据此读服务（不依赖 slot props 形状）。 */
    let pluginCtx

    const PANEL_ID = 'capability-loop'
    const STAGE_ORDER = ['INTAKE', 'AUDIT', 'FIX', 'WIRE', 'HANDOFF', 'GRILL', 'GATE']
    const CHECK_LABEL = {
      design: '设计门',
      requirement: '需求门',
      test: '测试门',
      handoff: '交接体检',
      grill: 'grill',
      environment: '环境验收',
      'environment-audit': '能力体检',
    }

    // ---------- 样式（只用主题 token，不新增色值） ----------
    const S = {
      page: {
        height: '100%', overflow: 'auto', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)', padding: '22px 40px 40px',
      },
      inner: { maxWidth: 960, margin: '0 auto' },
      head: { display: 'flex', alignItems: 'flex-start', gap: 16 },
      h1: { margin: 0, fontSize: 20, fontWeight: 600, lineHeight: 1.35, letterSpacing: '-0.2px' },
      sub: {
        margin: '7px 0 0', fontSize: 13, color: 'var(--dsw-alias-label-tertiary)',
        display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
      },
      dotsep: { color: 'var(--dsw-alias-label-caption)' },
      kpis: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginTop: 18 },
      kpi: {
        background: 'var(--dsw-alias-card-fill)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-md)', padding: '11px 14px', minHeight: 68,
        display: 'flex', flexDirection: 'column', gap: 5,
      },
      kpiK: { fontSize: 11, color: 'var(--dsw-alias-label-caption)' },
      kpiV: { fontSize: 18, fontWeight: 600, lineHeight: 1.1, display: 'flex', alignItems: 'baseline', gap: 5 },
      kpiM: { marginTop: 'auto', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.3 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-card-fill)', overflow: 'hidden', marginTop: 14,
      },
      cardHd: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px 9px',
        fontSize: 13, fontWeight: 600,
      },
      hint: { marginLeft: 'auto', fontSize: 11, fontWeight: 400, color: 'var(--dsw-alias-label-caption)' },
      row: {
        display: 'flex', alignItems: 'center', gap: 10, minHeight: 38, padding: '6px 14px',
        borderTop: '1px solid var(--dsw-alias-border-l1)', fontSize: 12,
      },
      name: { width: 112, color: 'var(--dsw-alias-label-primary)' },
      meta: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
      right: { marginLeft: 'auto', color: 'var(--dsw-alias-label-caption)', fontSize: 11 },
      badge: {
        display: 'inline-flex', alignItems: 'center', gap: 5, height: 20, padding: '0 7px',
        borderRadius: 5, fontSize: 10, fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
      },
      track: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, padding: '4px 14px 14px' },
      stage: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, fontSize: 12 },
      node: {
        width: 18, height: 18, borderRadius: '50%', display: 'grid', placeItems: 'center',
        fontSize: 9, fontWeight: 600, border: '1px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-caption)',
      },
      stageName: { color: 'var(--dsw-alias-label-secondary)' },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)', fontSize: 12, borderRadius: 6,
        padding: '7px 10px', cursor: 'pointer',
      },
      select: {
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)', fontSize: 12, borderRadius: 6, padding: '6px 8px',
      },
      empty: { textAlign: 'center', padding: '56px 0 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 },
      mono: { fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 11 },
    }

    function statusColor(status) {
      if (status === 'PASS') return 'var(--dsw-alias-state-success-primary)'
      if (status === 'WARN') return 'var(--dsw-alias-state-warn-primary)'
      if (status === 'FAIL') return 'var(--dsw-alias-state-error-primary)'
      return 'var(--dsw-alias-label-caption)'
    }

    function Badge(props) {
      const status = props.status === undefined ? 'MISSING' : String(props.status)
      const color = statusColor(status)
      const missing = status === 'MISSING' || status === ''
      return h('span', {
        style: {
          ...S.badge,
          background: missing ? 'transparent' : 'color-mix(in srgb, ' + color + ' 10%, transparent)',
          border: missing ? '1px dashed var(--dsw-alias-border-l3)' : 'none',
          color: missing ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-primary)',
        },
      },
        h('span', {
          style: { width: 5, height: 5, borderRadius: '50%', background: missing ? 'var(--dsw-alias-label-caption)' : color },
        }),
        status === 'MISSING' || status === '' ? '未运行' : status,
      )
    }

    // ---------- 数据 ----------
    // 主通道：`ctx.remote.session.list` 拿会话（含 cwd）→ `workspaceFiles.read(sessionId, 相对路径)`
    // 读 `<cwd>/.dsh/loop/{project,state}.json`。相对路径自动落在该会话的工作区根，
    // 因此不需要知道 DSH home，也不需要 `/api/file`（桌面壳的渲染器不是 http 源，走不通）。
    // 备通道：浏览器里若 `connection.fetch` 存在，退回 `/api/file?path=`。
    let lastDiagnostic = ''
    function recordDiagnostic(text) {
      const value = String(text || '')
      if (value !== '') lastDiagnostic = value
    }

    function unwrap(result) {
      if (result === null || result === undefined) return undefined
      if (typeof result === 'object' && 'ok' in result) return result.ok === true ? result.value : undefined
      return result
    }

    function joinPath(base, rel) {
      const trimmed = String(base).replace(/[\\/]+$/, '')
      return trimmed.replace(/\\/g, '/') + '/' + rel
    }

    /** 用某个会话的身份读工作区相对路径；读不到返回 null。 */
    async function readJsonViaSession(filesNamespace, sessionId, relPath) {
      let result
      try {
        result = await filesNamespace.read(sessionId, relPath, {}, undefined)
      } catch (error) {
        recordDiagnostic('workspaceFiles.read 抛错（' + relPath + '）：' + String(error && error.message ? error.message : error))
        return null
      }
      const value = unwrap(result)
      if (value === undefined || typeof value.text !== 'string') return null
      try {
        return JSON.parse(value.text)
      } catch {
        recordDiagnostic('非 JSON：' + relPath)
        return null
      }
    }

    /** 备通道：/api/file?path=（仅当 connection.fetch 存在，例如普通浏览器载体）。 */
    async function readJsonViaFileApi(ctx, absPath) {
      const connection = ctx.get('connection')
      if (connection === undefined || connection === null || typeof connection.fetch !== 'function') return null
      const peer = connection.browserPeer
      const query = '/api/file?path=' + encodeURIComponent(absPath)
      const candidates = [query]
      try {
        const origin = typeof location !== 'undefined' && location.origin ? location.origin : ''
        if (origin !== '' && origin !== 'null' && origin.indexOf('http') === 0) {
          candidates.push(origin.replace(/\/+$/, '') + query)
        }
      } catch {
        // 没有 location 就只走相对路径
      }
      for (const url of candidates) {
        let response
        try {
          response = await connection.fetch(url, peer)
        } catch (error) {
          recordDiagnostic('fetch 抛错 ' + url + '：' + String(error && error.message ? error.message : error))
          continue
        }
        if (response === undefined || response === null || !response.ok) {
          recordDiagnostic('HTTP ' + (response === undefined || response === null ? '?' : response.status) + ' ' + url)
          continue
        }
        try {
          return JSON.parse(await response.text())
        } catch (error) {
          recordDiagnostic('响应不是 JSON：' + String(error && error.message ? error.message : error))
        }
      }
      return null
    }

    /** 收集所有「已接入」工程；按会话最近使用排序。 */
    async function collect(ctx) {
      const remote = ctx.get('remote')
      const sessionNamespace = remote !== undefined && remote !== null ? remote.session : undefined
      const filesNamespace = remote !== undefined && remote !== null ? remote.workspaceFiles : undefined

      if (sessionNamespace === undefined || typeof sessionNamespace.list !== 'function'
        || filesNamespace === undefined || typeof filesNamespace.read !== 'function') {
        recordDiagnostic('当前 composition 没有 remote.session / remote.workspaceFiles，面板暂时读不到状态')
        return { projects: [] }
      }

      let listResult
      try {
        listResult = await sessionNamespace.list({})
      } catch (error) {
        recordDiagnostic('session.list 失败：' + String(error && error.message ? error.message : error))
        return { projects: [] }
      }
      const listed = unwrap(listResult)
      const items = listed !== undefined && Array.isArray(listed.items) ? listed.items : []
      if (items.length === 0) {
        recordDiagnostic('还没有任何会话（面板需要一个会话作为读取凭据）')
        return { projects: [] }
      }

      // 每个工作区取最近的一个会话作为读取凭据
      const byWorkspace = new Map()
      for (const item of items) {
        if (item === null || item === undefined) continue
        const cwd = typeof item.cwd === 'string' && item.cwd !== '' ? item.cwd : ''
        if (cwd === '') continue
        const previous = byWorkspace.get(cwd)
        const stamp = typeof item.updatedAt === 'number' ? item.updatedAt : 0
        if (previous === undefined || stamp > previous.stamp) {
          byWorkspace.set(cwd, { cwd, sessionId: item.sessionId, stamp })
        }
      }
      const workspaces = Array.from(byWorkspace.values()).sort((a, b) => b.stamp - a.stamp).slice(0, 12)

      const projects = []
      for (const workspace of workspaces) {
        const project = await readJsonViaSession(filesNamespace, workspace.sessionId, '.dsh/loop/project.json')
        if (project === null) continue
        const state = await readJsonViaSession(filesNamespace, workspace.sessionId, '.dsh/loop/state.json')
        projects.push({
          workspace: { id: workspace.cwd, path: workspace.cwd, title: typeof project.name === 'string' && project.name !== '' ? project.name : workspace.cwd },
          project,
          state,
        })
      }
      if (projects.length === 0 && lastDiagnostic === '') {
        recordDiagnostic('读了 ' + workspaces.length + ' 个工作区，都没有 .dsh/loop/project.json（未接入）')
      }
      return { projects }
    }

    /** 备通道入口：把工作区列表换成 state（仅在 remote.session 不可用时使用）。 */
    async function collectViaFileApi(ctx) {
      const remote = ctx.get('remote')
      const home = remote !== undefined && remote !== null && remote.$host !== undefined ? remote.$host.home : undefined
      if (typeof home !== 'string' || home === '') {
        recordDiagnostic('拿不到 Host home，无法定位 workspace.json')
        return { projects: [] }
      }
      const workspaceFile = await readJsonViaFileApi(ctx, joinPath(home, 'storages/workspace.json'))
      const table = workspaceFile !== null && workspaceFile.tables !== undefined ? workspaceFile.tables.workspaces : undefined
      if (table === undefined || table === null || typeof table !== 'object') return { projects: [] }
      const rows = []
      for (const id of Object.keys(table)) {
        const row = table[id]
        if (row === null || row === undefined || typeof row.path !== 'string') continue
        rows.push({ id, path: row.path, title: typeof row.title === 'string' ? row.title : row.path, updatedAt: String(row.updatedAt || '') })
      }
      rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      const projects = []
      for (const workspace of rows.slice(0, 12)) {
        const project = await readJsonViaFileApi(ctx, joinPath(workspace.path, '.dsh/loop/project.json'))
        if (project === null) continue
        const state = await readJsonViaFileApi(ctx, joinPath(workspace.path, '.dsh/loop/state.json'))
        projects.push({ workspace, project, state })
      }
      return { projects }
    }

    async function collectAny(ctx) {
      const remote = ctx.get('remote')
      const hasSessionRemote = remote !== undefined && remote !== null
        && remote.session !== undefined && typeof remote.session.list === 'function'
        && remote.workspaceFiles !== undefined && typeof remote.workspaceFiles.read === 'function'
      if (hasSessionRemote) return collect(ctx)
      return collectViaFileApi(ctx)
    }
    function stageIndexOf(state) {
      const stage = state !== null && state !== undefined && typeof state.stage === 'string' ? state.stage : 'INTAKE'
      const index = STAGE_ORDER.indexOf(stage)
      return { stage, index: index < 0 ? 0 : index }
    }

    function checksOf(state) {
      const rows = []
      if (state === null || state === undefined || typeof state.checks !== 'object' || state.checks === null) return rows
      for (const key of Object.keys(state.checks)) {
        const entry = state.checks[key]
        if (entry === null || entry === undefined || typeof entry !== 'object') continue
        rows.push({
          key,
          label: CHECK_LABEL[key] || key,
          status: typeof entry.status === 'string' ? entry.status : 'MISSING',
          exit: entry.exit === undefined || entry.exit === null ? '—' : String(entry.exit),
          at: typeof entry.at === 'string' && entry.at.length >= 16 ? entry.at.slice(5, 16).replace('T', ' ') : '—',
        })
      }
      return rows
    }

    function countChecks(rows) {
      const tally = { pass: 0, warn: 0, fail: 0, missing: 0 }
      for (const row of rows) {
        if (row.status === 'PASS') tally.pass += 1
        else if (row.status === 'WARN') tally.warn += 1
        else if (row.status === 'FAIL') tally.fail += 1
        else tally.missing += 1
      }
      return tally
    }

    // ---------- 视图 ----------
    function StageTrack(props) {
      const index = props.index
      return h('div', { style: S.track },
        STAGE_ORDER.map((stage, i) => {
          const done = i < index
          const current = i === index
          const nodeStyle = { ...S.node }
          if (done) {
            nodeStyle.background = 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, var(--dsw-alias-bg-base))'
            nodeStyle.borderColor = 'var(--dsw-alias-state-success-primary)'
            nodeStyle.color = 'var(--dsw-alias-state-success-primary)'
          } else if (current) {
            nodeStyle.background = 'var(--dsw-alias-state-business-primary)'
            nodeStyle.borderColor = 'var(--dsw-alias-state-business-primary)'
            nodeStyle.color = 'var(--dsw-alias-label-on-color)'
          }
          return h('div', { key: stage, style: S.stage },
            h('div', { style: nodeStyle }, done ? '✓' : String(i + 1)),
            h('div', { style: { ...S.stageName, fontWeight: current ? 600 : 400, color: current ? 'var(--dsw-alias-label-primary)' : S.stageName.color } }, stage),
          )
        }),
      )
    }

    function ProjectView(props) {
      const project = props.project
      const state = props.state
      const info = stageIndexOf(state)
      const checks = checksOf(state)
      const tally = countChecks(checks)
      const mode = state !== null && state !== undefined && typeof state.mode === 'string'
        ? state.mode
        : (project !== null && project !== undefined && typeof project.mode === 'string' ? project.mode : 'off')
      const name = project !== null && project !== undefined && typeof project.name === 'string' ? project.name : '未命名工程'
      const blockers = state !== null && state !== undefined && Array.isArray(state.blockers) ? state.blockers : []
      const next = state !== null && state !== undefined && state.next !== undefined && state.next !== null ? state.next : undefined
      const version = state !== null && state !== undefined && typeof state.skillVersion === 'string' ? state.skillVersion : '—'
      const shadow = state !== null && state !== undefined && state.shadow !== undefined && state.shadow !== null ? state.shadow : undefined
      const modeText = mode === 'on' ? '接管' : mode === 'shadow' ? '影子' : '关闭'
      const modeMeta = mode === 'shadow'
        ? (shadow !== undefined ? '已观察 ' + shadow.sessions + ' / ' + shadow.target + ' 个会话' : '只记录，不阻断')
        : mode === 'on' ? '完整契约随首步注入' : '不注入'
      const updated = state !== null && state !== undefined && typeof state.updatedAt === 'string' ? state.updatedAt.slice(0, 16).replace('T', ' ') : '未记录'

      const kpis = [
        { k: '档位', v: modeText, m: modeMeta, id: 'mode' },
        { k: '当前阶段', v: info.stage, m: '第 ' + (info.index + 1) + ' / 7 阶段', id: 'stage' },
        { k: '门禁', v: tally.pass + ' / ' + checks.length + ' 通过', m: tally.warn + ' WARN · ' + tally.fail + ' FAIL · ' + tally.missing + ' 未运行', id: 'gate' },
        { k: '阻断', v: String(blockers.length) + ' 项', m: blockers.length > 0 ? blockers.slice(0, 2).map((b) => b.id + ' ' + b.text).join(' · ') : '无阻断', id: 'blocker' },
      ]

      return h('div', null,
        h('div', null,
          h('div', { style: S.head },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('h1', { style: S.h1 }, '能力闭环'),
              h('p', { style: S.sub },
                h('span', null, name),
                h('span', { style: S.dotsep }, '·'),
                h('span', null, 'skill v' + version),
                h('span', { style: S.dotsep }, '·'),
                h('span', null, '更新于 ' + updated),
                h('span', { style: S.dotsep }, '·'),
                h('span', null, '只读'),
              ),
            ),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flex: 'none' } },
              props.onRefresh ? h('button', { style: S.btn, onClick: props.onRefresh, type: 'button' }, '刷新') : null,
            ),
          ),
          h('div', { style: S.kpis },
            kpis.map((kpi) => h('div', { key: kpi.id, style: S.kpi },
              h('span', { style: S.kpiK }, kpi.k),
              h('span', { style: S.kpiV }, kpi.v),
              h('span', { style: S.kpiM }, kpi.m),
            )),
          ),
        ),
        h('div', { style: S.card },
          h('div', { style: S.cardHd }, '阶段', h('span', { style: S.hint }, '七阶段闭环')),
          h(StageTrack, { index: info.index }),
        ),
        h('div', { style: S.card },
          h('div', { style: S.cardHd }, '门禁与证据', h('span', { style: S.hint }, '点击行展开命令与退出码')),
          checks.length === 0
            ? h('div', { style: { ...S.row, ...S.meta } }, '还没有门禁记录：跑一次 loop-gate.ps1 就会出现在这里。')
            : checks.map((row) => h('div', { key: row.key, style: S.row },
              h('span', { style: S.name }, row.label),
              h(Badge, { status: row.status }),
              h('span', { style: S.meta }, 'exit ' + row.exit),
              h('span', { style: S.right }, row.at),
            )),
        ),
        h('div', { style: S.card },
          h('div', { style: S.cardHd }, '阻断与下一步', h('span', { style: S.hint }, blockers.length + ' 项阻断')),
          blockers.length === 0
            ? h('div', { style: { ...S.row, ...S.meta } }, '无阻断')
            : blockers.map((b, i) => h('div', { key: (b.id || 'b') + i, style: S.row },
              h('span', { style: S.badge }, b.id || 'D-?'),
              h('span', { style: { ...S.meta, color: 'var(--dsw-alias-label-primary)' } }, b.text || ''),
              h('span', { style: S.right }, (b.owner || '') + (b.due ? ' · ' + b.due : '')),
            )),
          next !== undefined
            ? h('div', { style: { ...S.row, alignItems: 'flex-start' } },
              h('span', { style: S.name }, '下一步'),
              h('span', { style: { flex: 1, color: 'var(--dsw-alias-label-primary)' } }, String(next.label || '按 state.next 执行')),
            )
            : null,
          next !== undefined && next.command
            ? h('div', { style: { padding: '0 14px 12px' } }, h('code', { style: S.mono }, String(next.command)))
            : null,
        ),
        h('div', { style: { ...S.meta, marginTop: 12 } },
          '状态源：' + joinPath(props.workspace.path, '.dsh/loop/state.json'),
        ),
      )
    }

    function EmptyView(props) {
      return h('div', { style: S.empty },
        h('div', { style: { fontSize: 16, fontWeight: 600 } }, '还没有已接入的工程'),
        h('div', { style: { ...S.meta, maxWidth: 520, lineHeight: 1.6 } },
          '在任意工程根跑一次接入命令，这里就会显示档位、阶段、门禁与阻断：'),
        h('code', { style: { ...S.mono, background: 'var(--dsw-alias-bg-layer-2)', padding: '8px 10px', borderRadius: 6 } },
          'loop-state.ps1 -Action init -Root <工程根> -ProjectName <名称>'),
        h('div', { style: { ...S.meta, marginTop: 4 } },
          '读取诊断：' + (props.diagnostic === '' ? '未发生错误（只是没找到已标记工程）' : props.diagnostic)),
        props.onRefresh ? h('button', { style: S.btn, onClick: props.onRefresh, type: 'button' }, '重新扫描') : null,
      )
    }

    function CapabilityLoopPage(props) {
      // ctx 由 apply() 注入（不猜 slot props 的形状）；props 仅作为兜底。
      const slot = props === undefined || props === null ? {} : props
      const services = pluginCtx !== undefined && pluginCtx !== null
        ? pluginCtx
        : (slot.hookContext !== undefined && slot.hookContext !== null && slot.hookContext.ctx !== undefined
          ? slot.hookContext.ctx
          : slot.ctx)
      const [view, setView] = React.useState({ status: 'loading', projects: [], error: null })
      const [selected, setSelected] = React.useState(0)
      const load = React.useCallback(() => {
        setView((prev) => ({ ...prev, status: 'loading' }))
        const source = services
        if (source === undefined) {
          setView({ status: 'error', projects: [], error: 'no context' })
          return
        }
        collectAny(source).then(
          (data) => setView({ status: 'ready', projects: data.projects, error: null }),
          (error) => setView({ status: 'error', projects: [], error: String(error && error.message ? error.message : error) }),
        )
      }, [services])
      React.useEffect(() => { load() }, [load])

      if (view.status === 'loading' && view.projects.length === 0) {
        return h('div', { style: S.page }, h('div', { style: S.inner },
          h('h1', { style: S.h1 }, '能力闭环'),
          h('p', { style: S.sub }, h('span', null, '读取状态中…')),
        ))
      }
      if (view.status === 'error') {
        return h('div', { style: S.page }, h('div', { style: S.inner },
          h('h1', { style: S.h1 }, '能力闭环'),
          h('p', { style: S.sub }, h('span', null, '读取失败：' + view.error)),
          h('button', { style: S.btn, onClick: load, type: 'button' }, '重试'),
        ))
      }
      if (view.projects.length === 0) {
        return h('div', { style: S.page }, h('div', { style: S.inner }, h(EmptyView, { onRefresh: load, diagnostic: lastDiagnostic })))
      }
      const index = selected < view.projects.length ? selected : 0
      const current = view.projects[index]
      return h('div', { style: S.page }, h('div', { style: S.inner },
        view.projects.length > 1
          ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 } },
            h('span', { style: { ...S.meta, fontSize: 11 } }, '已接入工程'),
            h('select', {
              style: S.select, value: String(index),
              onChange: (event) => setSelected(Number(event.target.value)),
            }, view.projects.map((item, i) => h('option', { key: item.workspace.id, value: String(i) }, item.workspace.title))),
          )
          : null,
        h(ProjectView, { project: current.project, state: current.state, workspace: current.workspace, onRefresh: load }),
      ))
    }

    function PanelIcon(props) {
      const size = props !== undefined && props !== null && typeof props.size === 'number' ? props.size : 16
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M20 12a8 8 0 0 1-13.66 5.66', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
        h('path', { d: 'M4 12a8 8 0 0 1 13.66-5.66', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
        h('path', { d: 'M17.66 3.6v2.74h-2.74', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M6.34 20.4v-2.74h2.74', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('circle', { cx: 12, cy: 12, r: 2.2, fill: 'currentColor' }),
      )
    }

    return {
      inject: ['slots', 'connection', 'remote', 'remote.session', 'remote.workspaceFiles'],
      apply(ctx) {
        pluginCtx = ctx
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, CapabilityLoopPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => '能力闭环',
        }, PanelIcon))
      },
    }
  },
})
