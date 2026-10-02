import fs from 'fs';
import * as os from 'os';
import path from 'path';
import { TIERS, isTier, type ExecutionConfig, type Tier } from '../types';

export interface RouterConfig {
  tiers: Record<Tier, ExecutionConfig>;
  classifier: {
    model: string;
    timeout_ms: number;
  };
  fallback_tier: Tier;
  conservative: boolean;
  overrides: Record<string, Tier>;
  debug: {
    enabled: boolean;
    prompt_preview_chars: number;
  };
}

export interface RouterConfigInput {
  tiers?: Partial<Record<Tier, ExecutionConfig>>;
  classifier?: Partial<RouterConfig['classifier']>;
  fallback_tier?: Tier;
  conservative?: boolean;
  overrides?: Record<string, Tier>;
  debug?: Partial<RouterConfig['debug']>;
}

export const DEFAULT_CONFIG: RouterConfig = {
  tiers: {
    SIMPLE: { mode: 'delegate', model: 'haiku' },
    STANDARD: { mode: 'delegate', model: 'sonnet' },
    COMPLEX: { mode: 'delegate', model: 'opus' },
    EXTREME: { mode: 'delegate', model: 'fable' },
  },
  classifier: {
    model: 'haiku',
    timeout_ms: 3000,
  },
  fallback_tier: 'STANDARD',
  conservative: false,
  overrides: {
    '//trivial': 'SIMPLE',
    '//simple': 'SIMPLE',
    '//standard': 'STANDARD',
    '//complex': 'COMPLEX',
    '//extreme': 'EXTREME',
  },
  debug: {
    enabled: false,
    prompt_preview_chars: 150,
  },
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function warn(message: string): void {
  try {
    process.stderr.write(`[claude-router] Warning: ${message}\n`);
  } catch {
    // Configuration validation must never block routing.
  }
}

function cloneConfig(config: RouterConfig): RouterConfig {
  return {
    tiers: { ...config.tiers },
    classifier: { ...config.classifier },
    fallback_tier: config.fallback_tier,
    conservative: config.conservative,
    overrides: { ...config.overrides },
    debug: { ...config.debug },
  };
}

function parseExecution(value: unknown, key: string): ExecutionConfig | null {
  if (!isRecord(value)) {
    warn(`${key} must be an object; ignoring it`);
    return null;
  }

  if (value.mode === 'direct') {
    return { mode: 'direct' };
  }

  if (value.mode === 'delegate' && typeof value.model === 'string' && value.model.trim()) {
    return { mode: 'delegate', model: value.model.trim() };
  }

  warn(`${key} must be { mode: "direct" } or { mode: "delegate", model: "..." }; ignoring it`);
  return null;
}

// Only `TRIVIAL` from the removed five-tier model needs explicit migration.
// `SIMPLE`, `STANDARD`, `COMPLEX`, and `EXTREME` were retained with the same
// spelling, so they are no longer "legacy" — they are interpreted under the
// current four-tier semantics. Shifting them (the previous behavior) created
// silent tier renames for users who relied on the old defaults.
const LEGACY_CONFIG_TIER_MAP: Record<string, Tier> = {
  TRIVIAL: 'SIMPLE',
};

function normalizeConfiguredTier(value: unknown, key: string): Tier | null {
  if (isTier(value)) {
    return value;
  }
  if (typeof value === 'string' && value in LEGACY_CONFIG_TIER_MAP) {
    warn(`${key} uses legacy tier ${value}; migrated to ${LEGACY_CONFIG_TIER_MAP[value]}. Update your configuration.`);
    return LEGACY_CONFIG_TIER_MAP[value];
  }
  return null;
}

function mergeTiers(result: RouterConfig, tiers: unknown): void {
  if (!isRecord(tiers)) {
    warn('tiers must be an object; ignoring it');
    return;
  }

  const migrated: Array<[Tier, unknown]> = [];
  for (const [key, value] of Object.entries(tiers)) {
    if (isTier(key)) {
      continue;
    }
    if (key in LEGACY_CONFIG_TIER_MAP) {
      const target = LEGACY_CONFIG_TIER_MAP[key];
      warn(`tiers.${key} is a legacy tier; migrated to tiers.${target}. Update your configuration.`);
      migrated.push([target, value]);
    } else {
      warn(`tiers.${key} is not a known tier; ignoring it`);
    }
  }

  // Apply legacy keys first so an explicit new tier key always takes precedence.
  for (const [tier, value] of migrated) {
    const execution = parseExecution(value, `tiers.${tier}`);
    if (execution) result.tiers[tier] = execution;
  }
  for (const tier of TIERS) {
    if (!(tier in tiers)) continue;
    const execution = parseExecution(tiers[tier], `tiers.${tier}`);
    if (execution) result.tiers[tier] = execution;
  }
}

function mergeClassifier(result: RouterConfig, classifier: unknown): void {
  if (!isRecord(classifier)) {
    warn('classifier must be an object; ignoring it');
    return;
  }

  if ('model' in classifier) {
    if (typeof classifier.model === 'string' && classifier.model.trim()) {
      result.classifier.model = classifier.model.trim();
    } else {
      warn('classifier.model must be a non-empty string; ignoring it');
    }
  }

  if ('timeout_ms' in classifier) {
    if (typeof classifier.timeout_ms === 'number' && Number.isFinite(classifier.timeout_ms) && classifier.timeout_ms >= 0) {
      result.classifier.timeout_ms = classifier.timeout_ms;
    } else {
      warn('classifier.timeout_ms must be a non-negative finite number; ignoring it');
    }
  }
}

function mergeOverrides(result: RouterConfig, overrides: unknown): void {
  if (!isRecord(overrides)) {
    warn('overrides must be an object; ignoring it');
    return;
  }

  for (const [prefix, rawTier] of Object.entries(overrides)) {
    if (!prefix.trim()) {
      warn(`overrides.${prefix} must map to a known tier; ignoring it`);
      continue;
    }
    const tier = normalizeConfiguredTier(rawTier, `overrides.${prefix}`);
    if (!tier) {
      warn(`overrides.${prefix} must map to a known tier; ignoring it`);
      continue;
    }
    result.overrides[prefix] = tier;
  }
}

function mergeDebug(result: RouterConfig, debug: unknown): void {
  if (!isRecord(debug)) {
    warn('debug must be an object; ignoring it');
    return;
  }

  if ('enabled' in debug) {
    if (typeof debug.enabled === 'boolean') {
      result.debug.enabled = debug.enabled;
    } else {
      warn('debug.enabled must be a boolean; ignoring it');
    }
  }

  if ('prompt_preview_chars' in debug) {
    if (typeof debug.prompt_preview_chars === 'number' && Number.isInteger(debug.prompt_preview_chars) && debug.prompt_preview_chars >= 0) {
      result.debug.prompt_preview_chars = debug.prompt_preview_chars;
    } else {
      warn('debug.prompt_preview_chars must be a non-negative integer; ignoring it');
    }
  }
}

export function mergeConfig(base: RouterConfig, override: unknown): RouterConfig {
  const result = cloneConfig(base);
  if (!isRecord(override)) {
    warn('configuration root must be an object; ignoring it');
    return result;
  }

  if ('tiers' in override) {
    mergeTiers(result, override.tiers);
  }
  if ('classifier' in override) {
    mergeClassifier(result, override.classifier);
  }
  if ('fallback_tier' in override) {
    const tier = normalizeConfiguredTier(override.fallback_tier, 'fallback_tier');
    if (tier) {
      result.fallback_tier = tier;
    } else {
      warn('fallback_tier must be a known tier; ignoring it');
    }
  }
  if ('conservative' in override) {
    if (typeof override.conservative === 'boolean') {
      result.conservative = override.conservative;
    } else {
      warn('conservative must be a boolean; ignoring it');
    }
  }
  if ('overrides' in override) {
    mergeOverrides(result, override.overrides);
  }
  if ('debug' in override) {
    mergeDebug(result, override.debug);
  }

  return result;
}

function readJsonFile(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function loadConfig(cwd?: string): RouterConfig {
  let config = cloneConfig(DEFAULT_CONFIG);

  const globalConfig = readJsonFile(path.join(os.homedir(), '.claude-router.json'));
  if (globalConfig !== null) {
    config = mergeConfig(config, globalConfig);
  }

  const projectConfig = readJsonFile(path.join(cwd ?? process.cwd(), '.claude-router.json'));
  if (projectConfig !== null) {
    config = mergeConfig(config, projectConfig);
  }

  return config;
}
