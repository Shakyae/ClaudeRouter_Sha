import { computeFollowupStats } from '../telemetry/feedback';
import { readEvents } from '../telemetry/logger';
import { loadConfig, type RouterConfig } from '../router/config';
import { TIERS, type Tier } from '../types';

export interface StatsResult {
  days: number;
  total: number;
  tierCounts: Record<Tier, number>;
  direct: number;
  delegated: number;
  fallbacks: number;
  manualOverrides: number;
  followupRate: number;
}

export function computeStats(days: number): StatsResult {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString();
  const filtered = readEvents().filter((event) => event.ts >= cutoffIso);
  const tierCounts = Object.fromEntries(TIERS.map((tier) => [tier, 0])) as Record<Tier, number>;
  let direct = 0;
  let delegated = 0;
  let fallbacks = 0;
  let manualOverrides = 0;

  for (const event of filtered) {
    tierCounts[event.tier]++;

    if (event.execution_mode === 'direct') {
      direct++;
    } else {
      delegated++;
    }
    if (event.source === 'fallback') {
      fallbacks++;
    }
    if (event.manual_override) {
      manualOverrides++;
    }
  }

  return {
    days,
    total: filtered.length,
    tierCounts,
    direct,
    delegated,
    fallbacks,
    manualOverrides,
    followupRate: computeFollowupStats(days).followup_rate,
  };
}

function pct(part: number, total: number): string {
  if (total === 0) return '0.0%';
  return ((part / total) * 100).toFixed(1) + '%';
}

function pad(str: string, width: number): string {
  return str.padStart(width);
}

export function printStats(days: number = 7, config: RouterConfig = loadConfig()): void {
  const stats = computeStats(days);
  const plain = !!process.env.NO_COLOR || !process.stdout.isTTY;
  const divider = plain ? '-'.repeat(58) : '─'.repeat(58);
  const tierLines = TIERS.map((tier) => {
    const execution = config.tiers[tier];
    const target = execution.mode === 'direct' ? 'direct' : `delegate (${execution.model})`;
    return `${tier.padEnd(8)} → ${target.padEnd(20)} ${pad(stats.tierCounts[tier].toString(), 5)}   (${pct(stats.tierCounts[tier], stats.total)})`;
  });

  const lines = [
    `ClaudeRouter — last ${stats.days} days`,
    divider,
    `Prompts routed:       ${pad(stats.total.toString(), 5)}`,
    ...tierLines,
    `Direct executions:    ${pad(stats.direct.toString(), 5)}`,
    `Delegated executions: ${pad(stats.delegated.toString(), 5)}`,
    `Classifier fallbacks: ${pad(stats.fallbacks.toString(), 5)}`,
    `Manual overrides:     ${pad(stats.manualOverrides.toString(), 5)}`,
    `Follow-up rate (TRIVIAL): ${(stats.followupRate * 100).toFixed(1)}%  ← lower is better`,
    divider,
  ];

  for (const line of lines) {
    console.log(line);
  }
}

