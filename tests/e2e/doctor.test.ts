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

import { checkHookRegistered } from '../../src/cli/doctor';
import { getHookPath } from '../../src/cli/hook-path';

let tmpDir: string;
let homeDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'claude-router-doctor-'));
  homeDir = path.join(tmpDir, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  setHomedir(homeDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function settingsPath(): string {
  return path.join(homeDir, '.claude', 'settings.json');
}

function writeSettings(hooks: unknown): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify({ hooks }, 'utf-8'), 'utf-8');
}

function homeHookPath(): string {
  return path.join(homeDir, 'dist', 'hooks', 'user-prompt-submit.js');
}

describe('checkHookRegistered', () => {
  it('$HOME form → pass', () => {
    writeSettings({
      UserPromptSubmit: [{
        matcher: '',
        hooks: [{ type: 'command', command: 'node "$HOME/dist/hooks/user-prompt-submit.js"' }],
      }],
    });
    const check = checkHookRegistered([homeHookPath()]);
    expect(check.pass).toBe(true);
    expect(check.detail).toBeUndefined();
  });

  it('${CLAUDE_PLUGIN_ROOT} form → pass', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', homeDir);
    writeSettings({
      UserPromptSubmit: [{
        matcher: '',
        hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/user-prompt-submit.js"' }],
      }],
    });
    const check = checkHookRegistered([homeHookPath()]);
    expect(check.pass).toBe(true);
    expect(check.detail).toBeUndefined();
  });

  it('absolute path form → pass', () => {
    writeSettings({
      UserPromptSubmit: [{
        matcher: '',
        hooks: [{ type: 'command', command: `node "${getHookPath()}"` }],
      }],
    });
    const check = checkHookRegistered();
    expect(check.pass).toBe(true);
    expect(check.detail).toBeUndefined();
  });

  it('unrelated command → fail with "not found"', () => {
    writeSettings({
      UserPromptSubmit: [{
        matcher: '',
        hooks: [{ type: 'command', command: '/usr/bin/other-hook' }],
      }],
    });
    const check = checkHookRegistered();
    expect(check.pass).toBe(false);
    expect(check.detail).toBe('not found');
  });

  it('same-named hook from another package → fail', () => {
    writeSettings({
      UserPromptSubmit: [{
        matcher: '',
        hooks: [{ type: 'command', command: 'node "/other/package/dist/hooks/user-prompt-submit.js"' }],
      }],
    });
    const check = checkHookRegistered();
    expect(check.pass).toBe(false);
    expect(check.detail).toBe('not found');
  });

  it('settings.json missing → fail with "settings.json not readable"', () => {
    const check = checkHookRegistered();
    expect(check.pass).toBe(false);
    expect(check.detail).toBe('settings.json not readable');
  });
});
