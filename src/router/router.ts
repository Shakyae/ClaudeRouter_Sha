import { classify } from '../classifier/classifier';
import type { ExecutionConfig, RoutingDecision, Tier } from '../types';
import type { RouterConfig } from './config';
import { resolveExecution, shiftUp } from './model-map';

export type { RoutingDecision } from '../types';

export function buildDirective(tier: Tier, execution: ExecutionConfig): string | null {
  if (execution.mode === 'direct') {
    return null;
  }

  return [
    `[ROUTER] Complexity: ${tier}.`,
    `Delegate the entire task to a subagent using model "${execution.model}".`,
    'Let the subagent inspect and modify the repository as needed.',
    'After it finishes, do not redo the implementation independently.',
  ].join(' ');
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
    return {
      tier,
      source: 'override',
      execution,
      directive: buildDirective(tier, execution),
      latencyMs: Date.now() - start,
      strippedPrompt: override.strippedPrompt,
    };
  }

  try {
    const classification = await classify(prompt, config);
    const tier = effectiveTier(classification.tier, config);
    const execution = resolveExecution(classification.tier, config);

    return {
      tier,
      source: classification.source,
      execution,
      directive: buildDirective(tier, execution),
      classifierModel: classification.classifierModel,
      latencyMs: Date.now() - start,
      strippedPrompt: prompt,
    };
  } catch {
    const tier = effectiveTier(config.fallback_tier, config);
    const execution = resolveExecution(config.fallback_tier, config);
    return {
      tier,
      source: 'fallback',
      execution,
      directive: buildDirective(tier, execution),
      latencyMs: Date.now() - start,
      strippedPrompt: prompt,
    };
  }
}
