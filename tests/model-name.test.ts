import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveModelAlias, sanitizeModelName } from '../src/classifier/model-name';

describe('resolveModelAlias', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['haiku', 'sonnet', 'opus', 'fable'])(
    'resolves the %s alias case-insensitively without applying classifier overrides',
    (alias) => {
      vi.stubEnv(`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`, '  gateway-model[1M]  ');
      vi.stubEnv('CLAUDE_ROUTER_CLASSIFIER_MODEL', 'classifier-only');

      expect(resolveModelAlias(`  ${alias.toUpperCase()}  `)).toBe('gateway-model[1M]');
    },
  );

  it.each([undefined, '', '  '])('ignores an unset or blank mapping: %s', (value) => {
    vi.stubEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', value ?? '');
    if (value === undefined) delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;

    expect(resolveModelAlias('sonnet')).toBeUndefined();
  });

  it('does not replace an explicit model name', () => {
    vi.stubEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', 'gateway-sonnet');

    expect(resolveModelAlias('deepseek-v4.1-flash')).toBeUndefined();
  });
});

describe('sanitizeModelName', () => {
  it.each([
    ['MiniMax-M3[1M]', 'MiniMax-M3'],
    ['MiniMax-M3[1m]', 'MiniMax-M3'],
    ['MiniMax-M3[1m][1M]', 'MiniMax-M3'],
    ['  MiniMax-M3[1M]  ', 'MiniMax-M3'],
    ['claude-haiku-4-5', 'claude-haiku-4-5'],
    ['gpt-6.1-sol(high)[1M]', 'gpt-6.1-sol(high)'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(sanitizeModelName(input)).toBe(expected);
  });

  it('does not strip a marker that is not a trailing 1M tag', () => {
    expect(sanitizeModelName('model[1m]preview')).toBe('model[1m]preview');
    expect(sanitizeModelName('model[2M]')).toBe('model[2M]');
    expect(sanitizeModelName('model[1M]-turbo')).toBe('model[1M]-turbo');
  });

  it('keeps a name that is only a marker so routing still reports something', () => {
    expect(sanitizeModelName('[1M]')).toBe('[1M]');
  });
});
