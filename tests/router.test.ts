import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig } from '../src/router/config';
import { buildDirective, route } from '../src/router/router';
import type { Tier } from '../src/types';

const { mockClassify } = vi.hoisted(() => ({
  mockClassify: vi.fn(),
}));

vi.mock('../src/classifier/classifier', () => ({
  classify: mockClassify,
}));

beforeEach(() => {
  mockClassify.mockReset();
  mockClassify.mockResolvedValue({
    tier: 'STANDARD',
    source: 'classifier',
    latencyMs: 1,
    promptTokens: 10,
    classifierModel: 'haiku',
  });
});

function classifyAs(tier: Tier): void {
  mockClassify.mockResolvedValueOnce({
    tier,
    source: 'classifier',
    latencyMs: 1,
    promptTokens: 10,
    classifierModel: 'test-classifier',
  });
}

describe('route', () => {
  it.each([
    ['TRIVIAL', { mode: 'delegate', model: 'haiku' }],
    ['SIMPLE', { mode: 'delegate', model: 'sonnet' }],
    ['STANDARD', { mode: 'direct' }],
    ['COMPLEX', { mode: 'delegate', model: 'opus' }],
    ['EXTREME', { mode: 'delegate', model: 'fable' }],
  ] as const)('resolves %s through its configured execution', async (tier, execution) => {
    classifyAs(tier);

    const decision = await route('ordinary task', DEFAULT_CONFIG);

    expect(decision.tier).toBe(tier);
    expect(decision.execution).toEqual(execution);
    if (execution.mode === 'delegate') {
      expect(decision.directive).toContain(`model "${execution.model}"`);
    } else {
      expect(decision.directive).toBeNull();
    }
  });

  it.each(['TRIVIAL', 'SIMPLE', 'STANDARD', 'COMPLEX', 'EXTREME'] as const)(
    'allows %s to be configured for direct execution',
    async (tier) => {
      classifyAs(tier);
      const config = mergeConfig(DEFAULT_CONFIG, { tiers: { [tier]: { mode: 'direct' } } });

      const decision = await route('ordinary task', config);

      expect(decision.execution).toEqual({ mode: 'direct' });
      expect(decision.directive).toBeNull();
    },
  );

  it('changes the delegate target from configuration alone', async () => {
    classifyAs('EXTREME');
    const config = mergeConfig(DEFAULT_CONFIG, {
      tiers: { EXTREME: { mode: 'delegate', model: 'frontier-v2' } },
    });

    const decision = await route('ordinary task', config);

    expect(decision.execution).toEqual({ mode: 'delegate', model: 'frontier-v2' });
    expect(decision.directive).toContain('model "frontier-v2"');
  });

  it('uses the configured override tier without invoking the classifier', async () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      overrides: { '//force': 'COMPLEX' },
    });

    const decision = await route('//FoRcE inspect the race condition', config);

    expect(decision).toMatchObject({
      tier: 'COMPLEX',
      source: 'override',
      execution: { mode: 'delegate', model: 'opus' },
      strippedPrompt: 'inspect the race condition',
    });
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it.each([
    ['TRIVIAL', 'SIMPLE'],
    ['SIMPLE', 'STANDARD'],
    ['STANDARD', 'COMPLEX'],
    ['COMPLEX', 'EXTREME'],
    ['EXTREME', 'EXTREME'],
  ] as const)('conservative mode shifts %s to %s before resolving execution', async (inputTier, outputTier) => {
    classifyAs(inputTier);
    const config = mergeConfig(DEFAULT_CONFIG, { conservative: true });

    const decision = await route('ordinary task', config);

    expect(decision.tier).toBe(outputTier);
    expect(decision.execution).toEqual(config.tiers[outputTier]);
  });

  it('retains a classifier fallback decision and resolves its configured execution', async () => {
    mockClassify.mockResolvedValueOnce({
      tier: 'STANDARD',
      source: 'fallback',
      latencyMs: 1,
      promptTokens: 0,
      classifierModel: 'haiku',
      classifierFailure: 'http_400',
    });

    const decision = await route('ordinary task', DEFAULT_CONFIG);

    expect(decision).toMatchObject({
      tier: 'STANDARD',
      source: 'fallback',
      execution: { mode: 'direct' },
      classifierFailure: 'http_400',
    });
  });
});

describe('buildDirective', () => {
  it('emits no directive for direct execution', () => {
    expect(buildDirective('STANDARD', { mode: 'direct' })).toBeNull();
  });

  it('only uses the configured delegate model', () => {
    expect(buildDirective('COMPLEX', { mode: 'delegate', model: 'arbitrary-alias' })).toContain(
      'model "arbitrary-alias"',
    );
  });
});
