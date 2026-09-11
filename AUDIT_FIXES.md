# ClaudeRouter Pre-Publication Audit Status

> Historical note: this document previously contained a pre-publication fix queue for
> the original three-tier implementation. The items below are retained as a concise
> completion record; the old Bash, `jq`, and three-tier instructions are obsolete.

## Current release contract

ClaudeRouter uses five shared tiers:

```text
TRIVIAL | SIMPLE | STANDARD | COMPLEX | EXTREME
```

A tier determines no intrinsic model. `config.tiers[tier]` selects either:

```ts
{ mode: 'direct' }
{ mode: 'delegate', model: 'configured-alias' }
```

A configured alias is a Router decision target, not evidence of the final model
selected by Claude Code, CC-Switch, or another Provider. Verify that external
mapping only from the Provider or Gateway request log's `model` field.

## Completed publication safeguards

- `LICENSE` contains the MIT license for ClaudeRouter Contributors.
- `package.json` declares `files`, `prepublishOnly`, Node.js `>=18`, package
  metadata, and relevant search keywords.
- The build copies `src/classifier/prompt.md` to `dist/classifier/prompt.md`.
- The published archive includes the compiled Node hook and excludes the removed
  legacy Bash hook.
- The CLI provides `--version` and `doctor` commands.
- README, CONTRIBUTING, plugin metadata, and the issue template describe the
  five-tier, configuration-driven behavior.

## Hook and installation contract

The `UserPromptSubmit` hook is implemented in TypeScript and runs as:

```text
node <absolute path>/dist/hooks/user-prompt-submit.js
```

It reads JSON safely from stdin, preserves the `is_subagent` recursion guard,
and fails open: exceptional input or runtime failures produce no stdout and a
successful process exit. The Hook has no runtime dependency on `bash`, `sh`,
`jq`, `grep`, `sed`, `awk`, `stat`, or `/tmp`.

`claude-router init` safely registers the compiled Node Hook and upgrades this
package's legacy Bash registration when present. It changes user configuration,
so run it only when installation is intended.

## Verification

Before publishing a new revision, run:

```bash
npm run build
npm test
npm pack --dry-run
node dist/cli/index.js --version
node dist/cli/index.js doctor
```

`doctor` can correctly report an unregistered Hook on a machine where
`claude-router init` has not been run. That is an installation-state result, not
a Router implementation failure.

For behavior and privacy expectations, see [README.md](README.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).
