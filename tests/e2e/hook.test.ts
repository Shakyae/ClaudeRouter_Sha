import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { RouterConfig } from '../../src/router/config';
import type { RoutingDecision } from '../../src/types';

const { mockLoadConfig, mockRoute, mockLogDecision, mockRecordRoutingEvent, mockHomedir } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockRoute: vi.fn(),
  mockLogDecision: vi.fn(),
  mockRecordRoutingEvent: vi.fn(),
  mockHomedir: vi.fn(),
}));

vi.mock('../../src/router/config', () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock('../../src/router/router', () => ({
  route: mockRoute,
}));

vi.mock('../../src/telemetry/logger', () => ({
  getLocalTimestamp: vi.fn(() => '2026-09-12T06:00:00.000+08:00'),
  getSessionId: vi.fn(() => 'test-session'),
  hashPrompt: vi.fn(() => 'prompt-hash'),
  logDecision: mockLogDecision,
}));

vi.mock('../../src/telemetry/feedback', () => ({
  recordRoutingEvent: mockRecordRoutingEvent,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: mockHomedir };
});

import { handleHookInput, processHookInput, serializeHookOutput } from '../../src/hooks/user-prompt-submit';

let homeDir: string;

const config: RouterConfig = {
  tiers: {
    SIMPLE: { mode: 'delegate', model: 'haiku' },
    STANDARD: { mode: 'delegate', model: 'sonnet' },
    COMPLEX: { mode: 'delegate', model: 'opus' },
    EXTREME: { mode: 'delegate', model: 'fable' },
  },
  classifier: { model: 'haiku', timeout_ms: 10000, max_tokens: 256, max_retries: 1, budget_ms: 20000 },
  fallback_tier: 'STANDARD',
  conservative: false,
  overrides: {},
  debug: { enabled: false, prompt_preview_chars: 150 },
};

function decision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    tier: 'SIMPLE',
    source: 'signal',
    execution: { mode: 'delegate', model: 'haiku' },
    directive: '[ROUTER] Complexity: SIMPLE. Delegate the entire task to a subagent using model "haiku".',
    latencyMs: 12,
    strippedPrompt: 'find the function',
    ...overrides,
  };
}

