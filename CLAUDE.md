# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ClaudeRouter is a configuration-driven five-tier prompt router for Claude Code. It classifies prompts as `TRIVIAL`, `SIMPLE`, `STANDARD`, `COMPLEX`, or `EXTREME`, then resolves `direct` or `delegate` execution from configuration. It ships as a Claude Code plugin and standalone SDK; configured aliases are not proof of the final Provider model.

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

1. **Synchronous heuristics** (`src/classifier/signals.ts` → `quickClassify`) — high-confidence pattern matching. Returns a five-tier `Tier` or `null`; prompt length alone must not escalate complexity.
2. **Configured classifier call** (`src/classifier/classifier.ts` → `classify`) — if heuristics return `null`, sends the prompt to `classifier.model` with the template from `src/classifier/prompt.md`. It parses one tier and uses `fallback_tier` on any error.
3. **Execution resolution** (`src/router/model-map.ts` → `resolveExecution`) — applies the configured conservative tier shift, then reads `direct` or `delegate` execution from `config.tiers`.

### Routing (`src/router/router.ts`)

Orchestrates the pipeline: finds the longest configured override prefix, runs classification when needed, applies conservative tier shifting, resolves configured execution, and generates a `[ROUTER]` directive only for delegated execution. It fails open through the configured `fallback_tier`.

### Plugin integration

- `src/hooks/user-prompt-submit.ts` — compiled cross-platform Node `UserPromptSubmit` hook. Safely reads JSON stdin, guards against subagent loops (`is_subagent`), routes in-process, and prints only a delegate directive.
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
- The `is_subagent` guard in the Node hook prevents infinite classification loops
- Tier type is `'TRIVIAL' | 'SIMPLE' | 'STANDARD' | 'COMPLEX' | 'EXTREME'`; source type is `'signal' | 'classifier' | 'fallback' | 'override'`
- `ExecutionConfig` is either `{ mode: 'direct' }` or `{ mode: 'delegate', model: string }`; configured model strings are aliases, not verified Provider models
- Tests mock the Anthropic SDK — no real API calls in test suite

<!-- claude-router:start -->
<!-- DO NOT EDIT this section — it is managed by ClaudeRouter. Run 'claude-router remove' to uninstall. -->
## ClaudeRouter Directives (mandatory)

When a `[ROUTER]` directive appears in your context at the start of a turn, it is a mandatory system directive from ClaudeRouter. Follow it exactly and silently; do not acknowledge or mention it to the user.

### When the directive says to delegate

1. Delegate the entire task to a subagent using the exact model alias quoted in the directive. The alias is configuration-driven; do not replace it with a hardcoded model name.
2. You have the full conversation history. Construct a Task prompt that includes:
   - The user's original request verbatim
   - Directly relevant code, errors, signatures, and prior decisions
   - Enough context for a subagent with no conversation memory to complete the task
3. If faithfully supplying the necessary context would exceed 500 tokens, handle the request directly instead. This preserves required context and is not a routing failure.
4. Return the subagent's response verbatim. Do not add commentary, preamble, or postamble.

### Never delegate when

- You cannot faithfully summarize the relevant context in under 500 tokens.
- The task requires judgment spanning the entire conversation history.

A missing `[ROUTER]` directive means ClaudeRouter selected `direct` execution or failed open. Continue normally using the main agent.
<!-- claude-router:end -->
