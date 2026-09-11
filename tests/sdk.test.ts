import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutingDecision, Tier } from '../src/types';

const { mockRoute } = vi.hoisted(() => ({
  mockRoute: vi.fn(),
}));

vi.mock('../src/router/router', () => ({
  route: mockRoute,
}));

import { createRouter } from '../src/sdk/factory';

function decision(tier: Tier, source: RoutingDecision['source'] = 'classifier'): RoutingDecision {
  const execution = tier === 'STANDARD'
    ? { mode: 'direct' as const }
    : { mode: 'delegate' as const, model: `${tier.toLowerCase()}-alias` };

  return {
    tier,
    source,
    execution,
    directive: execution.mode === 'delegate' ? '[ROUTER] test' : null,
    latencyMs: 10,
    strippedPrompt: 'test',
  };
}

describe('SDK router instance', () => {
  beforeEach(() => {
    mockRoute.mockReset();
  });

  it('returns five-tier session statistics without telemetry side effects', async () => {
    mockRoute.mockResolvedValue(decision('STANDARD'));
    const router = createRouter({ telemetry: false });

    for (const tier of ['TRIVIAL', 'SIMPLE', 'STANDARD', 'COMPLEX', 'EXTREME'] as const) {
      mockRoute.mockResolvedValueOnce(decision(tier, tier === 'EXTREME' ? 'override' : 'classifier'));
      await router.route(`prompt for ${tier}`);
    }

    const stats = router.stats();
    expect(stats).toEqual({
      total: 5,
      tiers: {
        TRIVIAL: 1,
        SIMPLE: 1,
        STANDARD: 1,
        COMPLEX: 1,
        EXTREME: 1,
      },
      overrides: 1,
      avg_latency_ms: 10,
    });

    stats.tiers.TRIVIAL = 99;
    expect(router.stats().tiers.TRIVIAL).toBe(1);
  });
});
