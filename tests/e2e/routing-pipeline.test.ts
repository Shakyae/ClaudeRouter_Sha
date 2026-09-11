import { describe, it, expect, vi, beforeEach } from 'vitest';
import { route } from '../../src/router/router';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/router/config';
import { TIERS, type RoutingDecision } from '../../src/types';

const { mockCreate } = vi.hoisted(() => {
  const mockCreate = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'MEDIUM' }],
    usage: { input_tokens: 50 },
  });
  return { mockCreate };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

const defaultConfig = DEFAULT_CONFIG;

function validateShape(decision: RoutingDecision): void {
  expect(TIERS).toContain(decision.tier);
  expect(['signal', 'classifier', 'fallback', 'override']).toContain(decision.source);
  expect(decision.latencyMs).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(decision.latencyMs)).toBe(true);
  expect(typeof decision.strippedPrompt).toBe('string');

  if (decision.execution.mode === 'delegate') {
    expect(decision.directive).toContain(`model \"${decision.execution.model}\"`);
  } else {
    expect(decision.directive).toBeNull();
  }
}

describe('routing pipeline e2e', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'STANDARD' }],
      usage: { input_tokens: 50 },
    });
  });

  it('uses high-confidence TRIVIAL signals without calling the classifier', async () => {
    const decision = await route('find calculatePrice', defaultConfig);

    validateShape(decision);
    expect(decision).toMatchObject({
      tier: 'TRIVIAL',
      source: 'signal',
      execution: { mode: 'delegate', model: 'haiku' },
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('keeps follow-up prompts direct at STANDARD without calling the classifier', async () => {
    const decision = await route('continue', defaultConfig);

    validateShape(decision);
    expect(decision).toMatchObject({
      tier: 'STANDARD',
      source: 'signal',
      execution: { mode: 'direct' },
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('defers long prompts to the classifier instead of escalating by length', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'SIMPLE' }],
      usage: { input_tokens: 50 },
    });

    const decision = await route(Array(150).fill('ordinary').join(' '), defaultConfig);

    validateShape(decision);
    expect(decision).toMatchObject({
      tier: 'SIMPLE',
      source: 'classifier',
      execution: { mode: 'delegate', model: 'sonnet' },
    });
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it.each([
    ['TRIVIAL', { mode: 'delegate', model: 'haiku' }],
    ['SIMPLE', { mode: 'delegate', model: 'sonnet' }],
    ['STANDARD', { mode: 'direct' }],
    ['COMPLEX', { mode: 'delegate', model: 'opus' }],
    ['EXTREME', { mode: 'delegate', model: 'fable' }],
  ] as const)('routes classifier result %s through its configured execution', async (tier, execution) => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: tier }],
      usage: { input_tokens: 50 },
    });

    const decision = await route('implement a feature', defaultConfig);

    validateShape(decision);
    expect(decision.tier).toBe(tier);
    expect(decision.source).toBe('classifier');
    expect(decision.execution).toEqual(execution);
  });

  it('uses the configured fallback execution after an invalid classifier response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not a tier' }],
      usage: { input_tokens: 50 },
    });

    const decision = await route('implement a feature', defaultConfig);

    validateShape(decision);
    expect(decision).toMatchObject({
      tier: 'STANDARD',
      source: 'fallback',
      execution: { mode: 'direct' },
    });
  });

  it('strips the longest configured override prefix and bypasses the classifier', async () => {
    const config = mergeConfig(defaultConfig, {
      overrides: { '//force': 'COMPLEX', '//force-extreme': 'EXTREME' },
    });

    const decision = await route('//force-extreme inspect the design', config);

    validateShape(decision);
    expect(decision).toMatchObject({
      tier: 'EXTREME',
      source: 'override',
      strippedPrompt: 'inspect the design',
      execution: { mode: 'delegate', model: 'fable' },
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('applies conservative shifting before looking up configured execution', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'STANDARD' }],
      usage: { input_tokens: 50 },
    });

    const decision = await route('implement a feature', mergeConfig(defaultConfig, { conservative: true }));

    validateShape(decision);
    expect(decision).toMatchObject({
      tier: 'COMPLEX',
      execution: { mode: 'delegate', model: 'opus' },
    });
  });
});
