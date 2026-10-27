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
