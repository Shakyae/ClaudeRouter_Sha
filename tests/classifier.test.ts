import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig } from '../src/router/config';
import {
  classify,
  getClassifierErrorDetail,
  parseTier,
} from '../src/classifier/classifier';
import { sanitizeErrorDetail } from '../src/redact';

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

let initialClassifierModel: string | undefined;
let initialHaikuModel: string | undefined;
let initialSonnetModel: string | undefined;
let initialMaxTokens: string | undefined;

const MODEL_ENV_VARS = [
  'CLAUDE_ROUTER_CLASSIFIER_MODEL',
  'CLAUDE_ROUTER_CLASSIFIER_MAX_TOKENS',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
] as const;

let initialEnv: Record<string, string | undefined> = {};

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

beforeEach(() => {
  initialEnv = Object.fromEntries(MODEL_ENV_VARS.map((name) => [name, process.env[name]]));
  initialClassifierModel = initialEnv.CLAUDE_ROUTER_CLASSIFIER_MODEL;
  initialHaikuModel = initialEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  initialSonnetModel = initialEnv.ANTHROPIC_DEFAULT_SONNET_MODEL;
  initialMaxTokens = initialEnv.CLAUDE_ROUTER_CLASSIFIER_MAX_TOKENS;
  for (const name of MODEL_ENV_VARS) {
    delete process.env[name];
  }
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: 'STANDARD' }],
    usage: { input_tokens: 50 },
  });
});

