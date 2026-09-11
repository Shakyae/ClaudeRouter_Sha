---
name: Bug report
about: Something isn't working as expected
labels: bug
---

**Environment**
- OS:
- Node version (`node -v`):
- Claude Code version (`claude --version`):
- claude-router version (`claude-router --version`):

**What happened?**


**What did you expect?**


**Stats output**
```
(paste output of `claude-router stats` here)
```

**Hook registration**
```
(paste the `hooks.UserPromptSubmit` entry from ~/.claude/settings.json here)
```

**Provider mapping, if relevant**

If the configured alias was not resolved to the expected final Provider model, include the Provider or Gateway request log's `model` field with secrets removed. ClaudeRouter can report its configured alias but cannot verify external model resolution.