describe('Node UserPromptSubmit hook', () => {
  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), 'claude-router-hook-'));
    mockHomedir.mockReturnValue(homeDir);
    mockLoadConfig.mockReset();
    mockRoute.mockReset();
    mockLogDecision.mockReset();
    mockRecordRoutingEvent.mockReset();
    mockLoadConfig.mockReturnValue(config);
    mockRoute.mockResolvedValue(decision());
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('routes parsed JSON input through the Router API without shell interpolation', async () => {
    const delegatedDecision = decision();
    mockRoute.mockResolvedValueOnce(delegatedDecision);

    const output = await handleHookInput({
      prompt: 'find the function',
      cwd: 'C:/workspace/project',
    });

    expect(output).toEqual({ additionalContext: delegatedDecision.directive });
    expect(mockLoadConfig).toHaveBeenCalledWith('C:/workspace/project');
    expect(mockRoute).toHaveBeenCalledWith('find the function', config);
    expect(mockLogDecision).toHaveBeenCalledWith(expect.objectContaining({
      tier: 'SIMPLE',
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
    await expect(processHookInput({ prompt: 'task', agent_id: 'agent-123' })).resolves.toBe('');
    await expect(processHookInput({ prompt: '   ' })).resolves.toBe('');
    await expect(processHookInput({})).resolves.toBe('');
    await expect(processHookInput(null)).resolves.toBe('');

    expect(mockLoadConfig).not.toHaveBeenCalled();
    expect(mockRoute).not.toHaveBeenCalled();
    expect(mockLogDecision).not.toHaveBeenCalled();
  });

  it('routes main-agent payloads that carry an empty agent_id', async () => {
    await expect(processHookInput({ prompt: 'task', agent_id: '' })).resolves.toBe(decision().directive);
  });

  it('passes the fallback chain through inside the directive unchanged', async () => {
    const withChain = decision({
      tier: 'COMPLEX',
      execution: { mode: 'delegate', model: 'opus' },
      fallbacks: ['sonnet', 'haiku'],
      directive: '[ROUTER] Complexity: COMPLEX. ... with "sonnet", then "haiku", in that order.',
    });
    mockRoute.mockResolvedValueOnce(withChain);

    const output = await handleHookInput({ prompt: 'inspect the race condition' });

    expect(output).toEqual({ additionalContext: withChain.directive });
    expect(output.additionalContext).toContain('"sonnet", then "haiku"');
  });

  it('adds no extra output for an empty chain', async () => {
    mockRoute.mockResolvedValueOnce(decision({ fallbacks: [] }));

    const output = await handleHookInput({ prompt: 'find the function' });

    expect(output).toEqual({ additionalContext: decision().directive });
    expect(serializeHookOutput(output)).toBe(decision().directive);
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

describe('fallback UI notice', () => {
  beforeEach(() => {
    homeDir = mkdtempSync(path.join(tmpdir(), 'claude-router-hook-'));
    mockHomedir.mockReturnValue(homeDir);
    mockLoadConfig.mockReturnValue(config);
    mockRoute.mockResolvedValue(decision());
    for (const name of [
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'CLAUDE_ROUTER_CLASSIFIER_MODEL',
    ]) {
      vi.stubEnv(name, '');
      delete process.env[name];
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('reports nothing extra when classification succeeds', async () => {
    const output = await handleHookInput({ prompt: 'find the function' });

    expect(output.systemMessage).toBeUndefined();
    expect(serializeHookOutput(output)).not.toContain('systemMessage');
  });

  it('shows the fallback delegate model rather than the classifier model', async () => {
    vi.stubEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', 'deepseek-v4.1-flash[1M]');
    vi.stubEnv('CLAUDE_ROUTER_CLASSIFIER_MODEL', 'MiniMax-M3');
    mockRoute.mockResolvedValueOnce(decision({
      tier: 'STANDARD',
      source: 'fallback',
      execution: { mode: 'delegate', model: 'sonnet' },
      directive: '[ROUTER] Complexity: STANDARD.',
      classifierFailure: 'timeout',
      classifierModel: 'MiniMax-M3[1M]',
      classifierRequestModel: 'MiniMax-M3',
    }));

    const output = await handleHookInput({ prompt: 'implement something' });

    expect(output.systemMessage).toBe(
      'ClaudeRouter: classifier timeout; fell back to STANDARD, delegate model deepseek-v4.1-flash.',
    );
    const payload = JSON.parse(serializeHookOutput(output));
    expect(payload).toEqual({
      systemMessage: 'ClaudeRouter: classifier timeout; fell back to STANDARD, delegate model deepseek-v4.1-flash.',
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: '[ROUTER] Complexity: STANDARD.',
      },
    });
  });

  it('keeps the delegate alias when its environment mapping is unset', async () => {
    mockRoute.mockResolvedValueOnce(decision({
      tier: 'STANDARD',
      source: 'fallback',
      execution: { mode: 'delegate', model: 'sonnet' },
      classifierFailure: 'http_503',
      classifierRequestModel: 'MiniMax-M3',
    }));

    const output = await handleHookInput({ prompt: 'implement something' });

    expect(output.systemMessage).toBe(
      'ClaudeRouter: classifier HTTP 503; fell back to STANDARD, delegate model sonnet.',
    );
  });

  it('shows an explicitly configured delegate model without classifier model metadata', async () => {
    vi.stubEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', 'unrelated-model');
    mockRoute.mockResolvedValueOnce(decision({
      tier: 'STANDARD',
      source: 'fallback',
      execution: { mode: 'delegate', model: 'deepseek-v4.1-flash[1M]' },
      classifierFailure: 'invalid_output',
    }));

    const output = await handleHookInput({ prompt: 'implement something' });

    expect(output.systemMessage).toBe(
      'ClaudeRouter: classifier invalid output; fell back to STANDARD, delegate model deepseek-v4.1-flash.',
    );
  });

  it('uses the effective execution after conservative tier shifting', async () => {
    mockLoadConfig.mockReturnValue({ ...config, conservative: true });
    vi.stubEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', 'deepseek-v4.1-flash');
    vi.stubEnv('ANTHROPIC_DEFAULT_OPUS_MODEL', 'gateway-opus[1M]');
    mockRoute.mockResolvedValueOnce(decision({
      tier: 'COMPLEX',
      source: 'fallback',
      execution: { mode: 'delegate', model: 'opus' },
      classifierFailure: 'timeout',
      classifierRequestModel: 'MiniMax-M3',
    }));

    const output = await handleHookInput({ prompt: 'implement something' });

    expect(output.systemMessage).toBe(
      'ClaudeRouter: classifier timeout; fell back to COMPLEX, delegate model gateway-opus.',
    );
  });

  it('describes direct execution without claiming the classifier is the fallback model', async () => {
    mockRoute.mockResolvedValueOnce(decision({
      tier: 'STANDARD',
      source: 'fallback',
      execution: { mode: 'direct' },
      directive: null,
      classifierFailure: 'timeout',
      classifierRequestModel: 'MiniMax-M3',
    }));

    const output = await handleHookInput({ prompt: 'implement something' });

    expect(output).toEqual({
      additionalContext: '',
      systemMessage: 'ClaudeRouter: classifier timeout; fell back to STANDARD, direct execution (current model).',
    });
  });

  it('throttles repeated notices with the same failure type', async () => {
    mockRoute.mockResolvedValue(decision({
      source: 'fallback',
      classifierFailure: 'timeout',
    }));

    const first = await handleHookInput({ prompt: 'implement something' });
    const second = await handleHookInput({ prompt: 'implement something else' });

    expect(first.systemMessage).toBeDefined();
    expect(second.systemMessage).toBeUndefined();
    const state = JSON.parse(readFileSync(path.join(homeDir, '.claude-router', 'ui-notice.json'), 'utf-8'));
    expect(state.timeout).toBeTypeOf('number');
  });

  it('shows the Provider error reason and passes it to telemetry', async () => {
    mockRoute.mockResolvedValueOnce(decision({
      source: 'fallback',
      classifierFailure: 'http_503',
      classifierError: '当前集群负载较高',
      classifierRequestModel: 'MiniMax-M3',
    }));

    const output = await handleHookInput({ prompt: 'implement something' });

    expect(output.systemMessage).toBe(
      'ClaudeRouter: classifier HTTP 503 (当前集群负载较高); fell back to SIMPLE, delegate model haiku.',
    );
    expect(mockLogDecision).toHaveBeenCalledWith(expect.objectContaining({
      classifier_failure: 'http_503',
      classifier_error: '当前集群负载较高',
    }));
  });

  it('re-sanitizes the reason before showing it', async () => {
    mockRoute.mockResolvedValueOnce(decision({
      source: 'fallback',
      classifierFailure: 'http_401',
      classifierError: 'invalid key sk-live-secret (Bearer abc123)',
    }));

    const output = await handleHookInput({ prompt: 'implement something' });

    expect(output.systemMessage).not.toContain('sk-live-secret');
    expect(output.systemMessage).not.toContain('abc123');
    expect(output.systemMessage).toContain('[redacted]');
    expect(mockLogDecision).toHaveBeenCalledWith(expect.objectContaining({
      classifier_error: 'invalid key [redacted] (Bearer [redacted])',
    }));
  });

  it('writes the reason to the debug log', async () => {
    mockLoadConfig.mockReturnValue({ ...config, debug: { ...config.debug, enabled: true } });
    mockRoute.mockResolvedValueOnce(decision({
      source: 'fallback',
      classifierFailure: 'http_503',
      classifierError: '当前集群负载较高',
    }));

    await handleHookInput({ prompt: 'implement something' });

    const debugPath = path.join(homeDir, '.claude-router', 'debug.jsonl');
    const event = JSON.parse(readFileSync(debugPath, 'utf-8').trim());
    expect(event).toMatchObject({
      classifier_failure: 'http_503',
      classifier_error: '当前集群负载较高',
    });
  });

  it('shows an HTTP status and never shows a notice for overrides', async () => {
    mockRoute.mockResolvedValueOnce(decision({
      source: 'fallback',
      classifierFailure: 'http_400',
    }));
    const fallbackOutput = await handleHookInput({ prompt: 'implement something' });
    expect(fallbackOutput.systemMessage).toContain('HTTP 400');

    mockRoute.mockResolvedValueOnce(decision({ source: 'override', tier: 'COMPLEX' }));
    const overrideOutput = await handleHookInput({ prompt: '//complex do it' });
    expect(overrideOutput.systemMessage).toBeUndefined();
  });
});

describe('serializeHookOutput', () => {
  it('keeps the plain-text directive when there is no notice', () => {
    expect(serializeHookOutput({ additionalContext: 'plain directive' })).toBe('plain directive');
  });

  it('returns an empty string when there is nothing to say', () => {
    expect(serializeHookOutput({ additionalContext: '' })).toBe('');
  });
});
