import { route } from '../router/router';
import { loadConfig, mergeConfig, type RouterConfigInput } from '../router/config';
import { TIERS, type RoutingDecision, type Tier } from '../types';
import { getLocalTimestamp, logDecision, getSessionId, hashPrompt } from '../telemetry/logger';
import { recordRoutingEvent } from '../telemetry/feedback';

export interface RouterInstance {
  route(prompt: string): Promise<RoutingDecision>;
  stats(): SessionStats;
}

export interface SessionStats {
  total: number;
  tiers: Record<Tier, number>;
  overrides: number;
  avg_latency_ms: number;
}

export function createRouter(options?: {
  config?: RouterConfigInput;
  telemetry?: boolean;
}): RouterInstance {
  const config = mergeConfig(loadConfig(), options?.config ?? {});
  const telemetryEnabled = options?.telemetry ?? true;
  const sessionStats: SessionStats = {
    total: 0,
    tiers: Object.fromEntries(TIERS.map((tier) => [tier, 0])) as Record<Tier, number>,
    overrides: 0,
    avg_latency_ms: 0,
  };

  let totalLatency = 0;

  return {
    async route(prompt: string): Promise<RoutingDecision> {
      const decision = await route(prompt, config);

      sessionStats.total++;
      sessionStats.tiers[decision.tier]++;
      totalLatency += decision.latencyMs;
      sessionStats.avg_latency_ms = Math.round(totalLatency / sessionStats.total);

      if (decision.source === 'override') {
        sessionStats.overrides++;
      }

      if (telemetryEnabled) {
        const ts = getLocalTimestamp();
        logDecision({
          ts,
          session_id: getSessionId(),
          prompt_hash: hashPrompt(prompt),
          prompt_tokens: prompt.trim().split(/\s+/).filter((token) => token.length > 0).length,
          tier: decision.tier,
          execution_mode: decision.execution.mode,
          ...(decision.execution.mode === 'delegate'
            ? { configured_model: decision.execution.model }
            : {}),
          source: decision.source,
          ...(decision.classifierFailure ? { classifier_failure: decision.classifierFailure } : {}),
          latency_ms: decision.latencyMs,
          manual_override: decision.source === 'override',
        });
        recordRoutingEvent(ts);
      }

      return decision;
    },

    stats(): SessionStats {
      return {
        ...sessionStats,
        tiers: { ...sessionStats.tiers },
      };
    },
  };
}
