import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { route } from '../router/router';
import { loadConfig, type RouterConfig } from '../router/config';
import { recordRoutingEvent } from '../telemetry/feedback';
import { getSessionId, hashPrompt, logDecision } from '../telemetry/logger';
import type { RoutingDecision } from '../types';

interface HookInput {
  prompt: string;
  cwd?: string;
  is_subagent?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseHookInput(value: unknown): HookInput | null {
  if (!isRecord(value) || typeof value.prompt !== 'string' || !value.prompt.trim()) {
    return null;
  }

  return {
    prompt: value.prompt,
    ...(typeof value.cwd === 'string' && value.cwd.trim() ? { cwd: value.cwd } : {}),
    ...(value.is_subagent === true ? { is_subagent: true } : {}),
  };
}

function logDebug(config: RouterConfig, prompt: string, decision: RoutingDecision): void {
  if (process.env.CLAUDE_ROUTER_DEBUG !== '1' && !config.debug.enabled) {
    return;
  }

  try {
    const debugPath = path.join(os.homedir(), '.claude-router', 'debug.jsonl');
    const event = {
      ts: new Date().toISOString(),
      prompt_preview: prompt.slice(0, config.debug.prompt_preview_chars),
      prompt_length: prompt.length,
      tier: decision.tier,
      source: decision.source,
      execution_mode: decision.execution.mode,
      ...(decision.execution.mode === 'delegate'
        ? { configured_model: decision.execution.model }
        : {}),
      ...(decision.classifierModel ? { classifier_model: decision.classifierModel } : {}),
      latency_ms: decision.latencyMs,
    };

    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    fs.appendFileSync(debugPath, `${JSON.stringify(event)}\n`, 'utf-8');
  } catch {
    // Debug logging must not affect hook execution.
  }
}

function logTelemetry(prompt: string, decision: RoutingDecision): void {
  try {
    const ts = new Date().toISOString();
    logDecision({
      ts,
      session_id: getSessionId(),
      prompt_hash: hashPrompt(prompt),
      prompt_tokens: prompt.trim().split(/\s+/).filter(Boolean).length,
      tier: decision.tier,
      execution_mode: decision.execution.mode,
      ...(decision.execution.mode === 'delegate'
        ? { configured_model: decision.execution.model }
        : {}),
      source: decision.source,
      latency_ms: decision.latencyMs,
      manual_override: decision.source === 'override',
    });
    recordRoutingEvent(ts);
  } catch {
    // Telemetry must not affect hook execution.
  }
}

export async function processHookInput(value: unknown): Promise<string> {
  try {
    const input = parseHookInput(value);
    if (!input || input.is_subagent) {
      return '';
    }

    const config = loadConfig(input.cwd);
    const decision = await route(input.prompt, config);
    logTelemetry(input.prompt, decision);
    logDebug(config, input.prompt, decision);

    return decision.directive ?? '';
  } catch {
    return '';
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      return;
    }

    const directive = await processHookInput(JSON.parse(raw) as unknown);
    if (directive) {
      process.stdout.write(directive);
    }
  } catch {
    // Hooks must fail open: keep stdout empty and exit successfully.
  }
}

if (require.main === module) {
  void main();
}
