// Claude Code exposes one runtime model mapping per alias.
const ALIAS_ENV_VARS: Record<string, string> = {
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};

/** Returns the environment mapping, if present; does not apply classifier overrides. */
export function resolveModelAlias(model: string): string | undefined {
  const envVar = ALIAS_ENV_VARS[model.trim().toLowerCase()];
  const value = envVar ? process.env[envVar]?.trim() : undefined;
  return value || undefined;
}

// Claude Code appends a `[1M]` marker to model names that declare 1M context
// (see its own `replace(/(\[1m\])+$/i, "")` normalization). Gateways match model
// names exactly, so the marker must be removed before the name leaves the process.
const ONE_M_SUFFIX = /(?:\[1m\])+$/i;

export function sanitizeModelName(model: string): string {
  const trimmed = model.trim();
  const stripped = trimmed.replace(ONE_M_SUFFIX, '').trimEnd();
  return stripped || trimmed;
}