afterEach(() => {
  for (const name of MODEL_ENV_VARS) {
    const previous = initialEnv[name];
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
});

describe('classify', () => {
  it.each(['SIMPLE', 'STANDARD', 'COMPLEX', 'EXTREME'] as const)(
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

    expect(result).toMatchObject({
      tier: 'COMPLEX',
      source: 'fallback',
      promptTokens: 7,
      classifierFailure: 'invalid_output',
    });
  });

  it('uses the configured fallback tier after an API error', async () => {
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('API error'), { status: 400 }));
    const config = mergeConfig(DEFAULT_CONFIG, { fallback_tier: 'SIMPLE' });

    const result = await classify('implement a normal feature', config);

    expect(result).toMatchObject({
      tier: 'SIMPLE',
      source: 'fallback',
      promptTokens: 0,
      classifierFailure: 'http_400',
    });
  });

  it('uses the configured classifier model and timeout', async () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      classifier: { model: 'cheap-classifier', timeout_ms: 1234 },
    });

    await classify('implement a normal feature', config);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'cheap-classifier', max_tokens: 256 }),
      { timeout: 1234, maxRetries: 0 },
    );
  });

  it('uses the Claude Code Haiku mapping for the haiku classifier alias', async () => {
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = '  gateway-haiku  ';

    const result = await classify('implement a normal feature', DEFAULT_CONFIG);

    expect(result.classifierModel).toBe('gateway-haiku');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gateway-haiku' }), expect.anything());
  });

  it('matches the Haiku classifier alias case-insensitively', async () => {
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'gateway-haiku';
    const config = mergeConfig(DEFAULT_CONFIG, { classifier: { model: '  HaIkU  ' } });

    const result = await classify('implement a normal feature', config);

    expect(result.classifierModel).toBe('gateway-haiku');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gateway-haiku' }), expect.anything());
  });

  it.each(['cheap-classifier', 'claude-haiku-4-5'])(
    'keeps the configured non-haiku classifier model %s',
    async (model) => {
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'gateway-haiku';
      const config = mergeConfig(DEFAULT_CONFIG, { classifier: { model } });

      const result = await classify('implement a normal feature', config);

      expect(result.classifierModel).toBe(model);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model }), expect.anything());
    },
  );

  it('ignores blank classifier model environment values', async () => {
    process.env.CLAUDE_ROUTER_CLASSIFIER_MODEL = '  ';
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = '\t ';

    const result = await classify('implement a normal feature', DEFAULT_CONFIG);

    expect(result.classifierModel).toBe('haiku');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'haiku' }), expect.anything());
  });

  it('prioritizes CLAUDE_ROUTER_CLASSIFIER_MODEL over the Claude Code Haiku mapping', async () => {
    process.env.CLAUDE_ROUTER_CLASSIFIER_MODEL = 'environment-classifier';
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'gateway-haiku';

    const result = await classify('implement a normal feature', DEFAULT_CONFIG);

    expect(result.classifierModel).toBe('environment-classifier');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'environment-classifier' }), expect.anything());
  });

  it('strips the 1M marker before sending the model and keeps the raw value for logs', async () => {
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'MiniMax-M3[1M]';

    const result = await classify('implement a normal feature', DEFAULT_CONFIG);

    expect(result.classifierModel).toBe('MiniMax-M3[1M]');
    expect(result.classifierRequestModel).toBe('MiniMax-M3');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'MiniMax-M3' }), expect.anything());
  });

  it('resolves the sonnet alias from the alias table', async () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'gateway-sonnet[1M]';
    const config = mergeConfig(DEFAULT_CONFIG, { classifier: { model: 'Sonnet' } });

    const result = await classify('implement a normal feature', config);

    expect(result.classifierRequestModel).toBe('gateway-sonnet');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gateway-sonnet' }), expect.anything());
  });

  it('does not call the API for high-confidence signals', async () => {
    const result = await classify('fix typo', DEFAULT_CONFIG);

    expect(result).toMatchObject({ tier: 'SIMPLE', source: 'signal' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('keeps context-dependent confirmations at STANDARD', async () => {
    const result = await classify('continue', DEFAULT_CONFIG);

    expect(result).toMatchObject({ tier: 'STANDARD', source: 'signal' });
  });
});

describe('thinking-only responses', () => {
  const thinkingOnly = {
    content: [{ type: 'thinking', thinking: 'Let me weigh the options...' }],
    stop_reason: 'max_tokens',
    usage: { input_tokens: 50 },
  };

  it('retries with a larger budget and succeeds', async () => {
    mockCreate.mockReset();
    mockCreate
      .mockResolvedValueOnce(thinkingOnly)
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'COMPLEX' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 50 },
      });

    const result = await classify('implement a normal feature', DEFAULT_CONFIG);

    expect(result).toMatchObject({
      tier: 'COMPLEX',
      source: 'classifier',
      classifierAttempts: 2,
    });
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ max_tokens: 256 });
    expect(mockCreate.mock.calls[1][0]).toMatchObject({ max_tokens: 1024 });
  });

  it('reports invalid_output when the retry is also thinking-only', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(thinkingOnly);

    const result = await classify('implement a normal feature', DEFAULT_CONFIG);

    expect(result).toMatchObject({
      tier: 'STANDARD',
      source: 'fallback',
      classifierFailure: 'invalid_output',
      classifierAttempts: 2,
    });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('does not retry past the budget cap', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(thinkingOnly);
    const config = mergeConfig(DEFAULT_CONFIG, { classifier: { max_tokens: 2048 } });

    await classify('implement a normal feature', config);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ max_tokens: 2048 });
  });

  it('ignores thinking blocks when a text block is also present', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'thinking', thinking: 'This looks complex' },
        { type: 'text', text: ' COMPLEX ' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50 },
    });

    const result = await classify('implement a normal feature', DEFAULT_CONFIG);

    expect(result).toMatchObject({ tier: 'COMPLEX', source: 'classifier', classifierAttempts: 1 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('honors CLAUDE_ROUTER_CLASSIFIER_MAX_TOKENS over the configured budget', async () => {
    process.env.CLAUDE_ROUTER_CLASSIFIER_MAX_TOKENS = '512';

    await classify('implement a normal feature', DEFAULT_CONFIG);

    expect(mockCreate.mock.calls[0][0]).toMatchObject({ max_tokens: 512 });
  });
});

