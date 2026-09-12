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
import {
  getLocalTimestamp,
  hashPrompt,
  logDecision,
  markFollowup,
  readEvents,
  type RoutingEvent,
} from '../../src/telemetry/logger';

let tmpDir: string;
const DAY_MS = 24 * 60 * 60 * 1000;

function recentTimestamp(daysAgo = 0): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString();
}

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

  it('writes adaptive local timestamps with an explicit offset', () => {
    const date = new Date('2026-09-11T21:45:48.652Z');
    const timestamp = getLocalTimestamp(date);

    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    expect(new Date(timestamp).getTime()).toBe(date.getTime());
  });

  it('records classifier fallback reasons without raw error details', () => {
    logDecision(makeEvent({ source: 'fallback', classifier_failure: 'http_400' }));

    expect(readEvents()).toEqual([
      expect.objectContaining({ source: 'fallback', classifier_failure: 'http_400' }),
    ]);
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

  it('creates the telemetry directory and writes newest entries first', () => {
    expect(fs.existsSync(eventsDir())).toBe(false);
    const older = recentTimestamp(1);
    const newer = recentTimestamp();
    logDecision(makeEvent({ ts: older }));
    logDecision(makeEvent({ ts: newer }));

    const lines = fs.readFileSync(eventsPath(), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).ts)).toEqual([newer, older]);
  });

  it('marks a matching event as followed up without changing other events', () => {
    const first = recentTimestamp(1);
    const second = recentTimestamp();
    logDecision(makeEvent({ ts: first, session_id: 'one' }));
    logDecision(makeEvent({ ts: second, session_id: 'two' }));
    markFollowup('one', first);

    expect(readEvents().map((event) => event.had_followup)).toEqual([false, true]);
  });

  it('prunes old entries before writing while retaining matching recent markers', () => {
    const old = recentTimestamp(31);
    const recent = recentTimestamp(2);
    const newest = recentTimestamp();
    fs.mkdirSync(eventsDir(), { recursive: true });
    fs.writeFileSync(
      eventsPath(),
      [
        JSON.stringify(makeEvent({ ts: old, session_id: 'old' })),
        JSON.stringify(makeEvent({ ts: recent, session_id: 'recent' })),
        JSON.stringify({ type: 'followup_marker', session_id: 'recent', ts: recent }),
        'not-json',
        JSON.stringify({ type: 'followup_marker', session_id: 'old', ts: old }),
        '',
      ].join('\n'),
      'utf-8',
    );

    logDecision(makeEvent({ ts: newest, session_id: 'new' }));

    const lines = fs.readFileSync(eventsPath(), 'utf-8').trim().split('\n');
    const parsedLines = lines.map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(parsedLines[0]).toMatchObject({ session_id: 'new' });
    expect(parsedLines.some((line) => line.type === 'followup_marker' && line.session_id === 'recent')).toBe(true);
    expect(parsedLines.some((line) => line.session_id === 'old')).toBe(false);
    expect(readEvents().map((event) => [event.session_id, event.had_followup])).toEqual([
      ['new', false],
      ['recent', true],
    ]);
  });

  it('normalizes legacy tiers and classifier source without treating legacy models as targets', () => {
    fs.mkdirSync(eventsDir(), { recursive: true });
    fs.writeFileSync(
      eventsPath(),
      `${JSON.stringify({
        ts: recentTimestamp(1),
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
    const good = JSON.stringify(makeEvent({ ts: recentTimestamp(1) }));
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
