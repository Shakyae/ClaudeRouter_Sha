import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, type RouterConfig } from '../router/config';
import { TIERS, type ClassifierFailure, type Tier } from '../types';
import { quickClassify } from './signals';

export interface ClassificationResult {
  tier: Tier;
  source: 'signal' | 'classifier' | 'fallback';
  latencyMs: number;
  promptTokens: number;
  classifierModel?: string;
  classifierFailure?: ClassifierFailure;
}

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
TRIVIAL
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

  for (const tier of [...TIERS].reverse()) {
    if (cleaned.includes(tier)) {
      return tier;
    }
  }
  return null;
}

function countTokens(prompt: string): number {
  return prompt.trim().split(/\s+/).filter(Boolean).length;
}

function getClassifierModel(config: RouterConfig): string {
  const configuredOverride = process.env.CLAUDE_ROUTER_CLASSIFIER_MODEL?.trim();
  if (configuredOverride) {
    return configuredOverride;
  }

  const configuredModel = config.classifier.model.trim();
  if (configuredModel.toLowerCase() !== 'haiku') {
    return configuredModel;
  }

  return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() || configuredModel;
}

function getClassifierFailure(error: unknown): ClassifierFailure {
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
    return `http_${error.status}`;
  }
  if (error instanceof Error && /timeout/i.test(error.name)) {
    return 'timeout';
  }
  return 'request_error';
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

  const classifierModel = getClassifierModel(config);
  try {
    const response = await getClient().messages.create(
      {
        model: classifierModel,
        max_tokens: 16,
        messages: [
          {
            role: 'user',
            content: loadPromptTemplate().replace('{{PROMPT}}', () => prompt),
          },
        ],
      },
      { timeout: config.classifier.timeout_ms },
    );

    const latencyMs = Date.now() - start;
    const textBlock = response.content.find((block: Anthropic.ContentBlock) => block.type === 'text');
    const tier = parseTier(textBlock?.text ?? '');
    const promptTokens = response.usage?.input_tokens ?? 0;

    if (tier) {
      return { tier, source: 'classifier', latencyMs, promptTokens, classifierModel };
    }

    return {
      tier: config.fallback_tier,
      source: 'fallback',
      latencyMs,
      promptTokens,
      classifierModel,
      classifierFailure: 'invalid_output',
    };
  } catch (error) {
    return {
      tier: config.fallback_tier,
      source: 'fallback',
      latencyMs: Date.now() - start,
      promptTokens: 0,
      classifierModel,
      classifierFailure: getClassifierFailure(error),
    };
  }
}