describe('failure classification', () => {
  it('records a timeout as timeout instead of request_error', async () => {
    const timeoutError = new Error('Request timed out.');
    Object.defineProperty(timeoutError, 'constructor', {
      value: { name: 'APIConnectionTimeoutError' },
    });
    mockCreate.mockReset();
    mockCreate.mockRejectedValue(timeoutError);

    const result = await classify('implement a normal feature', DEFAULT_CONFIG);

    expect(result).toMatchObject({ source: 'fallback', classifierFailure: 'timeout' });
  });

  it('records a plain connection error as request_error', async () => {
    mockCreate.mockReset();
    mockCreate.mockRejectedValue(new Error('Connection error.'));

    const result = await classify('implement a normal feature', DEFAULT_CONFIG);

    expect(result).toMatchObject({ source: 'fallback', classifierFailure: 'request_error' });
    expect(result.classifierAttempts).toBe(2);
  });

  it('records an HTTP status as http_<status>', async () => {
    mockCreate.mockReset();
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }));

    const result = await classify('implement a normal feature', DEFAULT_CONFIG);

    expect(result).toMatchObject({ source: 'fallback', classifierFailure: 'http_400' });
  });

  it('never lets the SDK retry on its own', async () => {
    const config = mergeConfig(DEFAULT_CONFIG, { classifier: { max_retries: 5, timeout_ms: 500 } });

    await classify('implement a normal feature', config);

    expect(mockCreate).toHaveBeenCalledWith(expect.anything(), { timeout: 500, maxRetries: 0 });
  });
});

describe('classifier time budget', () => {
  const timeoutError = () => {
    const error = new Error('Request timed out.');
    Object.defineProperty(error, 'constructor', {
      value: { name: 'APIConnectionTimeoutError' },
    });
    return error;
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a transient failure once within the plugin budget', async () => {
    mockCreate.mockReset();
    mockCreate.mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 }));
    const config = mergeConfig(DEFAULT_CONFIG, { classifier: { max_retries: 1 } });

    const resultPromise = classify('implement a normal feature', config);
    await vi.advanceTimersByTimeAsync(300);
    const result = await resultPromise;

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ source: 'fallback', classifierFailure: 'http_529', classifierAttempts: 2 });
  });

  it('recovers when a transient failure is followed by a success', async () => {
    mockCreate.mockReset();
    mockCreate
      .mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 529 }))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'COMPLEX' }], usage: { input_tokens: 9 } });

    const resultPromise = classify('implement a normal feature', DEFAULT_CONFIG);
    await vi.advanceTimersByTimeAsync(300);
    const result = await resultPromise;

    expect(result).toMatchObject({ tier: 'COMPLEX', source: 'classifier', classifierAttempts: 2 });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-transient 4xx failure', async () => {
    mockCreate.mockReset();
    mockCreate.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));

    const resultPromise = classify('implement a normal feature', DEFAULT_CONFIG);
    await vi.advanceTimersByTimeAsync(300);
    const result = await resultPromise;

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ classifierFailure: 'http_400' });
  });

  it('ignores a large Retry-After header and keeps the backoff fixed', async () => {
    mockCreate.mockReset();
    mockCreate.mockRejectedValue(
      Object.assign(new Error('rate limited'), {
        status: 429,
        headers: { 'retry-after': '60', 'retry-after-ms': '60000' },
      }),
    );
    const config = mergeConfig(DEFAULT_CONFIG, { classifier: { max_retries: 3 } });

    const resultPromise = classify('implement a normal feature', config);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(result).toMatchObject({ classifierFailure: 'http_429', classifierAttempts: 4 });
    // Three 250ms backoffs, not three 60s Retry-After waits.
    expect(result.latencyMs).toBe(750);
  });

  it('stops issuing attempts once the total budget is spent', async () => {
    mockCreate.mockReset();
    mockCreate.mockImplementation(
      (_body: unknown, options: { timeout: number }) =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(timeoutError()), options.timeout);
        }),
    );
    const config = mergeConfig(DEFAULT_CONFIG, {
      classifier: { timeout_ms: 1000, budget_ms: 2500, max_retries: 10 },
    });

    const resultPromise = classify('implement a normal feature', config);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result).toMatchObject({ source: 'fallback', classifierFailure: 'timeout' });
    expect(result.classifierAttempts).toBe(2);
    expect(result.latencyMs).toBeLessThanOrEqual(2500);
  });

  it('caps each attempt timeout by the remaining budget', async () => {
    const config = mergeConfig(DEFAULT_CONFIG, { classifier: { timeout_ms: 10000, budget_ms: 1500 } });

    await classify('implement a normal feature', config);

    expect(mockCreate.mock.calls[0][1]).toEqual({ timeout: 1500, maxRetries: 0 });
  });

  it('skips the thinking-block retry when the remaining budget is too small', async () => {
    mockCreate.mockReset();
    mockCreate.mockImplementation(
      (body: { max_tokens: number }) =>
        new Promise((resolve) => {
          const delay = body.max_tokens === 256 ? 250 : 0;
          setTimeout(
            () =>
              resolve({
                content: [{ type: 'thinking', thinking: 'Let me weigh the options...' }],
                stop_reason: 'max_tokens',
                usage: { input_tokens: 50 },
              }),
            delay,
          );
        }),
    );
    const config = mergeConfig(DEFAULT_CONFIG, { classifier: { budget_ms: 300 } });

    const resultPromise = classify('implement a normal feature', config);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ classifierFailure: 'invalid_output', classifierAttempts: 1 });
  });
});

