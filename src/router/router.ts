import { classify } from '../classifier/classifier';
import { getClassifierErrorDetail } from '../redact';
import type { ExecutionConfig, RoutingDecision, Tier } from '../types';
import type { RouterConfig } from './config';
import { resolveExecution, resolveFallbacks, shiftUp } from './model-map';

export type { RoutingDecision } from '../types';

export function buildDirective(tier: Tier, execution: ExecutionConfig, fallbacks: string[] = []): string | null {
  if (execution.mode === 'direct') {
    return null;
  }

  const sentences = [
    `[ROUTER] Complexity: ${tier}.`,
    `Delegate the entire task to a subagent using model "${execution.model}".`,
    'Let the subagent inspect and modify the repository as needed.',
    'After it finishes, do not redo the implementation independently.',
  ];

  if (fallbacks.length > 0) {
    const chain = fallbacks.map((model) => `"${model}"`).join(', then ');
    sentences.push(
      `If the delegation itself fails because that model is unavailable, retry the same task once each with ${chain}, in that order; retrying a failed delegation is not a redo. If every model fails, stop and report the errors. If a fallback model completed the task, tell the user which model actually ran it.`,
    );
  }

  return sentences.join(' ');
}

function findOverride(prompt: string, config: RouterConfig): { tier: Tier; strippedPrompt: string } | null {
  const trimmed = prompt.trimStart();
  const prefixes = Object.keys(config.overrides).sort((left, right) => right.length - left.length);

  for (const prefix of prefixes) {
    const afterPrefix = trimmed.slice(prefix.length);
    if (
      trimmed.toLowerCase().startsWith(prefix.toLowerCase()) &&
      (afterPrefix === '' || /^\s/.test(afterPrefix))
    ) {
      return {
        tier: config.overrides[prefix],
        strippedPrompt: afterPrefix.trimStart(),
      };
    }
  }

  return null;
}

function effectiveTier(tier: Tier, config: RouterConfig): Tier {
  return config.conservative ? shiftUp(tier) : tier;
}

export async function route(prompt: string, config: RouterConfig): Promise<RoutingDecision> {
  const start = Date.now();
  const override = findOverride(prompt, config);

  if (override) {
    const tier = effectiveTier(override.tier, config);
    const execution = resolveExecution(override.tier, config);
    const fallbacks = resolveFallbacks(tier, config);
    return {
      tier,
      source: 'override',
      execution,
      fallbacks,
      directive: buildDirective(tier, execution, fallbacks),
      latencyMs: Date.now() - start,
      strippedPrompt: override.strippedPrompt,
    };
  }

  try {
    const classification = await classify(prompt, config);
    const tier = effectiveTier(classification.tier, config);
    const execution = resolveExecution(classification.tier, config);
    const fallbacks = resolveFallbacks(tier, config);

    return {
      tier,
      source: classification.source,
      execution,
      fallbacks,
      directive: buildDirective(tier, execution, fallbacks),
      classifierModel: classification.classifierModel,
      classifierRequestModel: classification.classifierRequestModel,
      classifierFailure: classification.classifierFailure,
      classifierError: classification.classifierError,
      classifierAttempts: classification.classifierAttempts,
      classifierAttemptMs: classification.classifierAttemptMs,
      latencyMs: Date.now() - start,
      strippedPrompt: prompt,
    };
  } catch (error) {
    const tier = effectiveTier(config.fallback_tier, config);
    const execution = resolveExecution(config.fallback_tier, config);
    const fallbacks = resolveFallbacks(tier, config);
    const classifierError = getClassifierErrorDetail(error);
    return {
      tier,
      source: 'fallback',
      execution,
      fallbacks,
      directive: buildDirective(tier, execution, fallbacks),
      classifierFailure: 'request_error',
      ...(classifierError ? { classifierError } : {}),
      latencyMs: Date.now() - start,
      strippedPrompt: prompt,
    };
  }
}
