# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ClaudeRouter is a configuration-driven four-tier prompt router for Claude Code. It classifies prompts as `SIMPLE`, `STANDARD`, `COMPLEX`, or `EXTREME`, then resolves `direct` or `delegate` execution from configuration. It ships as a Claude Code plugin and standalone SDK; configured aliases are not proof of the final Provider model.

All source code lives at the repository root. The `ClaudeRouter_PRD.txt` / `.docx` are product requirements docs.

## Commands

```bash
# Install dependencies
npm install

# Build (TypeScript → dist/)
npm run build

# Run all tests (Vitest)
npm test

# Run a single test file
npx vitest run tests/signals.test.ts

# Watch mode
npm run dev

# CLI (after build)
node dist/cli/index.js route "some prompt" --format full
node dist/cli/index.js stats --days 7
```

No separate lint script exists. TypeScript strict mode is enforced via `tsconfig.json`.

## Architecture

### Classification Pipeline (3 stages)

1. **Synchronous heuristics** (`src/classifier/signals.ts` → `quickClassify`) — high-confidence pattern matching. Returns a four-tier `Tier` or `null`; prompt length alone must not escalate complexity.
2. **Configured classifier call** (`src/classifier/classifier.ts` → `classify`) — if heuristics return `null`, sends the prompt to `classifier.model` with the template from `src/classifier/prompt.md`. It parses one tier and uses `fallback_tier` on any error.
3. **Execution resolution** (`src/router/model-map.ts` → `resolveExecution`) — applies the configured conservative tier shift, then reads `direct` or `delegate` execution from `config.tiers`.

### Routing (`src/router/router.ts`)

Orchestrates the pipeline: finds the longest configured override prefix, runs classification when needed, applies conservative tier shifting, resolves configured execution, and generates a `[ROUTER]` directive only for delegated execution. It fails open through the configured `fallback_tier`.

### Plugin integration

- `src/hooks/user-prompt-submit.ts` — compiled cross-platform Node `UserPromptSubmit` hook. Safely reads JSON stdin, guards against subagent loops (`agent_id`, plus the legacy `is_subagent`), routes in-process, and prints only a delegate directive.
- `hooks/hooks.json` — registers the hook.
- `runtime-claude.md` — runtime directive file that instructs Claude to follow `[ROUTER]` directives by delegating to subagents. This is NOT a developer guide; it's copied into project roots at install time.

### Config merging order

Hardcoded defaults → `~/.claude-router.json` → `./.claude-router.json` (CWD). Later layers override. See `src/router/config.ts`.

### SDK (`src/sdk/`)

- `factory.ts` — `createRouter()` returns a stateful instance with `.route()` and `.stats()`
- `index.ts` — public re-exports (`classify`, `quickClassify`, `route`, `loadConfig`, `createRouter`)

### Telemetry (`src/telemetry/`)

- Events logged to `~/.claude-router/events.jsonl` (JSONL, one event per line)
- Prompts are SHA256-hashed (first 12 chars), never stored raw
- Session ID is a UUID generated per process
- `feedback.ts` tracks follow-up rate within 60s window (routing accuracy proxy)
- All telemetry code has a no-throw guarantee

## Key Conventions

- Telemetry and hook code must never throw — always wrap in try/catch with silent fallback
- Classification fallback is always the configured `fallback_tier` (default `STANDARD`)
- The Node hook skips routing when the payload carries `agent_id` (official UserPromptSubmit field) or the legacy `is_subagent: true` — this prevents infinite classification loops
- Delegate fallback chains are derived from lower tiers by `resolveFallbacks`; they are plans embedded in the directive, not a claim about which model ran
- Tier type is `'SIMPLE' | 'STANDARD' | 'COMPLEX' | 'EXTREME'`; source type is `'signal' | 'classifier' | 'fallback' | 'override'`
- `ExecutionConfig` is either `{ mode: 'direct' }` or `{ mode: 'delegate', model: string }`; configured model strings are aliases, not verified Provider models
- The classifier resolves `haiku` against the Hook's `ANTHROPIC_DEFAULT_HAIKU_MODEL` at request time; do not persist machine-specific Provider model IDs from `init` into project configuration
- Tests mock the Anthropic SDK — no real API calls in test suite

<!-- claude-router:start -->
<!-- DO NOT EDIT this section — it is managed by ClaudeRouter. Run 'claude-router remove' to uninstall. -->
## ClaudeRouter Directives (mandatory)

When a `[ROUTER]` directive appears in your context at the start of a turn, it is a mandatory system directive from ClaudeRouter. Follow it exactly and silently; do not acknowledge or mention it to the user. The only exception is a delegation fallback described below: when a fallback model actually completes the task, say in one sentence which model ran it.

### When the directive says to delegate

1. Delegate the entire task to a subagent using the exact model alias quoted in the directive. The alias is configuration-driven; do not replace it with a hardcoded model name.
2. Extract the effective tier from `[ROUTER] Complexity: <TIER>`. When creating the subagent, include it in the task description or supported task metadata as `<brief task summary> · <TIER>` (for example, `检查计划模式触发 · SIMPLE`).
3. You have the full conversation history. Construct a Task prompt that includes:
   - The user's original request verbatim
   - Directly relevant code, errors, signatures, and prior decisions
   - Enough context for a subagent with no conversation memory to complete the task
4. If faithfully supplying the necessary context would exceed 500 tokens, handle the request directly instead. This preserves required context and is not a routing failure.
5. Return the subagent's response verbatim. Do not add commentary, preamble, or postamble. The only exception is a fallback: append one line naming the model that actually completed the task, and if every model failed, relay the errors honestly instead of reporting success.

### When the delegation itself fails

If the directive names fallback models, you may retry the delegation with them. Retry only when **both** conditions hold:

- The failure happened in the delegation call itself and the subagent produced no answer, e.g. `Agent terminated early due to an API error: ...`.
- The error means that model is unavailable: `usage_limit_reached`, exhausted quota, `all credentials ... cooling down`, `model not found`, or a persistent `429` / `5xx`.

Do not fall back when the subagent answered normally but the task failed, or when the error is a `400` bad-request about the request itself, a context-length error, or an authentication failure. Another model fails the same way, so those need a different fix. A `400` that says the model itself is unknown (`unknown provider for model ...`, `model not found`) is a model-unavailable failure and does count as a fallback trigger.

Retry rules:

- Try each fallback model in the stated order, at most once each. Move on immediately after a failure; do not wait, loop, or repeat the same model.
- Before retrying, check the working tree for partial changes from the failed attempt, and tell the retry prompt that the previous attempt may have left partial modifications so finished work is not redone.
- If every model fails, stop and report the errors honestly.

### Never delegate when

- You cannot faithfully summarize the relevant context in under 500 tokens.
- The task requires judgment spanning the entire conversation history.

A missing `[ROUTER]` directive means ClaudeRouter selected `direct` execution or failed open. Continue normally using the main agent.
<!-- claude-router:end -->