describe('classifier error details', () => {
  it('prefers the nested Provider error message from the response body', () => {
    const error = Object.assign(new Error('400 {"type":"error"}'), {
      status: 400,
      error: { type: 'error', error: { type: 'invalid_request_error', message: '当前集群负载较高' } },
    });

    expect(getClassifierErrorDetail(error)).toBe('当前集群负载较高');
  });

  it('falls back to a flat response-body message before the SDK message', () => {
    const error = Object.assign(new Error('Request failed'), {
      status: 503,
      error: { message: '当前集群负载较高' },
    });

    expect(getClassifierErrorDetail(error)).toBe('当前集群负载较高');
  });

  it('uses error.message when the response body has no message', () => {
    expect(getClassifierErrorDetail(new Error('Connection error.'))).toBe('Connection error.');
  });

  it('returns undefined when there is no readable message', () => {
    expect(getClassifierErrorDetail(undefined)).toBeUndefined();
    expect(getClassifierErrorDetail({ status: 500 })).toBeUndefined();
  });

  it('truncates long messages to 300 characters', () => {
    const detail = getClassifierErrorDetail(new Error('x'.repeat(1000)));

    expect(detail).toHaveLength(300);
    expect(detail).toBe('x'.repeat(300));
  });

  it('redacts API keys and bearer tokens', () => {
    const detail = getClassifierErrorDetail(
      new Error('auth failed for sk-ant-api03-secret and Authorization: Bearer abc.def-123'),
    );

    expect(detail).not.toContain('sk-ant');
    expect(detail).not.toContain('abc.def-123');
    expect(detail).toContain('[redacted]');
  });

  it('collapses whitespace in multi-line Provider messages', () => {
    expect(sanitizeErrorDetail('cluster   overloaded\n\ntry later')).toBe('cluster overloaded try later');
  });

  it('attaches the sanitized reason to a fallback classification', async () => {
    mockCreate.mockReset();
    mockCreate.mockRejectedValue(
      Object.assign(new Error('API error'), {
        status: 503,
        error: { error: { message: '当前集群负载较高 (key sk-test-secret)' } },
      }),
    );
    const config = mergeConfig(DEFAULT_CONFIG, { classifier: { max_retries: 0 } });

    const result = await classify('implement a normal feature', config);

    expect(result).toMatchObject({
      source: 'fallback',
      classifierFailure: 'http_503',
      classifierError: '当前集群负载较高 (key [redacted])',
    });
  });

  it('omits the error detail when the output is not a tier', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'unknown' }], usage: { input_tokens: 7 } });

    const result = await classify('implement a normal feature', DEFAULT_CONFIG);

    expect(result.classifierFailure).toBe('invalid_output');
    expect(result).not.toHaveProperty('classifierError');
  });
});

describe('parseTier', () => {
  it('prefers exact output and uses longest-first fallback parsing', () => {
    expect(parseTier(' simple ')).toBe('SIMPLE');
    expect(parseTier('The selected tier is EXTREME.')).toBe('EXTREME');
    expect(parseTier('unknown')).toBeNull();
  });

  it('does not read EXTREMELY as the EXTREME tier', () => {
    expect(parseTier('EXTREMELY simple')).toBe('SIMPLE');
  });
});
