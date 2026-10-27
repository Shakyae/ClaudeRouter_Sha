import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig } from '../src/router/config';
import { resolveFallbacks } from '../src/router/model-map';

describe('resolveFallbacks', () => {
  it.each([
    ['SIMPLE', []],
    ['STANDARD', ['haiku']],
    ['COMPLEX', ['sonnet', 'haiku']],
    ['EXTREME', ['opus', 'sonnet', 'haiku']],
  ] as const)('derives the default chain for %s', (tier, expected) => {
    expect(resolveFallbacks(tier, DEFAULT_CONFIG)).toEqual(expected);
  });

  it('skips a lower tier configured for direct execution', () => {
    const config = mergeConfig(DEFAULT_CONFIG, { tiers: { STANDARD: { mode: 'direct' } } });

    expect(resolveFallbacks('COMPLEX', config)).toEqual(['haiku']);
  });

  it('returns no chain when the tier itself is direct', () => {
    const config = mergeConfig(DEFAULT_CONFIG, { tiers: { COMPLEX: { mode: 'direct' } } });

    expect(resolveFallbacks('COMPLEX', config)).toEqual([]);
  });

  it('returns no chain when every lower tier is direct', () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      tiers: { SIMPLE: { mode: 'direct' }, STANDARD: { mode: 'direct' }, COMPLEX: { mode: 'direct' } },
    });

    expect(resolveFallbacks('EXTREME', config)).toEqual([]);
  });

  it('deduplicates models shared with the main model or earlier chain entries', () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      tiers: { STANDARD: { mode: 'delegate', model: 'opus' } },
    });

    expect(resolveFallbacks('COMPLEX', config)).toEqual(['haiku']);
  });

  it('deduplicates case and [1M] variants while preserving configured spelling', () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      tiers: {
        SIMPLE: { mode: 'delegate', model: 'Haiku' },
        STANDARD: { mode: 'delegate', model: 'Opus[1M]' },
      },
    });

    expect(resolveFallbacks('COMPLEX', config)).toEqual(['Haiku']);
  });

  it('does not apply the conservative shift itself', () => {
    // route() passes the already-shifted tier; shifting again here would move
    // COMPLEX to EXTREME and reverse the chain.
    const config = mergeConfig(DEFAULT_CONFIG, { conservative: true });

    expect(resolveFallbacks('COMPLEX', config)).toEqual(['sonnet', 'haiku']);
    expect(resolveFallbacks('EXTREME', config)).toEqual(['opus', 'sonnet', 'haiku']);
  });
});
