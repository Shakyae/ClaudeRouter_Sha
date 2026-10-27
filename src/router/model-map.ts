import type { RouterConfig } from './config';
import { sanitizeModelName } from '../classifier/model-name';
import { TIERS, type ExecutionConfig, type Tier } from '../types';

export function shiftUp(tier: Tier): Tier {
  const currentIndex = TIERS.indexOf(tier);
  return TIERS[Math.min(currentIndex + 1, TIERS.length - 1)];
}

function comparisonKey(model: string): string {
  return sanitizeModelName(model).trim().toLowerCase();
}

/**
 * Derives a delegate fallback chain from the lower-tier configurations.
 *
 * `tier` must already have the conservative shift applied: shifting again here
 * would reverse the chain under `conservative: true`.
 */
export function resolveFallbacks(tier: Tier, config: RouterConfig): string[] {
  const execution = config.tiers[tier];
  if (execution.mode !== 'delegate') {
    return [];
  }

  const seen = new Set<string>([comparisonKey(execution.model)]);
  const fallbacks: string[] = [];

  for (let index = TIERS.indexOf(tier) - 1; index >= 0; index -= 1) {
    const lower = config.tiers[TIERS[index]];
    if (lower.mode !== 'delegate') {
      continue;
    }
    const key = comparisonKey(lower.model);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    // The configured spelling is preserved; only comparison is normalized.
    fallbacks.push(lower.model);
  }

  return fallbacks;
}

export function resolveExecution(tier: Tier, config: RouterConfig): ExecutionConfig {
  const effectiveTier = config.conservative ? shiftUp(tier) : tier;
  return config.tiers[effectiveTier];
}

export function resolveModel(tier: Tier, config: RouterConfig): string | null {
  const execution = resolveExecution(tier, config);
  return execution.mode === 'delegate' ? execution.model : null;
}
