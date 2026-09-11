import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouterConfig } from '../../src/router/config';
import type { RoutingDecision } from '../../src/types';

const { mockLoadConfig, mockRoute, mockLogDecision, mockRecordRoutingEvent } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockRoute: vi.fn(),
  mockLogDecision: vi.fn(),
  mockRecordRoutingEvent: vi.fn(),
}));

vi.mock('../../src/router/config', () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock('../../src/router/router', () => ({
  route: mockRoute,
}));

vi.mock('../../src/telemetry/logger', () => ({
  getSessionId: vi.fn(() => 'test-session'),
  hashPrompt: vi.fn(() => 'prompt-hash'),
  logDecision: mockLogDecision,
}));

vi.mock('../../src/telemetry/feedback', () => ({
  recordRoutingEvent: mockRecordRoutingEvent,
}));

import { processHookInput } from '../../src/hooks/user-prompt-submit';

const config: RouterConfig = {
  tiers: {
    TRIVIAL: { mode: 'delegate', model: 'haiku' },
    SIMPLE: { mode: 'delegate', model: 'sonnet' },
    STANDARD: { mode: 'direct' },
    COMPLEX: { mode: 'delegate', model: 'opus' },
    EXTREME: { mode: 'delegate', model: 'fable' },
  },
  classifier: { model: 'haiku', timeout_ms: 3000 },
  fallback_tier: 'STANDARD',
  conservative: false,
  overrides: {},
  debug: { enabled: false, prompt_preview_chars: 150 },
};

function decision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    tier: 'TRIVIAL',
    source: 'signal',
    execution: { mode: 'delegate', model: 'haiku' },
    directive: '[ROUTER] Complexity: TRIVIAL. Delegate the entire task to a subagent using model "haiku".',
    latencyMs: 12,
    strippedPrompt: 'find the function',
    ...overrides,
  };
}

describe('Node UserPromptSubmit hook', () => {
  beforeEach(() => {
    mockLoadConfig.mockReset();
    mockRoute.mockReset();
    mockLogDecision.mockReset();
    mockRecordRoutingEvent.mockReset();
    mockLoadConfig.mockReturnValue(config);
    mockRoute.mockResolvedValue(decision());
  });

  it('routes parsed JSON input through the Router API without shell interpolation', async () => {
    const output = await processHookInput({
      prompt: 'find the function',
      cwd: 'C:/workspace/project',
    });

    expect(output).toContain('[ROUTER] Complexity: TRIVIAL');
    expect(mockLoadConfig).toHaveBeenCalledWith('C:/workspace/project');
    expect(mockRoute).toHaveBeenCalledWith('find the function', config);
    expect(mockLogDecision).toHaveBeenCalledWith(expect.objectContaining({
      tier: 'TRIVIAL',
      execution_mode: 'delegate',
      configured_model: 'haiku',
      latency_ms: 12,
    }));
    expect(mockRecordRoutingEvent).toHaveBeenCalledOnce();
  });

  it('suppresses output for configured direct execution while retaining telemetry', async () => {
    mockRoute.mockResolvedValueOnce(decision({
      tier: 'STANDARD',
      execution: { mode: 'direct' },
      directive: null,
    }));

    await expect(processHookInput({ prompt: 'continue' })).resolves.toBe('');
    expect(mockLogDecision).toHaveBeenCalledWith(expect.objectContaining({
      tier: 'STANDARD',
      execution_mode: 'direct',
    }));
    expect(mockLogDecision.mock.calls[0][0]).not.toHaveProperty('configured_model');
  });

  it('preserves the subagent recursion guard and ignores invalid payloads', async () => {
    await expect(processHookInput({ prompt: 'task', is_subagent: true })).resolves.toBe('');
    await expect(processHookInput({ prompt: '   ' })).resolves.toBe('');
    await expect(processHookInput({})).resolves.toBe('');
    await expect(processHookInput(null)).resolves.toBe('');

    expect(mockLoadConfig).not.toHaveBeenCalled();
    expect(mockRoute).not.toHaveBeenCalled();
    expect(mockLogDecision).not.toHaveBeenCalled();
  });

  it('fails open for configuration and routing errors', async () => {
    mockLoadConfig.mockImplementationOnce(() => {
      throw new Error('invalid config');
    });
    await expect(processHookInput({ prompt: 'task' })).resolves.toBe('');

    mockRoute.mockRejectedValueOnce(new Error('classifier unavailable'));
    await expect(processHookInput({ prompt: 'task' })).resolves.toBe('');
  });
});
