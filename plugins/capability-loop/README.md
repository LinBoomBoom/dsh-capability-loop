# dsh-capability-loop-bundle

> DeepSeek Harness 宿主插件：让 [dsh-capability-loop](https://github.com/) 的治理契约在**已标记工程**的首个请求里自动出现，不再依赖模型自觉加载 skill。

## 它做什么

在会话的 `agent/pre-step` 瀑布里，读工程根下的两份状态文件，按档位把一小段契约折进本步消息：

| 档位 | 注入 | 约束 |
|---|---|---|
| `off` | 无 | 不约束（未标记工程的默认） |
| `shadow`（影子） | 一行提示（≤140 字符） | **只记录、不阻断**，门禁 FAIL 不拦对话 |
| `on`（接管） | 完整契约（≤1600 字符，实测约 810） | 治理场景必须 INTAKE/证据/门禁/grill |

档位取 `.dsh/loop/project.json` 的 `mode`，再被 `.dsh/loop/state.json` 的 `mode` 覆盖。**没有 `project.json` 就不注入**——安装插件不等于接管所有项目。

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

安装后在 **Plugins** 页把 `capability-loop` 行打开，然后在**新会话**里验证：首条消息之后应出现一段治理契约（档位 `on`）或一行影子提示（档位 `shadow`）。

卸载：Plugins 页关闭该行，或 `plugin_manager action=remove_bundle target=dsh-capability-loop-bundle`。

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
| 注入 | **本插件** | 首步契约/影子提示 |
| 证据 | 门禁脚本 | `checks.*` + 退出码 |
| 面板 | 待实现（设计稿见 skill `docs/design/`） | 阶段/门禁/阻断可视化 |

## 已验证 / 未验证

**已验证（Node 夹具，10/10 通过）**：未标记零注入、off 不注入、shadow 一行 + 影子日志 + 同会话不重复、on 契约含阶段/门禁/阻断/下一步且 ≤1600 字符、注入紧跟用户消息、resume 历史去重、同批去重、fs 抛错 fail-open、state 坏 JSON 降级、`defaultMode=on` 但不标记仍不注入。

**未验证**：真实 Cordis 加载（`install_bundle` 后是否按预期激活）、`user/message` 自定义 `source.kind` 在 Web UI 的渲染表现、真实会话的 token 计费差异、多工作区切换时的读取时序。

## 依据（已核源码，DSH 0.2.2-rc.3）

- `agent/pre-step` 瀑布：`@deepseek-ai/dsh-agent/src/runtime-types.ts` L351
- 契约折进批次：`@deepseek-ai/dsh-agent-instructions/src/index.ts` L330-356
- `createUserMessage` / 可扩展 `MessageSourceMap`：`@deepseek-ai/dsh-llm/src/message.ts` L106/L246
- `ctx.workingDirectory.ensure`：`dsh-working-directory/src/index.ts` L192
- `ctx.fs.resolve/stat/readText/writeText`：`dsh-fs/src/index.ts` L149/L198/L222/L283
