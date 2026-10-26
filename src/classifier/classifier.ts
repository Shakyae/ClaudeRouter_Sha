import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, type RouterConfig } from '../router/config';
import { TIERS, type ClassifierFailure, type Tier } from '../types';
import { getClassifierErrorDetail } from '../redact';
import { resolveModelAlias, sanitizeModelName } from './model-name';
import { quickClassify } from './signals';

export interface ClassificationResult {
  tier: Tier;
  source: 'signal' | 'classifier' | 'fallback';
  latencyMs: number;
  promptTokens: number;
  classifierModel?: string;
  classifierRequestModel?: string;
  classifierFailure?: ClassifierFailure;
  classifierError?: string;
  classifierAttempts?: number;
  classifierAttemptMs?: number[];
}

export interface ClassifierModelResolution {
  /** Name actually sent to the Provider, with any 1M marker removed. */
  requestModel: string;
  /** Untouched configured value, kept for diagnostics. */
  configuredModel: string;
  source: 'env_override' | 'alias_env' | 'config';
}

const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_BUDGET_MS = 20000;
const MAX_TOKENS_RETRY_CAP = 2048;
const MAX_TOKENS_RETRY_FACTOR = 4;
const RETRY_BACKOFF_MS = 250;
// Below this, another request cannot finish before Claude Code's hook limit.
const MIN_ATTEMPT_MS = 200;

let cachedClient: Anthropic | undefined;

function getClient(): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

let cachedTemplate: string | undefined;

function loadPromptTemplate(): string {
  if (cachedTemplate !== undefined) {
    return cachedTemplate;
  }

  const candidates = [
    path.join(__dirname, '..', 'classifier', 'prompt.md'),
    path.join(__dirname, 'prompt.md'),
  ];
  for (const candidate of candidates) {
    try {
      cachedTemplate = fs.readFileSync(candidate, 'utf-8');
      return cachedTemplate;
    } catch {
      // Try the next candidate.
    }
  }

  cachedTemplate = `You are a task complexity classifier for an AI coding assistant.
Output exactly one word and nothing else:
SIMPLE
STANDARD
COMPLEX
EXTREME

Prompt to classify:
{{PROMPT}}
Complexity:`;
  return cachedTemplate;
}

export function parseTier(raw: string): Tier | null {
  const cleaned = raw.trim().toUpperCase();
  if ((TIERS as readonly string[]).includes(cleaned)) {
    return cleaned as Tier;
  }

  // Longest-first plus word boundaries keeps "EXTREMELY" from reading as EXTREME.
  for (const tier of [...TIERS].reverse()) {
    if (new RegExp(`\\b${tier}\\b`).test(cleaned)) {
      return tier;
    }
  }
  return null;
}

function countTokens(prompt: string): number {
  return prompt.trim().split(/\s+/).filter(Boolean).length;
}

function readNonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function resolveClassifierModel(config: RouterConfig): ClassifierModelResolution {
  const envOverride = readNonEmptyEnv('CLAUDE_ROUTER_CLASSIFIER_MODEL');
  if (envOverride) {
    return { requestModel: sanitizeModelName(envOverride), configuredModel: envOverride, source: 'env_override' };
  }

  const configuredModel = config.classifier.model.trim();
  const aliasValue = resolveModelAlias(configuredModel);
  if (aliasValue) {
    return { requestModel: sanitizeModelName(aliasValue), configuredModel: aliasValue, source: 'alias_env' };
  }

  return { requestModel: sanitizeModelName(configuredModel), configuredModel, source: 'config' };
}

function getClassifierMaxTokens(config: RouterConfig): number {
  const envValue = readNonEmptyEnv('CLAUDE_ROUTER_CLASSIFIER_MAX_TOKENS');
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const configured = config.classifier.max_tokens;
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_TOKENS;
}

export { getClassifierErrorDetail } from '../redact';

export function getClassifierFailure(error: unknown): ClassifierFailure {
  const TimeoutError = (Anthropic as unknown as { APIConnectionTimeoutError?: new (...args: never[]) => Error })
    .APIConnectionTimeoutError;
  if (typeof TimeoutError === 'function' && error instanceof TimeoutError) {
    return 'timeout';
  }

  const candidate = error as { constructor?: { name?: string }; name?: string; message?: string } | null;
  const constructorName = candidate?.constructor?.name;
  if (constructorName === 'APIConnectionTimeoutError' || candidate?.name === 'APIConnectionTimeoutError') {
    return 'timeout';
  }

  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
    return `http_${error.status}`;
  }

  // The SDK reports timeouts as plain `Error` instances whose message is
  // "Request timed out.", so the error name alone cannot identify them.
  if (typeof candidate?.message === 'string' && /timed out|timeout/i.test(candidate.message)) {
    return 'timeout';
  }

  return 'request_error';
}

