import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { markFollowup, readEvents, getSessionId } from './logger';

const FOLLOWUP_WINDOW_MS = 60_000; // 60 seconds

const LAST_EVENT_PATH = path.join(os.homedir(), '.claude-router', 'last-event.json');

interface LastEventRecord {
  session_id: string;
  ts: string;
  walltime: number;
}

function readLastEvent(): LastEventRecord | null {
  try {
    const content = fs.readFileSync(LAST_EVENT_PATH, 'utf-8');
    return JSON.parse(content) as LastEventRecord;
  } catch {
    return null;
  }
}

function writeLastEvent(record: LastEventRecord): void {
  try {
    fs.writeFileSync(LAST_EVENT_PATH, JSON.stringify(record), 'utf-8');
  } catch {
    // never throw
  }
}

export function recordRoutingEvent(ts: string): void {
  try {
    const sessionId = getSessionId();
    const now = Date.now();
    const prev = readLastEvent();
    if (prev && (now - prev.walltime) < FOLLOWUP_WINDOW_MS) {
      markFollowup(prev.session_id, prev.ts);
    }
    writeLastEvent({ session_id: sessionId, ts, walltime: now });
  } catch {
    // never throw
  }
}

export interface FeedbackStats {
  total_trivial: number;
  trivial_with_followup: number;
  followup_rate: number;
}

export function computeFollowupStats(daysBack: number = 7): FeedbackStats {
  const events = readEvents();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffIso = cutoff.toISOString();

  let totalTrivial = 0;
  let trivialWithFollowup = 0;

  for (const event of events) {
    if (event.ts < cutoffIso || event.tier !== 'TRIVIAL') continue;

    totalTrivial++;
    if (event.had_followup) {
      trivialWithFollowup++;
    }
  }

  return {
    total_trivial: totalTrivial,
    trivial_with_followup: trivialWithFollowup,
    followup_rate: totalTrivial > 0 ? trivialWithFollowup / totalTrivial : 0,
  };
}
