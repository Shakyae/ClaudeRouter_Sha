export const TIERS = [
  'TRIVIAL',
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
  directive: string | null;
  classifierModel?: string;
  classifierFailure?: ClassifierFailure;
  latencyMs: number;
  strippedPrompt: string;
}

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}
