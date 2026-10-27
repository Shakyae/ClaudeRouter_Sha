export const TIERS = [
  'SIMPLE',
  'STANDARD',
  'COMPLEX',
  'EXTREME',
] as const;

export type Tier = (typeof TIERS)[number];

export type ExecutionConfig =
  | {
      mode: 'direct';
    }
  | {
      mode: 'delegate';
      model: string;
    };

export type RoutingSource = 'signal' | 'classifier' | 'override' | 'fallback';
export type ClassifierFailure = 'invalid_output' | 'timeout' | 'request_error' | `http_${number}`;

export interface RoutingDecision {
  tier: Tier;
  source: RoutingSource;
  execution: ExecutionConfig;
  /** Planned fallback models, derived from lower tiers; not a claim about what ran. */
  fallbacks?: string[];
  directive: string | null;
  classifierModel?: string;
  classifierRequestModel?: string;
  classifierFailure?: ClassifierFailure;
  /** Sanitized, truncated reason returned by the Provider or gateway. */
  classifierError?: string;
  classifierAttempts?: number;
  classifierAttemptMs?: number[];
  latencyMs: number;
  strippedPrompt: string;
}

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}
