# dsh-capability-loop-bundle

> DeepSeek Harness 插件（host + client）：让 [dsh-capability-loop](https://github.com/) 的治理契约在**已标记工程**的首个请求里自动出现，并在侧边栏给出一个**只读控制台**。

## 它做什么

| 部分 | 作用 | 在哪 |
|---|---|---|
| **注入（host）** | 在 `agent/pre-step` 把契约折进本步消息：`on` ≈800 字符，`shadow` 一行 | 会话里可见，无需操作 |
| **控制台（client）** | 侧边栏「能力闭环」：档位 / 阶段轨道 / 门禁 / 阻断 / 下一步 | 左侧导航 |
| **状态源** | `.dsh/loop/state.json`，唯一写入方是 skill 的脚本 | 工程根下 |

喂给控制台的数据在会话的 `agent/pre-step` 瀑布里组装，按档位决定长度：

| 档位 | 注入 | 约束 |
|---|---|---|
| `off` | 无 | 不约束（未标记工程的默认） |
| `shadow`（影子） | 一行提示（≤140 字符） | **只记录、不阻断**，门禁 FAIL 不拦对话 |
| `on`（接管） | 完整契约（≤1600 字符，实测约 810） | 治理场景必须 INTAKE/证据/门禁/grill |

档位取 `.dsh/loop/project.json` 的 `mode`，再被 `.dsh/loop/state.json` 的 `mode` 覆盖。**没有 `project.json` 就不注入、面板也不列它**——安装插件不等于接管所有项目。

## 状态文件从哪来

用 skill 的脚本生成，不要手写：

```powershell
$sk = "$env:USERPROFILE\.dsh\skills\dsh-capability-loop"
powershell -NoProfile -ExecutionPolicy Bypass -File "$sk\scripts\loop-state.ps1" -Action init -Root "<工程根>" -ProjectName "<工程名>"
```

生成 `.dsh/loop/project.json` + `state.json` + `.gitignore`（`state.json` 默认不提交）。

## 注入内容长什么样

```text
<system-reminder>
[capability-loop v2.10.0] 本工程（气量平衡月表）已启用治理闭环；当前阶段 WIRE（第 4/7 阶段）。
适用：需求/方案、设计/改版、实现与交接、测试与验收、复盘。豁免：只读问答、单文件小改（≤30 分钟）、纯闲聊——直接做，不套流程。

硬约束：
1. 未完成 INTAKE（.dsh/loop/project-profile.md）不得进入实现；…
2. 说“完成/已修复/已通过”必须附证据：命令 + 退出码 + 关键输出或截图；…
3. PASS 不得由写的人自己给；终门要有他人的评审记录。
4. 交付/交接前必须 grill（记录 grill-*.md）；硬门用 loop-gate.ps1 -RequireGrill。
5. 改本 skill 必须在同一提交 bump version.json + CHANGELOG.md。
6. 门禁 FAIL 时只能说“未通过 + 缺什么”，不得改写结论。

本阶段出口：design-context.md 已取证；loop-gate -Kind design 退出码 0；grill 至少 1 条打回并修正
当前门禁：设计门=FAIL · 需求门=PASS · 测试门=PASS · 交接体检=WARN · grill=MISSING · 能力体检=PASS
阻断：D-01 缺 1440 截图；D-02 材料在工程外
下一步：补 design-context 后重跑设计门（命令：loop-gate -TaskDir docs/design -Kind design）
状态源：.dsh/loop/state.json（用户可在“能力闭环”面板查看）。
</system-reminder>
```

注入位置：**紧跟本步认领的用户消息之后**，所以用户的原话先出现，契约随后，运行期上下文最后。

## 纪律

- **fail-open**：读文件/解析/构造任一失败都不注入、只记日志；治理不能把对话弄挂。
- **幂等**：注入消息带 `source.kind = 'capability-loop'` 与内容指纹；resume/fork/同批重复都会按历史去重。
- **只读状态**：`state.json` 的唯一写入方是 skill 的脚本；本插件只追加 `.dsh/loop/shadow-log.jsonl`（每会话一行，供 `loop-state.ps1 -Action sync-shadow` 计数）。
- **不新增事件类型**：只用普通 `user/message`，会话可正常重开。
- **零成本**：未标记工程不读、不写、不注入。

## 安装

本机目录安装（开发/内测）：

```
plugin_manager  action=install_bundle  target=<本目录绝对路径>
```

安装后在 **Plugins** 页确认 `Capability Loop` 行是开的，然后**刷新页面（Ctrl+R）或重启应用**——渲染器的 client 模块图是启动时建的，新装/改动的 `client.js` 不会热加载（除非同时跑 `pnpm run dev:web`）。刷新后：

- 左侧导航出现 **能力闭环**（环形箭头图标），点开是控制台；
- 新会话里，首条消息之后应出现治理契约（`on`）或一行影子提示（`shadow`）。

> 装完必须确认 `plugin_manager action=set_plugin target=include:capability-loop enabled=true` 返回 **`application: applied`**；`install_bundle` 的 `exitCode=0` 不代表这一行活了。

卸载：Plugins 页关闭该行，或 `plugin_manager action=remove_bundle target=dsh-capability-loop-bundle`。

## 控制台的数据通道

客户端半边（`client.js`）注册 `sidebar.panellist` + `main`，然后：

1. `ctx.remote.session.list({})` 拿会话列表（`SessionSummary` 带 `sessionId` 与 `cwd`）；
2. 每个 `cwd` 取最近的一个会话作凭据，`ctx.remote.workspaceFiles.read(sessionId, '.dsh/loop/project.json', {}, signal)` → 再读 `state.json`；相对路径落在该会话的工作区根。

**不用** `/api/file`：`ctx.connection` 的浏览器半边没有 `fetch`（那是 Host 侧 Connection 的方法），桌面渲染器又在 `dsh-app://` 源上，`globalThis.fetch('/api/file')` 命中不了 HTTP API。
**`inject` 要写点号键**：`['slots','connection','remote','remote.session','remote.workspaceFiles']`，否则运行时报 `cannot get property "remote.session" without inject`（见 skill `references/70-playbook.md` ERR-20261119-03）。

读数失败时面板空态会显示「读取诊断：<具体错误>」，不做静默空白。

## 配置（`cordis.patch.yml`）

| 键 | 默认 | 含义 |
|---|---|---|
| `defaultMode` | `off` | 工程没有 `project.json.mode` 时的档位 |
| `maxContractChars` | 1600 | `on` 档契约字符上限，超出截断并标注 |
| `maxShadowChars` | 140 | `shadow` 档提示字符上限 |
| `shadowLog` | true | 是否写 `.dsh/loop/shadow-log.jsonl` |
| `debug` | false | 把每次注入决策打到 host 日志 |
| `skillDir` | `''` | 可选：skill 安装目录，用于契约里给「按需读哪一篇」的绝对路径 |

## 与 skill 的分工

| 层 | 谁做 | 产出 |
|---|---|---|
| 状态 | skill 脚本（`loop-state.ps1` / `loop-gate.ps1` / `capability-audit.ps1`） | `.dsh/loop/state.json` |
| 注入 | **本插件 host 半** | 首步契约/影子提示 |
| 证据 | 门禁脚本 | `checks.*` + 退出码 |
| 面板 | **本插件 client 半** | 档位/阶段/门禁/阻断/下一步（只读） |

## 已验证 / 未验证

**已验证**
- 夹具 `node --test plugins/capability-loop/`：**20/20**（host 11 + client 9）。
  - host：未标记零注入、off 不注入、shadow 一行 + 影子日志 + 同会话不重复、on 契约 ≤1600 且含阶段/门禁/阻断/下一步、注入位置、resume/同批去重、fs 抛错 fail-open、坏 JSON 降级、无 `dsh-llm` 时手工构造兜底。
  - client：两个 slot 注册（key/id/order/label/icon）、有工程渲染、多工程切换、空态、会话为空、list 抛错、read 抛错、无 remote 服务。
- **真机（桌面版 2026-11-19）**：`install_bundle` → `set_plugin` → `application: applied`；侧边栏出现「能力闭环」；点开后读到本仓库真实 `state.json`（影子 2/3、GATE 7/7、设计门 PASS、D-01 阻断、下一步命令、skill v2.12.0），「刷新」按钮可重读。
- 会话里收到 `shadow` 一行提示；影子日志记账；`sync-shadow` 计数。

**未验证**
- `on` 档在真实会话里的整段契约（当前仓库是 `shadow`，切 `on` 即可验）。
- Web UI 对 `source.kind='capability-loop'` 的渲染样式（现在当普通用户消息显示）。
- token 计费差异；面板在 375/768 宽度下的排版。

## 依据（已核源码，DSH 0.2.2-rc.3）

- `agent/pre-step` 瀑布：`@deepseek-ai/dsh-agent/src/runtime-types.ts` L351
- 契约折进批次：`@deepseek-ai/dsh-agent-instructions/src/index.ts` L330-356
- `createUserMessage` / 可扩展 `MessageSourceMap`：`@deepseek-ai/dsh-llm/src/message.ts` L106/L246
- `ctx.workingDirectory.ensure`：`dsh-working-directory/src/index.ts` L192
- `ctx.fs.resolve/stat/readText/writeText`：`dsh-fs/src/index.ts` L149/L198/L222/L283
