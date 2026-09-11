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
