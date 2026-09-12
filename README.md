# ClaudeRouter_Sha

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Configuration-driven prompt routing for Claude Code.** ClaudeRouter classifies a prompt into one of five complexity tiers, then either keeps the task with the main agent or emits a directive to delegate it using the model alias configured for that tier.

ClaudeRouter deliberately does **not** decide or verify the final Provider model. Aliases such as `haiku`, `sonnet`, `opus`, and `fable` are configuration values only; their resolution is owned by Claude Code and any configured Provider or Gateway.

## Prerequisites

- **Node.js 18+**
- **Claude Code** installed ([install guide](https://docs.anthropic.com/en/docs/claude-code))
- A Claude Code plan and environment that support the delegation requested by your configured model aliases

The hook is a compiled Node program. It does not require `bash`, `sh`, `jq`, `grep`, `sed`, `awk`, or `/tmp`.

## Installation

This fork is installed directly from GitHub; it is not published as a separate npm package.

```bash
npm install -g github:Shakyae/ClaudeRouter_Sha
claude-router init
```

### From source

```bash
git clone https://github.com/Shakyae/ClaudeRouter_Sha.git
cd ClaudeRouter_Sha
npm install
npm run build
npm install -g .
claude-router init
```

`init` always registers this absolute command in `~/.claude/settings.json`:

```text
node <absolute-package-path>/dist/hooks/user-prompt-submit.js
```

The optional path only determines which `CLAUDE.md` receives the managed ClaudeRouter runtime directive. Without a path, `claude-router init` targets the current project; to target another project:

```bash
claude-router init /path/to/your/project
```

### Enable ClaudeRouter for all projects

To initialize ClaudeRouter at the user level, target the Claude configuration directory itself. On Windows PowerShell:

```powershell
claude-router init "$env:USERPROFILE\.claude"
```

On macOS/Linux:

```bash
claude-router init "$HOME/.claude"
```

The hook is still registered in `~/.claude/settings.json`; the argument only controls where the runtime directive is written. When the target is `~/.claude`, the user-level `CLAUDE.md` applies to all projects. A project's `.claude-router.json` overrides the user-level `~/.claude-router.json`.

## Verify installation

```bash
claude-router doctor
claude-router stats
```

`doctor` verifies Node, the compiled Node hook, hook registration, the `CLAUDE.md` marker, and packaged runtime files. If routing events accumulate, the hook is active. After a user-level initialization, run `doctor` from `$env:USERPROFILE\.claude` (or inspect the user-level file); running it from a project directory can report a missing marker because it checks the current working directory's `CLAUDE.md`.

## How routing works

1. **Synchronous signals** — `quickClassify()` recognizes only high-confidence cases. Follow-ups such as `yes`, `ok`, and `continue` remain `STANDARD`; prompt length alone never escalates a task.
2. **Classifier model** — prompts not resolved by signals are classified by `classifier.model`.
3. **Fallback** — classifier failures, timeouts, and invalid responses return `fallback_tier`.
4. **Configured execution** — the effective tier is looked up in `tiers`. A `direct` tier yields no directive; a `delegate` tier yields a `[ROUTER]` directive containing its configured model alias.

The five ordered tiers are:

| Tier | Intended use |
|------|--------------|
| `TRIVIAL` | Narrow mechanical work, navigation, tiny edits, or simple explanations |
| `SIMPLE` | Explicit, local, low-risk implementation work |
| `STANDARD` | Ordinary engineering features, fixes, and routine refactoring |
| `COMPLEX` | Cross-module debugging, difficult integrations, concurrency, or deep analysis |
| `EXTREME` | System-wide architecture, major migrations, or whole-repository investigation |

## Default execution

| Tier | Default execution |
|------|-------------------|
| `TRIVIAL` | `delegate` using `haiku` |
| `SIMPLE` | `delegate` using `sonnet` |
| `STANDARD` | `direct` |
| `COMPLEX` | `delegate` using `opus` |
| `EXTREME` | `delegate` using `fable` |

These are defaults, not fixed model policy. Any tier, including `STANDARD`, can be `direct` or `delegate` through configuration.

## Configuration

ClaudeRouter merges configuration in this order:

```text
built-in defaults → ~/.claude-router.json → <project>/.claude-router.json
```

Nested objects are schema-aware and deep-merged. A project may override one tier without replacing the remaining tiers. Invalid configuration is ignored with a warning while the last safe value remains active.

Example `.claude-router.json`:

```json
{
  "tiers": {
    "TRIVIAL": { "mode": "delegate", "model": "fast-alias" },
    "SIMPLE": { "mode": "delegate", "model": "balanced-alias" },
    "STANDARD": { "mode": "direct" },
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
    "//quick": "TRIVIAL",
    "//deep": "EXTREME"
  },
  "debug": {
    "enabled": false,
    "prompt_preview_chars": 150
  }
}
```

### Configuration fields

| Field | Default | Description |
|-------|---------|-------------|
| `tiers.<TIER>` | See [Default execution](#default-execution) | `{ "mode": "direct" }` or `{ "mode": "delegate", "model": "alias" }` |
| `classifier.model` | `haiku` | Classifier model alias or Provider model ID; see [Classifier model resolution](#classifier-model-resolution) |
| `classifier.timeout_ms` | `3000` | Classifier request timeout in milliseconds |
| `fallback_tier` | `STANDARD` | Safe tier used if classification cannot complete |
| `conservative` | `false` | Shifts the classified tier up one step before its execution is resolved |
| `overrides` | Five `//<tier>` prefixes | Maps case-insensitive prompt prefixes to tiers; the longest matching prefix wins |
| `debug.enabled` | `false` | Enables hook debug JSONL output |
| `debug.prompt_preview_chars` | `150` | Maximum preview length written by debug logging |

### Classifier model resolution

At classifier request time, ClaudeRouter selects the model in this order:

1. A non-empty `CLAUDE_ROUTER_CLASSIFIER_MODEL`.
2. A non-empty `ANTHROPIC_DEFAULT_HAIKU_MODEL`, but only when `classifier.model` is `haiku` (case-insensitive).
3. The configured `classifier.model`.

The second step is a compatibility mechanism for the Hook process after it inherits Claude Code's environment. It does not validate that the configured alias or mapped value is the final Provider model. A configured classifier model other than `haiku` is never replaced by `ANTHROPIC_DEFAULT_HAIKU_MODEL`.

An override removes its prefix before routing and bypasses classification:

```text
//deep investigate this production race condition
```

The default prefixes are `//trivial`, `//simple`, `//standard`, `//complex`, and `//extreme`.

## Observability and privacy

Routing events are written to `~/.claude-router/events.jsonl`. They contain a SHA-256 prompt hash, token estimate, tier, source, execution mode, timing, and—only for delegated work—the configured alias in `configured_model`. Raw prompts and API keys are never written to this telemetry file.

Set `CLAUDE_ROUTER_DEBUG=1` or `debug.enabled: true` to additionally write `~/.claude-router/debug.jsonl`. Debug records contain only the configured-length `prompt_preview`, never the full prompt or an API key.

`configured_model` means **the alias selected by ClaudeRouter**, not the final Provider model actually used. Verify the final model mapping from your Provider or Gateway request logs and their `model` field.

## Stats

```bash
claude-router stats --days 30
```

The report shows every tier, current configured execution targets, direct/delegated counts, classifier fallbacks, manual overrides, and the `TRIVIAL` follow-up rate. It does not estimate token or cost savings, and it does not claim a Provider model was used.

Example:

```text
ClaudeRouter — last 7 days
----------------------------------------------------------
Prompts routed:          42
TRIVIAL  → delegate (fast-alias)       10   (23.8%)
SIMPLE   → delegate (balanced-alias)   12   (28.6%)
STANDARD → direct                       8   (19.0%)
COMPLEX  → delegate (reasoning-alias)   7   (16.7%)
EXTREME  → delegate (frontier-alias)    5   (11.9%)
Direct executions:         8
Delegated executions:     34
Classifier fallbacks:      1
Manual overrides:          2
Follow-up rate (TRIVIAL): 0.0%  ← lower is better
----------------------------------------------------------
```

## CLI and SDK

```bash
# Inspect a full routing decision.
claude-router route "add user authentication" --format full

# Print only the configured delegate alias; direct execution prints nothing.
claude-router route "find calculatePrice" --format model

# Read a prompt from stdin without placing it in command arguments.
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
// { tier: 'TRIVIAL', source: 'signal', ... }

const config = loadConfig();
const decision = await route('add user authentication', config);
// { tier: 'STANDARD', execution: { mode: 'direct' }, directive: null, ... }

const router = createRouter({ telemetry: true });
await router.route('redesign the authentication architecture');
console.log(router.stats());
// { total: 1, tiers: { TRIVIAL: 0, SIMPLE: 0, STANDARD: 0, COMPLEX: 0, EXTREME: 1 }, ... }
```

- `classify(prompt)` — full signal and classifier pipeline
- `quickClassify(prompt)` — signal-only tier or `null`
- `route(prompt, config)` — execution-aware routing decision
- `loadConfig(cwd?)` — merged configuration
- `createRouter(options?)` — stateful router with session statistics

## Failure behavior

ClaudeRouter is fail-open and never intentionally blocks Claude Code:

- Classifier errors, timeouts, and malformed results use `fallback_tier`.
- Hook parsing, configuration, telemetry, and debug errors produce no directive and exit successfully.
- `is_subagent: true` prevents recursive hook routing for subagents.
- A `direct` execution deliberately emits no directive, leaving the task with the main agent.

## Troubleshooting

**`claude-router doctor` reports a missing compiled hook**

Run `npm run build`, then run `claude-router init` again.

**No events appear in stats**

Run `claude-router doctor`. It checks whether the absolute Node hook command is registered in `~/.claude/settings.json`.

**A prompt unexpectedly stays with the main agent**

Inspect the relevant tier in `.claude-router.json`. `direct` is an intentional execution mode and returns an empty hook output.

**All uncertain prompts use one tier**

If a third-party Gateway rejects `haiku`, first verify Claude Code's `ANTHROPIC_DEFAULT_HAIKU_MODEL` mapping. ClaudeRouter uses that mapping only when `classifier.model` remains `haiku`. Use `CLAUDE_ROUTER_CLASSIFIER_MODEL` only when an explicit Router-specific override is required. Also check `fallback_tier` and the classifier API environment; the fallback is normally `STANDARD`.

**The configured alias did not become the expected Provider model**

ClaudeRouter has completed its routing decision, but alias resolution occurs outside ClaudeRouter. Inspect the Provider or Gateway request log's `model` field to validate the actual mapping.

**I see `[ROUTER]` in a Claude Code transcript**

This is expected for delegated routes. It is hook output consumed as context; the runtime directive tells Claude to follow it silently.

## Uninstallation

```bash
claude-router remove
npm uninstall -g @0dust/claude-router
```

This removes ClaudeRouter's registered `UserPromptSubmit` command and the managed marker block from the chosen project's `CLAUDE.md`. Telemetry and debug data in `~/.claude-router/` are retained; delete them manually if no longer needed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
