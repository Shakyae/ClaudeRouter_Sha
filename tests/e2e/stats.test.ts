import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const { getHomedir, setHomedir } = vi.hoisted(() => {
  let homedir = '';
  return {
    getHomedir: () => homedir,
    setHomedir: (v: string) => { homedir = v; },
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: getHomedir };
});

import { computeStats, printStats } from '../../src/cli/stats';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/router/config';

let tmpDir: string;
let logOutput: string[];

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'claude-router-stats-'));
  setHomedir(tmpDir);
  logOutput = [];
  vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
    logOutput.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function eventsDir(): string {
  return path.join(tmpDir, '.claude-router');
}

function eventsPath(): string {
  return path.join(eventsDir(), 'events.jsonl');
}

function makeEventLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    session_id: 'test-session',
    prompt_hash: 'abc123def456',
    prompt_tokens: 50,
    tier: 'STANDARD',
    execution_mode: 'direct',
    source: 'classifier',
    latency_ms: 42,
    had_followup: false,
    manual_override: false,
    ...overrides,
  });
}

function writeEvents(lines: string[]): void {
  fs.mkdirSync(eventsDir(), { recursive: true });
  fs.writeFileSync(eventsPath(), lines.join('\n') + '\n', 'utf-8');
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

describe('stats e2e', () => {
  it('counts every five-tier execution and routing outcome', () => {
    writeEvents([
      makeEventLine({ tier: 'TRIVIAL', execution_mode: 'delegate', configured_model: 'haiku' }),
      makeEventLine({ tier: 'SIMPLE', execution_mode: 'delegate', configured_model: 'sonnet' }),
      makeEventLine({ tier: 'STANDARD', execution_mode: 'direct' }),
      makeEventLine({ tier: 'COMPLEX', execution_mode: 'delegate', configured_model: 'opus', source: 'override', manual_override: true }),
      makeEventLine({ tier: 'EXTREME', execution_mode: 'delegate', configured_model: 'fable', source: 'fallback' }),
    ]);

    expect(computeStats(7)).toMatchObject({
      total: 5,
      tierCounts: {
        TRIVIAL: 1,
        SIMPLE: 1,
        STANDARD: 1,
        COMPLEX: 1,
        EXTREME: 1,
      },
      direct: 1,
      delegated: 4,
      fallbacks: 1,
      manualOverrides: 1,
    });
  });

  it('normalizes legacy telemetry into the documented five-tier mapping', () => {
    writeEvents([
      makeEventLine({ tier: 'LOW', model: 'legacy-low', execution_mode: undefined, source: 'haiku' }),
      makeEventLine({ tier: 'MEDIUM', model: 'legacy-medium', execution_mode: undefined, source: 'haiku' }),
      makeEventLine({ tier: 'HIGH', model: 'legacy-high', execution_mode: undefined, source: 'haiku' }),
    ]);

    const stats = computeStats(7);
    expect(stats.tierCounts).toEqual({
      TRIVIAL: 1,
      SIMPLE: 0,
      STANDARD: 1,
      COMPLEX: 1,
      EXTREME: 0,
    });
    expect(stats.delegated).toBe(3);
  });

  it('calculates the follow-up rate from TRIVIAL events', () => {
    const sessionId = 'follow-up';
    const ts = daysAgo(1);
    const nextTs = new Date(new Date(ts).getTime() + 1_000).toISOString();
    writeEvents([
      makeEventLine({ tier: 'TRIVIAL', execution_mode: 'delegate', session_id: sessionId, ts }),
      makeEventLine({ tier: 'TRIVIAL', execution_mode: 'delegate', session_id: sessionId, ts: nextTs }),
      JSON.stringify({ type: 'followup_marker', session_id: sessionId, ts }),
    ]);

    expect(computeStats(7).followupRate).toBeCloseTo(0.5, 5);
  });

  it('filters old events and handles missing or malformed JSONL entries', () => {
    writeEvents([
      makeEventLine({ ts: daysAgo(8) }),
      makeEventLine({ ts: daysAgo(1), tier: 'SIMPLE', execution_mode: 'delegate' }),
      '{broken JSON',
    ]);

    const stats = computeStats(7);
    expect(stats.total).toBe(1);
    expect(stats.tierCounts.SIMPLE).toBe(1);
  });

  it('prints configured execution targets without claiming provider model mappings', () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      tiers: {
        EXTREME: { mode: 'delegate', model: 'frontier-alias' },
        STANDARD: { mode: 'direct' },
      },
    });
    writeEvents([makeEventLine({ tier: 'EXTREME', execution_mode: 'delegate', configured_model: 'frontier-alias' })]);

    printStats(7, config);
    const output = logOutput.join('\n');
    expect(output).toContain('EXTREME');
    expect(output).toContain('delegate (frontier-alias)');
    expect(output).toContain('STANDARD');
    expect(output).toContain('direct');
    expect(output).toContain('Classifier fallbacks:');
    expect(output).toContain('Follow-up rate (TRIVIAL)');
    expect(output).not.toContain('Estimated Opus saved');
  });

  it('reports zeroes when no event file exists', () => {
    const stats = computeStats(7);
    expect(stats.total).toBe(0);
    expect(stats.tierCounts).toEqual({
      TRIVIAL: 0,
      SIMPLE: 0,
      STANDARD: 0,
      COMPLEX: 0,
      EXTREME: 0,
    });
  });
});
