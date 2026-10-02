# ClaudeRouter_Sha

[English](README.md)

[![许可证：MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**面向 Claude Code、由配置驱动的提示路由器。** ClaudeRouter 将提示归类为四种复杂度之一，然后选择由主 agent 处理任务，或发出指令，使用该档位配置的模型别名进行委派。

ClaudeRouter **不会**决定或验证最终使用的 Provider 模型。`haiku`、`sonnet`、`opus` 和 `fable` 等别名仅是配置值；这些别名由 Claude Code 以及所配置的 Provider 或 Gateway 解析。

## 前置条件

- **Node.js 18+**
- 已安装 **Claude Code**（[安装指南](https://docs.anthropic.com/en/docs/claude-code)）
- Claude Code 套餐和运行环境支持通过已配置的模型别名进行委派

Hook 是编译后的 Node 程序，不依赖 `bash`、`sh`、`jq`、`grep`、`sed`、`awk` 或 `/tmp`。

## 安装

此 fork 直接从 GitHub 安装，不作为独立 npm 包发布。

```bash
npm install -g github:Shakyae/ClaudeRouter_Sha
claude-router init
```

### 从源码安装

```bash
git clone https://github.com/Shakyae/ClaudeRouter_Sha.git
cd ClaudeRouter_Sha
npm install
npm run build
npm install -g .
claude-router init
```

`init` 始终将以下绝对命令注册到用户级 `~/.claude/settings.json`：

```text
node <absolute-package-path>/dist/hooks/user-prompt-submit.js
```

可选路径只决定将 ClaudeRouter 托管的运行时 directive 写入哪个 `CLAUDE.md`。目标目录必须已存在；`init` 不会创建目录。不指定路径时，`claude-router init` 以当前项目为目标；指定其他项目：

```bash
claude-router init /path/to/your/project
```

`init` 会先在用户级 `~/.claude/settings.json` 注册或更新 hook，然后再将托管 directive 写入目标 `CLAUDE.md`。如果目标目录不存在或写入 `CLAUDE.md` 失败，命令会报告错误，但此前完成的 hook 注册会保留。运行 `init` 前请先创建目标目录；如遇写入问题，修复后重新运行 `init`。

### 为所有项目启用 ClaudeRouter

若要在用户级初始化 ClaudeRouter，请将 Claude 配置目录本身作为目标路径。Windows PowerShell：

```powershell
claude-router init "$env:USERPROFILE\.claude"
```

macOS/Linux：

```bash
claude-router init "$HOME/.claude"
```

Hook 仍注册在用户级 `~/.claude/settings.json`；参数只控制运行时 directive 的写入位置。目标设为 `~/.claude` 时，用户级 `CLAUDE.md` 会对所有项目生效。项目级 `.claude-router.json` 优先于用户级 `~/.claude-router.json`。

## 验证安装

```bash
claude-router doctor
claude-router stats
```

`doctor` 会验证 Node、编译后的 Node hook、hook 注册状态、`CLAUDE.md` marker 和打包的运行时文件。如果路由事件持续累积，说明 hook 正在工作。用户级初始化后，请在 `$env:USERPROFILE\.claude` 目录运行 `doctor`，或直接检查用户级文件；在项目目录运行时，它只检查当前工作目录的 `CLAUDE.md`，因此可能报告 marker 缺失。

## 路由原理

1. **同步信号** — `quickClassify()` 仅识别置信度高的情况。`yes`、`ok`、`continue` 等跟进提示保持为 `STANDARD`；提示长度本身不会提升任务复杂度。
2. **分类器模型** — 未被信号规则判定的提示由 `classifier.model` 分类。
3. **回退** — 分类器失败、超时或响应无效时，使用 `fallback_tier`。
4. **按配置执行** — 根据最终档位查询 `tiers`。`direct` 档位不产生 directive；`delegate` 档位会生成包含已配置模型别名的 `[ROUTER]` directive。

四个有序档位如下：

| 档位 | 适用场景 |
|------|----------|
| `SIMPLE` | 范围明确的机械性工作、导航、微小编辑或简单解释 |
| `STANDARD` | 明确、局部、低风险的实现工作，以及常规工程功能、修复和重构 |
| `COMPLEX` | 跨模块调试、困难集成、并发问题或深入分析 |
| `EXTREME` | 系统级架构、重大迁移或全仓库调查 |

## 默认执行方式

| 档位 | 默认执行方式 |
|------|--------------|
| `SIMPLE` | 使用 `haiku` 执行 `delegate` |
| `STANDARD` | 使用 `sonnet` 执行 `delegate` |
| `COMPLEX` | 使用 `opus` 执行 `delegate` |
| `EXTREME` | 使用 `fable` 执行 `delegate` |

以上是默认值，不是固定的模型策略。任何档位（包括 `STANDARD`）都可以通过配置设为 `direct` 或 `delegate`。

## 配置

ClaudeRouter 按以下优先级合并配置：

```text
内置默认值 → ~/.claude-router.json → <项目目录>/.claude-router.json
```

嵌套对象会按 schema 深度合并。项目可以只覆盖一个档位，而不替换其余档位。无效配置会被忽略并发出警告，同时保留最近一次安全值。

`.claude-router.json` 配置示例：

```json
{
  "tiers": {
    "SIMPLE": { "mode": "delegate", "model": "fast-alias" },
    "STANDARD": { "mode": "delegate", "model": "balanced-alias" },
    "COMPLEX": { "mode": "delegate", "model": "reasoning-alias" },
    "EXTREME": { "mode": "delegate", "model": "frontier-alias" }
  },
  "classifier": {
    "model": "classifier-alias",
    "timeout_ms": 3000
  },
  "fallback_tier": "STANDARD",
  "conservative": false,
  "overrides": {
    "//quick": "SIMPLE",
    "//deep": "EXTREME"
  },
  "debug": {
    "enabled": false,
    "prompt_preview_chars": 150
  }
}
```

### 配置字段

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `tiers.<TIER>` | 见[默认执行方式](#默认执行方式) | `{ "mode": "direct" }` 或 `{ "mode": "delegate", "model": "alias" }` |
| `classifier.model` | `haiku` | 分类器模型别名或 Provider 模型 ID；参见[分类器模型解析](#分类器模型解析) |
| `classifier.timeout_ms` | `3000` | 分类器请求超时时间，单位为毫秒 |
| `fallback_tier` | `STANDARD` | 分类无法完成时使用的安全档位 |
| `conservative` | `false` | 在解析执行方式前，将分类档位提升一个级别 |
| `overrides` | 四个档位前缀 | 将不区分大小写的提示前缀映射到档位；匹配多个前缀时采用最长匹配项 |
| `debug.enabled` | `false` | 启用 hook 调试 JSONL 输出 |
| `debug.prompt_preview_chars` | `150` | 调试日志中提示预览的最大字符数 |

### 分类器模型解析

每次发起分类器请求时，ClaudeRouter 按以下顺序选择模型：

1. 非空的 `CLAUDE_ROUTER_CLASSIFIER_MODEL`。
2. 当 `classifier.model` 为 `haiku`（不区分大小写）时，使用非空的 `ANTHROPIC_DEFAULT_HAIKU_MODEL`。
3. 使用配置中的 `classifier.model`。

第二步是兼容机制：Hook 进程继承 Claude Code 的环境变量后，可据此解析模型。它不会验证配置别名或映射值是否为最终 Provider 模型。若配置的分类器模型不是 `haiku`，则不会被 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 替换。

覆盖前缀会在路由前被移除，并跳过分类器：

```text
//deep investigate this production race condition
```

默认前缀为 `//simple`、`//standard`、`//complex` 和 `//extreme`。

## 常用命令和配置

### 使用提示前缀指定档位

在 Claude Code 中，将默认覆盖前缀放在提示开头，并用空格与任务内容分隔：

```text
//simple 修复 README.md 中的拼写错误
//standard 添加输入校验
//complex 排查跨模块竞态问题
//extreme 审查系统架构
```

`//simple` 指定 `SIMPLE` 档位并跳过分类，**不是**直接指定任意模型。在默认的 `conservative: false` 下，执行方式由 `tiers.SIMPLE` 决定，默认委派到 `haiku`。如需更换该别名，可将以下片段合并到项目的 `.claude-router.json`：

```json
{
  "tiers": {
    "SIMPLE": { "mode": "delegate", "model": "sonnet" }
  }
}
```

使用此配置且 `conservative: false` 时，`//simple` 会委派到 `sonnet`。若将 `tiers.SIMPLE` 改为 `{ "mode": "direct" }`，任务则留给主 agent。模型别名仍由 Claude Code 及 Provider 或 Gateway 解析，ClaudeRouter 不会验证最终模型。

### 开启保守路由

将以下片段合并到 `.claude-router.json`，可为当前项目开启保守路由；合并到 `~/.claude-router.json` 则作为用户级默认配置：

```json
{
  "conservative": true
}
```

默认值为 `false`。开启后，在解析对应执行配置**之前**，将选定档位提升一级：`SIMPLE → STANDARD → COMPLEX → EXTREME`；`EXTREME` 保持不变。手动前缀覆盖同样受此设置影响：`//simple` 会使用 `STANDARD` 档位配置的执行方式和模型别名，而不是 `SIMPLE`。将 `conservative` 改回 `false` 可关闭提升。项目级配置优先于用户级配置。

### 常用 CLI 命令

```bash
# 检查安装状态和 hook 注册
claude-router doctor

# 查看手动覆盖后的最终档位与执行方式
claude-router route "//simple fix the typo in README.md" --format full

# 仅打印配置的委派别名；直接执行时不打印内容
claude-router route "//simple fix the typo in README.md" --format model

# 查看最近 7 天的路由统计
claude-router stats --days 7
```

请在项目目录运行路由命令，以便加载该项目的 `.claude-router.json`。

## 可观测性与隐私

路由事件写入 `~/.claude-router/events.jsonl`。事件包含 SHA-256 提示哈希、token 估算值、档位、来源、执行模式、耗时，以及仅在委派任务时记录的 `configured_model` 别名。原始提示和 API key 不会写入此遥测文件。

设置 `CLAUDE_ROUTER_DEBUG=1` 或 `debug.enabled: true` 后，还会写入 `~/.claude-router/debug.jsonl`。调试记录只包含按配置长度截断的 `prompt_preview`，不会记录完整提示或 API key。

`configured_model` 表示 **ClaudeRouter 选定的别名**，并不代表实际使用的最终 Provider 模型。请从 Provider 或 Gateway 请求日志的 `model` 字段核实最终模型映射。

## 统计

```bash
claude-router stats --days 30
```

报告展示所有档位、当前配置的执行目标、直接/委派次数、分类器回退次数、手动覆盖次数以及 `SIMPLE` 跟进率。它不会估算 token 或成本节省，也不会声称实际使用了某个 Provider 模型。

示例：

```text
ClaudeRouter — 过去 7 天
----------------------------------------------------------
路由提示数：              42
SIMPLE   → 委派 (fast-alias)         10   (23.8%)
STANDARD → 委派 (balanced-alias)    12   (28.6%)
COMPLEX  → 委派 (reasoning-alias)    8   (19.0%)
EXTREME  → 委派 (frontier-alias)     7   (16.7%)
直接执行：                 5
委派执行：                37
分类器回退：               1
手动覆盖：                 2
跟进率 (SIMPLE)：       0.0%  ← 越低越好
----------------------------------------------------------
```

## CLI 与 SDK

```bash
# 查看完整路由决策
claude-router route "add user authentication" --format full

# 仅打印配置的委派别名；直接执行时不打印内容
claude-router route "find calculatePrice" --format model

# 从 stdin 读取提示，避免将提示放入命令参数
claude-router route --stdin --format full
```

```typescript
import {
  classify,
  createRouter,
  loadConfig,
  route,
  type Tier,
} from '@0dust/claude-router';

const classification = await classify('fix the typo on line 42');
// { tier: 'SIMPLE', source: 'signal', ... }

const config = loadConfig();
const decision = await route('add user authentication', config);
// { tier: 'STANDARD', execution: { mode: 'delegate', model: 'sonnet' }, directive: '[ROUTER] Complexity: STANDARD. ...', ... }

const router = createRouter({ telemetry: true });
await router.route('redesign the authentication architecture');
console.log(router.stats());
// { total: 1, tiers: { SIMPLE: 0, STANDARD: 0, COMPLEX: 0, EXTREME: 1 }, ... }
```

- `classify(prompt)` — 完整的信号与分类器处理流程
- `quickClassify(prompt)` — 仅根据信号判定档位，或返回 `null`
- `route(prompt, config)` — 感知执行配置的路由决策
- `loadConfig(cwd?)` — 加载并合并配置
- `createRouter(options?)` — 带会话统计的有状态 router

## 失败处理

ClaudeRouter 采用 fail-open 设计，不会有意阻止 Claude Code：

- 分类器错误、超时和格式错误的结果使用 `fallback_tier`。
- Hook 解析、配置、遥测和调试错误会导致不输出 directive，并以成功状态退出。
- `is_subagent: true` 会阻止对子 agent 递归执行路由。
- `direct` 执行方式有意不产生 directive，任务继续由主 agent 处理。

## 故障排查

**`claude-router doctor` 报告编译后的 hook 缺失**

运行 `npm run build`，然后重新运行 `claude-router init`。

**统计中没有事件**

运行 `claude-router doctor`。它会检查绝对 Node hook 命令是否已注册到 `~/.claude/settings.json`。

**提示意外地留在主 agent 处理**

检查 `.claude-router.json` 中对应档位的配置。`direct` 是有意提供的执行模式，会返回空的 hook 输出。

**所有不确定的提示都被分到同一档**

如果第三方 Gateway 拒绝 `haiku`，请先确认 Claude Code 的 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 映射。只有 `classifier.model` 仍为 `haiku` 时，ClaudeRouter 才会使用该映射。仅在确实需要 Router 专属覆盖时使用 `CLAUDE_ROUTER_CLASSIFIER_MODEL`。同时检查 `fallback_tier` 和分类器 API 环境；默认回退档位通常为 `STANDARD`。

**配置的别名没有解析为预期的 Provider 模型**

ClaudeRouter 已完成路由决策，但别名解析发生在 ClaudeRouter 之外。请检查 Provider 或 Gateway 请求日志中的 `model` 字段，确认实际映射。

**在 Claude Code transcript 中看到 `[ROUTER]`**

委派路由出现此内容是预期行为。它是作为上下文被消费的 hook 输出；运行时 directive 会要求 Claude 静默遵循它。

**用户级 directive 的 marker 检查未通过**

`doctor` 验证的是用户级 hook 注册，同时检查当前工作目录下 `CLAUDE.md` 的 marker。若 directive 写入了用户级 `~/.claude/CLAUDE.md`，请在 `~/.claude` 目录运行 `doctor`，或检查该文件。

## 卸载

```bash
claude-router remove
npm uninstall -g @0dust/claude-router
```

这会移除已注册的 ClaudeRouter `UserPromptSubmit` 命令，以及指定项目 `CLAUDE.md` 中的托管 marker 区块。`~/.claude-router/` 中的遥测和调试数据会保留；如不再需要，请手动删除。

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT
