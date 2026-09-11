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

export interface RoutingDecision {
  tier: Tier;
  source: RoutingSource;
  execution: ExecutionConfig;
  directive: string | null;
  classifierModel?: string;
  latencyMs: number;
  strippedPrompt: string;
}

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}
