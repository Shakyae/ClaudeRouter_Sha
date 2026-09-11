import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig } from '../src/router/config';
import { classify, parseTier } from '../src/classifier/classifier';

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: 'STANDARD' }],
    usage: { input_tokens: 50 },
  });
});

afterEach(() => {
  delete process.env.CLAUDE_ROUTER_CLASSIFIER_MODEL;
});

describe('classify', () => {
  it.each(['TRIVIAL', 'SIMPLE', 'STANDARD', 'COMPLEX', 'EXTREME'] as const)(
    'accepts %s from the classifier',
    async (tier) => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: tier }],
        usage: { input_tokens: 50 },
      });

      const result = await classify('implement a normal feature', DEFAULT_CONFIG);

      expect(result).toMatchObject({ tier, source: 'classifier', promptTokens: 50, classifierModel: 'haiku' });
    },
  );

  it('uses the configured fallback tier for invalid classifier output', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'unknown' }], usage: { input_tokens: 7 } });
    const config = mergeConfig(DEFAULT_CONFIG, { fallback_tier: 'COMPLEX' });

    const result = await classify('implement a normal feature', config);

    expect(result).toMatchObject({ tier: 'COMPLEX', source: 'fallback', promptTokens: 7 });
  });

  it('uses the configured fallback tier after an API error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API error'));
    const config = mergeConfig(DEFAULT_CONFIG, { fallback_tier: 'SIMPLE' });

    const result = await classify('implement a normal feature', config);

    expect(result).toMatchObject({ tier: 'SIMPLE', source: 'fallback', promptTokens: 0 });
  });

  it('uses the configured classifier model and timeout', async () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      classifier: { model: 'cheap-classifier', timeout_ms: 1234 },
    });

    await classify('implement a normal feature', config);

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'cheap-classifier' }), { timeout: 1234 });
  });

  it('prioritizes CLAUDE_ROUTER_CLASSIFIER_MODEL over config', async () => {
    process.env.CLAUDE_ROUTER_CLASSIFIER_MODEL = 'environment-classifier';

    const result = await classify('implement a normal feature', DEFAULT_CONFIG);

    expect(result.classifierModel).toBe('environment-classifier');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'environment-classifier' }), expect.anything());
  });

  it('does not call the API for high-confidence signals', async () => {
    const result = await classify('fix typo', DEFAULT_CONFIG);

    expect(result).toMatchObject({ tier: 'TRIVIAL', source: 'signal' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('keeps context-dependent confirmations at STANDARD', async () => {
    const result = await classify('continue', DEFAULT_CONFIG);

    expect(result).toMatchObject({ tier: 'STANDARD', source: 'signal' });
  });
});

describe('parseTier', () => {
  it('prefers exact output and uses longest-first fallback parsing', () => {
    expect(parseTier(' simple ')).toBe('SIMPLE');
    expect(parseTier('The selected tier is EXTREME.')).toBe('EXTREME');
    expect(parseTier('unknown')).toBeNull();
  });
});
