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

// Static imports — os.homedir is mocked so these use our tmpDir
import { logDecision, markFollowup, readEvents, hashPrompt, type RoutingEvent } from '../../src/telemetry/logger';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'claude-router-telemetry-'));
  setHomedir(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function eventsPath(): string {
  return path.join(tmpDir, '.claude-router', 'events.jsonl');
}

function eventsDir(): string {
  return path.join(tmpDir, '.claude-router');
}

function makeEvent(
  overrides: Partial<Omit<RoutingEvent, 'had_followup'>> = {},
): Omit<RoutingEvent, 'had_followup'> {
  return {
    ts: new Date().toISOString(),
    session_id: 'test-session',
    prompt_hash: 'abc123def456',
    prompt_tokens: 10,
    tier: 'STANDARD',
    execution_mode: 'direct',
    source: 'signal',
    latency_ms: 42,
    manual_override: false,
    ...overrides,
  };
}

describe('telemetry e2e', () => {
  it('writes one JSONL entry with the configured execution, not a provider model', () => {
    logDecision(makeEvent());

    const parsed = JSON.parse(fs.readFileSync(eventsPath(), 'utf-8').trim());
    expect(parsed).toMatchObject({
      tier: 'STANDARD',
      execution_mode: 'direct',
      source: 'signal',
      had_followup: false,
    });
    expect(parsed).not.toHaveProperty('model');
  });

  it('records delegate aliases only as configured targets', () => {
    logDecision(
      makeEvent({
        tier: 'COMPLEX',
        execution_mode: 'delegate',
        configured_model: 'frontier-alias',
      }),
    );

    expect(readEvents()).toEqual([
      expect.objectContaining({
        tier: 'COMPLEX',
        execution_mode: 'delegate',
        configured_model: 'frontier-alias',
      }),
    ]);
  });

  it('creates the telemetry directory and appends independent JSON lines', () => {
    expect(fs.existsSync(eventsDir())).toBe(false);
    logDecision(makeEvent({ ts: '2026-01-01T00:00:00.000Z' }));
    logDecision(makeEvent({ ts: '2026-01-01T00:00:01.000Z' }));

    const lines = fs.readFileSync(eventsPath(), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).ts)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ]);
  });

  it('marks a matching event as followed up without changing other events', () => {
    logDecision(makeEvent({ ts: '2026-01-01T00:00:00.000Z', session_id: 'one' }));
    logDecision(makeEvent({ ts: '2026-01-01T00:00:01.000Z', session_id: 'two' }));
    markFollowup('one', '2026-01-01T00:00:00.000Z');

    expect(readEvents().map((event) => event.had_followup)).toEqual([true, false]);
  });

  it('normalizes legacy tiers and classifier source without treating legacy models as targets', () => {
    fs.mkdirSync(eventsDir(), { recursive: true });
    fs.writeFileSync(
      eventsPath(),
      `${JSON.stringify({
        ts: '2026-01-01T00:00:00.000Z',
        session_id: 'legacy',
        prompt_hash: 'abc123def456',
        prompt_tokens: 5,
        tier: 'LOW',
        model: 'claude-haiku-4-5-20251001',
        source: 'haiku',
        latency_ms: 3,
        had_followup: false,
        manual_override: false,
      })}\n`,
      'utf-8',
    );

    expect(readEvents()).toEqual([
      expect.objectContaining({
        tier: 'TRIVIAL',
        execution_mode: 'delegate',
        source: 'classifier',
      }),
    ]);
    expect(readEvents()[0]).not.toHaveProperty('configured_model');
  });

  it('skips malformed entries and accepts Windows line endings', () => {
    fs.mkdirSync(eventsDir(), { recursive: true });
    const good = JSON.stringify(makeEvent({ ts: '2026-01-01T00:00:00.000Z' }));
    fs.writeFileSync(eventsPath(), `${good}\r\nnot-json\r\n${good}\r\n`, 'utf-8');

    expect(readEvents()).toHaveLength(2);
  });

  it('hashes prompts without retaining their contents', () => {
    const prompt = 'super secret prompt';
    const hash = hashPrompt(prompt);

    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(hash).toBe(hashPrompt(prompt));
    expect(hash).not.toContain('secret');
  });
});
