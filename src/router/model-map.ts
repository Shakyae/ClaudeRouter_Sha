import type { RouterConfig } from './config';
import { TIERS, type ExecutionConfig, type Tier } from '../types';

export function shiftUp(tier: Tier): Tier {
  const currentIndex = TIERS.indexOf(tier);
  return TIERS[Math.min(currentIndex + 1, TIERS.length - 1)];
}

export function resolveExecution(tier: Tier, config: RouterConfig): ExecutionConfig {
  const effectiveTier = config.conservative ? shiftUp(tier) : tier;
  return config.tiers[effectiveTier];
}

export function resolveModel(tier: Tier, config: RouterConfig): string | null {
  const execution = resolveExecution(tier, config);
  return execution.mode === 'delegate' ? execution.model : null;
}