function textOf(response: Anthropic.Message): string {
  // Thinking blocks are never an answer; join every text block instead.
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function needsLargerBudget(response: Anthropic.Message, text: string): boolean {
  return response.stop_reason === 'max_tokens' && text.length === 0;
}

function isRetryableFailure(failure: ClassifierFailure): boolean {
  return failure === 'timeout' || failure === 'request_error' || /^http_(429|5\d\d)$/.test(failure);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ClassifierDeadlineError extends Error {
  constructor() {
    super('Classifier budget exhausted.');
    this.name = 'ClassifierDeadlineError';
  }
}

interface AttemptResult {
  response: Anthropic.Message;
  text: string;
}

export async function classify(prompt: string, config = loadConfig()): Promise<ClassificationResult> {
  const start = Date.now();
  const signalResult = quickClassify(prompt);
  if (signalResult !== null) {
    return {
      tier: signalResult,
      source: 'signal',
      latencyMs: Date.now() - start,
      promptTokens: countTokens(prompt),
    };
  }

  const resolution = resolveClassifierModel(config);
  const attemptMs: number[] = [];
  let promptTokens = 0;

  // The SDK retries on its own (obeying server `Retry-After`, up to 60s), which
  // can outlive Claude Code's 30s hook limit. Retries are therefore disabled in
  // the SDK and re-implemented here under one shared deadline.
  const configuredBudget = config.classifier.budget_ms;
  const budgetMs =
    Number.isInteger(configuredBudget) && configuredBudget > 0 ? configuredBudget : DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const remainingMs = (): number => deadline - Date.now();
  let transientRetries = 0;

  const requestOnce = async (maxTokens: number): Promise<AttemptResult> => {
    const remaining = remainingMs();
    if (remaining < MIN_ATTEMPT_MS) {
      throw new ClassifierDeadlineError();
    }

    // `timeout_ms: 0` would disable the per-attempt limit in the SDK; the
    // deadline alone still bounds the attempt in that case.
    const attemptTimeout =
      config.classifier.timeout_ms > 0 ? Math.min(config.classifier.timeout_ms, remaining) : remaining;

    const attemptStart = Date.now();
    try {
      const response = await getClient().messages.create(
        {
          model: resolution.requestModel,
          max_tokens: maxTokens,
          messages: [
            {
              role: 'user',
              content: loadPromptTemplate().replace('{{PROMPT}}', () => prompt),
            },
          ],
        },
        {
          timeout: attemptTimeout,
          maxRetries: 0,
        },
      );
      promptTokens = response.usage?.input_tokens ?? promptTokens;
      return { response, text: textOf(response) };
    } finally {
      attemptMs.push(Date.now() - attemptStart);
    }
  };

  const request = async (maxTokens: number): Promise<AttemptResult> => {
    for (;;) {
      try {
        return await requestOnce(maxTokens);
      } catch (error) {
        const failure = getClassifierFailure(error);
        if (!isRetryableFailure(failure) || transientRetries >= config.classifier.max_retries) {
          throw error;
        }
        // A fixed backoff keeps total latency predictable; honoring the
        // server's `Retry-After` could stall well past the deadline.
        if (remainingMs() - RETRY_BACKOFF_MS < MIN_ATTEMPT_MS) {
          throw error;
        }
        transientRetries += 1;
        await sleep(RETRY_BACKOFF_MS);
      }
    }
  };

  try {
    let budget = getClassifierMaxTokens(config);
    let attempt = await request(budget);

    // Some providers spend the whole budget on a thinking block and return no
    // text. Give them a larger budget once before declaring the output invalid.
    if (needsLargerBudget(attempt.response, attempt.text) && budget < MAX_TOKENS_RETRY_CAP) {
      const largerBudget = Math.min(budget * MAX_TOKENS_RETRY_FACTOR, MAX_TOKENS_RETRY_CAP);
      if (remainingMs() >= MIN_ATTEMPT_MS) {
        budget = largerBudget;
        attempt = await request(budget);
      }
    }

    const latencyMs = Date.now() - start;
    const tier = parseTier(attempt.text);

    if (tier) {
      return {
        tier,
        source: 'classifier',
        latencyMs,
        promptTokens,
        classifierModel: resolution.configuredModel,
        classifierRequestModel: resolution.requestModel,
        classifierAttempts: attemptMs.length,
        classifierAttemptMs: attemptMs,
      };
    }

    return {
      tier: config.fallback_tier,
      source: 'fallback',
      latencyMs,
      promptTokens,
      classifierModel: resolution.configuredModel,
      classifierRequestModel: resolution.requestModel,
      classifierAttempts: attemptMs.length,
      classifierAttemptMs: attemptMs,
      classifierFailure: 'invalid_output',
    };
  } catch (error) {
    const isDeadline = error instanceof ClassifierDeadlineError;
    const errorDetail = isDeadline ? undefined : getClassifierErrorDetail(error);
    return {
      tier: config.fallback_tier,
      source: 'fallback',
      latencyMs: Date.now() - start,
      promptTokens: 0,
      classifierModel: resolution.configuredModel,
      classifierRequestModel: resolution.requestModel,
      classifierAttempts: attemptMs.length,
      classifierAttemptMs: attemptMs,
      classifierFailure: isDeadline ? 'timeout' : getClassifierFailure(error),
      ...(errorDetail ? { classifierError: errorDetail } : {}),
    };
  }
}
