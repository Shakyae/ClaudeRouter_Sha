import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveModelAlias, sanitizeModelName } from '../classifier/model-name';
import { route } from '../router/router';
import { loadConfig, type RouterConfig } from '../router/config';
import { recordRoutingEvent } from '../telemetry/feedback';
import { getLocalTimestamp, getSessionId, hashPrompt, logDecision } from '../telemetry/logger';
import { sanitizeErrorDetail } from '../redact';
import type { ClassifierFailure, RoutingDecision } from '../types';

interface HookInput {
  prompt: string;
  cwd?: string;
  is_subagent?: boolean;
}

export interface HookOutput {
  /** Context injected into the model, i.e. the existing `[ROUTER]` directive. */
  additionalContext: string;
  /** Message displayed to the user in the Claude Code UI, if any. */
  systemMessage?: string;
}

const NOTICE_THROTTLE_MS = 60_000;

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

/** Re-sanitizes at the output boundary so a caller-built decision cannot leak a key. */
function safeClassifierError(decision: RoutingDecision): string | undefined {
  return decision.classifierError ? sanitizeErrorDetail(decision.classifierError) || undefined : undefined;
}

function logDebug(config: RouterConfig, prompt: string, decision: RoutingDecision): void {
  if (process.env.CLAUDE_ROUTER_DEBUG !== '1' && !config.debug.enabled) {
    return;
  }

  try {
    const debugPath = path.join(os.homedir(), '.claude-router', 'debug.jsonl');
    const classifierError = safeClassifierError(decision);
    const event = {
      ts: getLocalTimestamp(),
      prompt_preview: prompt.slice(0, config.debug.prompt_preview_chars),
      prompt_length: prompt.length,
      tier: decision.tier,
      source: decision.source,
      execution_mode: decision.execution.mode,
      ...(decision.execution.mode === 'delegate'
        ? { configured_model: decision.execution.model }
        : {}),
      ...(decision.classifierModel ? { classifier_model: decision.classifierModel } : {}),
      ...(decision.classifierRequestModel ? { classifier_request_model: decision.classifierRequestModel } : {}),
      ...(decision.classifierFailure ? { classifier_failure: decision.classifierFailure } : {}),
      ...(classifierError ? { classifier_error: classifierError } : {}),
      ...(decision.classifierAttempts ? { classifier_attempts: decision.classifierAttempts } : {}),
      ...(decision.classifierAttemptMs ? { classifier_attempt_ms: decision.classifierAttemptMs } : {}),
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
    const ts = getLocalTimestamp();
    const classifierError = safeClassifierError(decision);
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
      ...(decision.classifierFailure ? { classifier_failure: decision.classifierFailure } : {}),
      ...(classifierError ? { classifier_error: classifierError } : {}),
      ...(decision.classifierAttempts ? { classifier_attempts: decision.classifierAttempts } : {}),
      ...(decision.classifierModel ? { classifier_model: decision.classifierModel } : {}),
      ...(decision.classifierRequestModel ? { classifier_request_model: decision.classifierRequestModel } : {}),
      latency_ms: decision.latencyMs,
      manual_override: decision.source === 'override',
    });
    recordRoutingEvent(ts);
  } catch {
    // Telemetry must not affect hook execution.
  }
}

function describeFailure(failure: ClassifierFailure): string {
  if (failure === 'invalid_output') return 'invalid output';
  if (failure === 'timeout') return 'timeout';
  if (failure === 'request_error') return 'request error';
  return `HTTP ${failure.slice('http_'.length)}`;
}

function buildFallbackMessage(decision: RoutingDecision): string {
  const failure = decision.classifierFailure ?? 'request_error';
  const model = decision.execution.mode === 'delegate'
    ? `, delegate model ${sanitizeModelName(resolveModelAlias(decision.execution.model) ?? decision.execution.model)}`
    : ', direct execution (current model)';
  const detail = safeClassifierError(decision);
  const reason = detail ? ` (${detail})` : '';
  return `ClaudeRouter: classifier ${describeFailure(failure)}${reason}; fell back to ${decision.tier}${model}.`;
}

function getNoticeStatePath(): string {
  return path.join(os.homedir(), '.claude-router', 'ui-notice.json');
}

// A hook process runs per prompt, so the throttle needs to survive between
// invocations. Failures here must never block the prompt.
export function shouldShowNotice(key: string, now = Date.now()): boolean {
  const statePath = getNoticeStatePath();
  try {
    const state: Record<string, number> = {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (isRecord(parsed)) {
        for (const [name, value] of Object.entries(parsed)) {
          if (typeof value === 'number' && Number.isFinite(value)) {
            state[name] = value;
          }
        }
      }
    } catch {
      // Missing or unreadable state means nothing was shown recently.
    }

    const last = state[key];
    if (last !== undefined && now - last < NOTICE_THROTTLE_MS) {
      return false;
    }

    state[key] = now;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf-8');
    return true;
  } catch {
    return true;
  }
}

function buildOutput(decision: RoutingDecision): HookOutput {
  const output: HookOutput = { additionalContext: decision.directive ?? '' };

  if (decision.source === 'fallback' && decision.classifierFailure) {
    if (shouldShowNotice(decision.classifierFailure)) {
      output.systemMessage = buildFallbackMessage(decision);
    }
  }

  return output;
}

export async function handleHookInput(value: unknown): Promise<HookOutput> {
  const input = parseHookInput(value);
  if (!input || input.is_subagent) {
    return { additionalContext: '' };
  }

  const config = loadConfig(input.cwd);
  const decision = await route(input.prompt, config);
  logTelemetry(input.prompt, decision);
  logDebug(config, input.prompt, decision);

  return buildOutput(decision);
}

/**
 * Directives only. Kept for callers and tests that do not need the UI notice.
 */
export async function processHookInput(value: unknown): Promise<string> {
  try {
    return (await handleHookInput(value)).additionalContext;
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

export function serializeHookOutput(output: HookOutput): string {
  if (!output.additionalContext && !output.systemMessage) {
    return '';
  }

  // Keep the historical plain-text stdout whenever there is nothing to show in
  // the UI: it is the most widely compatible way to inject the directive. The
  // JSON protocol is only used when a user-visible message is needed.
  if (!output.systemMessage) {
    return output.additionalContext;
  }

  return JSON.stringify({
    systemMessage: output.systemMessage,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: output.additionalContext,
    },
  });
}

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      return;
    }

    const output = await handleHookInput(JSON.parse(raw) as unknown);
    const serialized = serializeHookOutput(output);
    if (serialized) {
      process.stdout.write(serialized);
    }
  } catch {
    // Hooks must fail open: keep stdout empty and exit successfully.
  }
}

if (require.main === module) {
  void main();
}
