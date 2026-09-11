import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { isTier, type ClassifierFailure, type ExecutionConfig, type RoutingSource, type Tier } from '../types';

export interface RoutingEvent {
  ts: string;
  session_id: string;
  prompt_hash: string;
  prompt_tokens: number;
  tier: Tier;
  execution_mode: ExecutionConfig['mode'];
  configured_model?: string;
  classifier_failure?: ClassifierFailure;
  source: RoutingSource;
  latency_ms: number;
  had_followup: boolean;
  manual_override: boolean;
}


const LEGACY_TIER_MAP: Record<string, Tier> = {
  LOW: 'TRIVIAL',
  MEDIUM: 'STANDARD',
  HIGH: 'COMPLEX',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeSource(value: unknown): RoutingSource | null {
  if (value === 'haiku') {
    return 'classifier';
  }

  return value === 'signal' || value === 'classifier' || value === 'fallback' || value === 'override'
    ? value
    : null;
}

function isClassifierFailure(value: unknown): value is ClassifierFailure {
  return value === 'invalid_output'
    || value === 'timeout'
    || value === 'request_error'
    || (typeof value === 'string' && /^http_\d{3}$/.test(value));
}

function normalizeEvent(value: unknown): RoutingEvent | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawTier = value.tier;
  const tier = isTier(rawTier)
    ? rawTier
    : typeof rawTier === 'string'
      ? LEGACY_TIER_MAP[rawTier]
      : undefined;
  const source = normalizeSource(value.source);
  const executionMode = value.execution_mode === 'direct' || value.execution_mode === 'delegate'
    ? value.execution_mode
    : typeof rawTier === 'string' && LEGACY_TIER_MAP[rawTier]
      ? 'delegate'
      : null;

  if (
    !tier ||
    !source ||
    !executionMode ||
    typeof value.ts !== 'string' ||
    typeof value.session_id !== 'string' ||
    typeof value.prompt_hash !== 'string' ||
    typeof value.latency_ms !== 'number'
  ) {
    return null;
  }

  const configuredModel =
    executionMode === 'delegate' && typeof value.configured_model === 'string' && value.configured_model.trim()
      ? value.configured_model
      : undefined;
  const classifierFailure = isClassifierFailure(value.classifier_failure)
    ? value.classifier_failure
    : undefined;

  return {
    ts: value.ts,
    session_id: value.session_id,
    prompt_hash: value.prompt_hash,
    prompt_tokens: typeof value.prompt_tokens === 'number' ? value.prompt_tokens : 0,
    tier,
    execution_mode: executionMode,
    ...(configuredModel ? { configured_model: configuredModel } : {}),
    ...(classifierFailure ? { classifier_failure: classifierFailure } : {}),
    source,
    latency_ms: value.latency_ms,
    had_followup: value.had_followup === true,
    manual_override: value.manual_override === true || source === 'override',
  };
}

const SESSION_ID = crypto.randomUUID();

function getEventsDir(): string {
  return path.join(os.homedir(), '.claude-router');
}

function getEventsPath(): string {
  return path.join(getEventsDir(), 'events.jsonl');
}

export function getLocalTimestamp(date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const localDate = new Date(date.getTime() + offsetMinutes * 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteOffset / 60).toString().padStart(2, '0');
  const minutes = (absoluteOffset % 60).toString().padStart(2, '0');

  return `${localDate.toISOString().slice(0, -1)}${sign}${hours}:${minutes}`;
}

function ensureDir(): void {
  const dir = getEventsDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // ignore
  }
}

export function getSessionId(): string {
  return SESSION_ID;
}

export function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 12);
}

export function logDecision(event: Omit<RoutingEvent, 'had_followup'>): void {
  try {
    ensureDir();
    const full: RoutingEvent = { ...event, had_followup: false };
    const line = JSON.stringify(full) + '\n';
    fs.appendFileSync(getEventsPath(), line, 'utf-8');
  } catch {
    // Never throw — telemetry must not crash the hook
  }
}

export function markFollowup(session_id: string, ts: string): void {
  try {
    ensureDir();
    const marker = JSON.stringify({ type: 'followup_marker', session_id, ts }) + '\n';
    fs.appendFileSync(getEventsPath(), marker, 'utf-8');
  } catch {
    // Never throw
  }
}

export function readEvents(): RoutingEvent[] {
  try {
    const eventsPath = getEventsPath();
    if (!fs.existsSync(eventsPath)) return [];

    const content = fs.readFileSync(eventsPath, 'utf-8');
    const events: RoutingEvent[] = [];
    const followups = new Set<string>();

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed) && parsed.type === 'followup_marker') {
          if (typeof parsed.session_id === 'string' && typeof parsed.ts === 'string') {
            followups.add(`${parsed.session_id}:${parsed.ts}`);
          }
          continue;
        }

        const event = normalizeEvent(parsed);
        if (event) {
          events.push(event);
        }
      } catch {
        // Skip malformed JSONL entries.
      }
    }

    for (const event of events) {
      if (followups.has(`${event.session_id}:${event.ts}`)) {
        event.had_followup = true;
      }
    }

    return events;
  } catch {
    return [];
  }
}
