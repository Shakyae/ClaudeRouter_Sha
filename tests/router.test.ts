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
    ['SIMPLE', { mode: 'delegate', model: 'haiku' }],
    ['STANDARD', { mode: 'delegate', model: 'sonnet' }],
    ['COMPLEX', { mode: 'delegate', model: 'opus' }],
    ['EXTREME', { mode: 'delegate', model: 'fable' }],
  ] as const)('resolves %s through its configured execution', async (tier, execution) => {
    classifyAs(tier);

    const decision = await route('ordinary task', DEFAULT_CONFIG);

    expect(decision.tier).toBe(tier);
    expect(decision.execution).toEqual(execution);
    if (execution.mode === 'delegate') {
      expect(decision.directive).toContain(`Complexity: ${tier}.`);
      expect(decision.directive).toContain(`model "${execution.model}"`);
    } else {
      expect(decision.directive).toBeNull();
    }
  });

  it.each(['SIMPLE', 'STANDARD', 'COMPLEX', 'EXTREME'] as const)(
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
    expect(decision.directive).toContain('Complexity: EXTREME.');
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
    expect(decision.directive).toContain('Complexity: COMPLEX.');
    expect(decision.directive).toContain('model "opus"');
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it.each([
    ['SIMPLE', 'STANDARD'],
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
    if (decision.execution.mode === 'delegate') {
      expect(decision.directive).toContain(`Complexity: ${outputTier}.`);
      expect(decision.directive).toContain(`model "${decision.execution.model}"`);
    }
  });

  it('retains a classifier fallback decision and resolves its configured execution', async () => {
    mockClassify.mockResolvedValueOnce({
      tier: 'STANDARD',
      source: 'fallback',
      latencyMs: 1,
      promptTokens: 0,
      classifierModel: 'MiniMax-M3.1-Flash[1M]',
      classifierRequestModel: 'MiniMax-M3.1-Flash',
      classifierFailure: 'http_503',
      classifierError: '当前集群负载较高',
    });

    const decision = await route('ordinary task', DEFAULT_CONFIG);

    expect(decision).toMatchObject({
      tier: 'STANDARD',
      source: 'fallback',
      execution: { mode: 'delegate', model: 'sonnet' },
      classifierRequestModel: 'MiniMax-M3.1-Flash',
      classifierFailure: 'http_503',
      classifierError: '当前集群负载较高',
    });
    expect(decision.directive).toContain('model "sonnet"');
    expect(decision.directive).not.toContain('MiniMax');
  });

  it('keeps the reason when classify() itself throws', async () => {
    mockClassify.mockRejectedValueOnce(new Error('当前集群负载较高 (Bearer secret-token)'));

    const decision = await route('ordinary task', DEFAULT_CONFIG);

    expect(decision).toMatchObject({
      source: 'fallback',
      classifierFailure: 'request_error',
      classifierError: '当前集群负载较高 (Bearer [redacted])',
    });
  });
});

describe('fallback chain in route decisions', () => {
  it('derives the chain from lower tiers on the classifier path', async () => {
    classifyAs('COMPLEX');

    const decision = await route('ordinary task', DEFAULT_CONFIG);

    expect(decision.fallbacks).toEqual(['sonnet', 'haiku']);
    expect(decision.directive).toContain('retry the same task once each with "sonnet", then "haiku", in that order');
  });

  it('derives the chain on the override path', async () => {
    const decision = await route('//complex inspect the race condition', DEFAULT_CONFIG);

    expect(decision.source).toBe('override');
    expect(decision.fallbacks).toEqual(['sonnet', 'haiku']);
    expect(decision.directive).toContain('with "sonnet", then "haiku"');
  });

  it('derives the chain on the classifier failure path', async () => {
    mockClassify.mockRejectedValueOnce(new Error('boom'));
    const config = mergeConfig(DEFAULT_CONFIG, { fallback_tier: 'COMPLEX' });

    const decision = await route('ordinary task', config);

    expect(decision.source).toBe('fallback');
    expect(decision.tier).toBe('COMPLEX');
    expect(decision.fallbacks).toEqual(['sonnet', 'haiku']);
  });

  it('derives the chain from the effective tier under conservative mode', async () => {
    classifyAs('STANDARD');
    const config = mergeConfig(DEFAULT_CONFIG, { conservative: true });

    const decision = await route('ordinary task', config);

    expect(decision.tier).toBe('COMPLEX');
    expect(decision.fallbacks).toEqual(['sonnet', 'haiku']);
    expect(decision.directive).toContain('model "opus"');
    expect(decision.directive).toContain('with "sonnet", then "haiku"');
  });

  it('emits no chain for SIMPLE and no directive for direct execution', async () => {
    classifyAs('SIMPLE');
    const simple = await route('ordinary task', DEFAULT_CONFIG);
    expect(simple.fallbacks).toEqual([]);
    expect(simple.directive).not.toContain('retry the same task');

    classifyAs('STANDARD');
    const directConfig = mergeConfig(DEFAULT_CONFIG, { tiers: { STANDARD: { mode: 'direct' } } });
    const direct = await route('ordinary task', directConfig);
    expect(direct.fallbacks).toEqual([]);
    expect(direct.directive).toBeNull();
  });
});

describe('buildDirective', () => {
  it('emits no directive for direct execution', () => {
    expect(buildDirective('STANDARD', { mode: 'direct' })).toBeNull();
  });

  it('emits the effective tier and configured delegate model in a stable format', () => {
    expect(buildDirective('COMPLEX', { mode: 'delegate', model: 'arbitrary-alias' })).toBe(
      '[ROUTER] Complexity: COMPLEX. Delegate the entire task to a subagent using model "arbitrary-alias". Let the subagent inspect and modify the repository as needed. After it finishes, do not redo the implementation independently.',
    );
  });

  it('keeps the empty-chain directive byte-identical to the two-argument form', () => {
    expect(buildDirective('COMPLEX', { mode: 'delegate', model: 'arbitrary-alias' }, [])).toBe(
      buildDirective('COMPLEX', { mode: 'delegate', model: 'arbitrary-alias' }),
    );
  });

  it('appends the fallback instruction after the no-redo rule', () => {
    expect(buildDirective('COMPLEX', { mode: 'delegate', model: 'opus' }, ['sonnet', 'haiku'])).toBe(
      '[ROUTER] Complexity: COMPLEX. Delegate the entire task to a subagent using model "opus". Let the subagent inspect and modify the repository as needed. After it finishes, do not redo the implementation independently. If the delegation itself fails because that model is unavailable, retry the same task once each with "sonnet", then "haiku", in that order; retrying a failed delegation is not a redo. If every model fails, stop and report the errors. If a fallback model completed the task, tell the user which model actually ran it.',
    );
  });
});
