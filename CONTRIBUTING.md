# Contributing to ClaudeRouter

## Local development setup

```bash
git clone https://github.com/0dust/ClaudeRouter.git
cd ClaudeRouter
npm install
npm run build
```

To iterate without reinstalling globally, run the CLI from the build output:

```bash
node dist/cli/index.js route "your prompt here" --format full
```

To install globally from source (the published package is `@0dust/claude-router`):

```bash
npm install -g .
```

## Running tests

```bash
npm test                              # run all tests
npx vitest run tests/signals.test.ts  # run a single file
npx vitest                            # watch mode
npm run build                         # compile TypeScript and package prompt.md
```

Tests mock the Anthropic SDK; no `ANTHROPIC_API_KEY` is required.

## Testing the plugin hook locally

Build first, then invoke the compiled Node hook. It reads one JSON object from stdin and writes a routing directive only for delegated execution:

```text
node dist/hooks/user-prompt-submit.js
```

Feed this program a JSON payload using your platform's standard stdin mechanism, for example:

```json
{"prompt":"find calculatePrice","is_subagent":false}
```

The hook must remain independent of `bash`, `sh`, `jq`, `grep`, `sed`, `awk`, `stat`, and `/tmp`. Test the public API without a shell pipeline when convenient:

```bash
node -e "require('./dist/hooks/user-prompt-submit').processHookInput({ prompt: 'find calculatePrice' }).then(console.log)"
```

To load the plugin into a live Claude Code session without reinstalling globally:

```bash
claude --plugin-dir /path/to/claude-router
```

This loads the plugin for that session only.

## Project structure

```text
src/
  types.ts            # shared five-tier domain types and routing decision
  classifier/
    signals.ts         # synchronous high-confidence heuristics
    classifier.ts      # full classify(): signals, classifier, then fallback
    prompt.md          # classifier prompt template
  router/
    router.ts          # route(): override, classify, execution-aware directive
    model-map.ts       # conservative tier shift and configured execution lookup
    config.ts          # schema-aware defaults → global → project config merge
  hooks/
    user-prompt-submit.ts # cross-platform Claude Code Node hook
  cli/
    index.ts           # CLI entry point
    init.ts            # Node-hook registration and managed CLAUDE.md block
    doctor.ts          # installation checks
    stats.ts           # event aggregation and configured-target display
  sdk/
    factory.ts          # createRouter(): stateful router with session stats
    index.ts            # public re-exports
  telemetry/
    logger.ts           # events.jsonl writer and legacy normalization
    feedback.ts         # TRIVIAL follow-up-rate tracking
hooks/
  hooks.json            # plugin hook registration
runtime-claude.md       # installed mandatory routing directive block
.claude-plugin/
  plugin.json           # plugin metadata
```

## Five-tier contract

All routing consumers use the shared `Tier` from `src/types.ts`:

```ts
TRIVIAL | SIMPLE | STANDARD | COMPLEX | EXTREME
```

Do not reintroduce legacy `LOW`, `MEDIUM`, or `HIGH` types. They may appear only in telemetry migration code and compatibility tests.

`ExecutionConfig` is separate from `Tier`:

```ts
{ mode: 'direct' }
{ mode: 'delegate', model: 'configured-alias' }
```

The Router must resolve execution from `config.tiers[tier]`; no tier name has intrinsically direct or delegated behavior. `model` is a configured alias, not proof of the final Provider model.

## Adding or tuning signal heuristics

All fast-path heuristics are in `src/classifier/signals.ts`. `quickClassify()` returns a `Tier` or `null`; `null` proceeds to the configured classifier model.

- Prefer `null` to an unjustified tier.
- Do not use prompt length alone to escalate complexity.
- Keep follow-up responses at `STANDARD` so the main agent retains conversation context.
- Add matching coverage to `tests/signals.test.ts`.
- Run `npm test` after changes.

## Changing the classifier prompt

Edit `src/classifier/prompt.md`. The template must contain `{{PROMPT}}`. It instructs the classifier to return exactly one of the five tier names. `parseTier()` accepts limited response variation, but the prompt should remain tightly constrained.

## Configuration schema

`RouterConfig` and `RouterConfigInput` are defined in `src/router/config.ts`. For a new field:

1. Add it to both relevant interfaces.
2. Add a safe default in `DEFAULT_CONFIG`.
3. Merge and validate it schema-aware in the dedicated merge function.
4. Add fail-open tests for malformed global and project configuration.

Do not shallow-merge nested configuration or allow malformed values to erase a valid inherited value.

## Telemetry and debug logging

Events are appended to `~/.claude-router/events.jsonl`. Prompt text is never stored there: use only the existing SHA-256 prompt hash. For delegate events, record `configured_model`; do not label it as the actual Provider model.

Debug JSONL is opt-in through `CLAUDE_ROUTER_DEBUG=1` or `debug.enabled`. It may write the configured-length prompt preview, never an unbounded prompt or API key. Hook and telemetry paths must never throw or interfere with routing.
