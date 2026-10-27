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

import { getHookCommand, getHookPath, isRouterCommand, isRouterHook } from '../src/cli/hook-path';

let tmpDir: string;
let homeDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'claude-router-hook-path-'));
  homeDir = path.join(tmpDir, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  setHomedir(homeDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('isRouterCommand', () => {
  it('absolute path → true', () => {
    expect(isRouterCommand(`node "${getHookPath()}"`)).toBe(true);
  });

  it('absolute path with extra node flags → true', () => {
    expect(isRouterCommand(`node --enable-source-maps "${getHookPath()}"`)).toBe(true);
  });

  it('$HOME form → true', () => {
    const expected = [path.join(homeDir, 'dist', 'hooks', 'user-prompt-submit.js')];
    expect(isRouterCommand('node "$HOME/dist/hooks/user-prompt-submit.js"', expected)).toBe(true);
  });

  it('${HOME} form → true', () => {
    const expected = [path.join(homeDir, 'dist', 'hooks', 'user-prompt-submit.js')];
    expect(isRouterCommand('node "${HOME}/dist/hooks/user-prompt-submit.js"', expected)).toBe(true);
  });

  it('~ form → true', () => {
    const expected = [path.join(homeDir, 'dist', 'hooks', 'user-prompt-submit.js')];
    expect(isRouterCommand('node "~/dist/hooks/user-prompt-submit.js"', expected)).toBe(true);
  });

  it('${CLAUDE_PLUGIN_ROOT} form with env set → true', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', homeDir);
    const expected = [path.join(homeDir, 'dist', 'hooks', 'user-prompt-submit.js')];
    expect(
      isRouterCommand('node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/user-prompt-submit.js"', expected)
    ).toBe(true);
  });

  it('${CLAUDE_PLUGIN_ROOT} form with env unset → expands to package root → true', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    expect(
      isRouterCommand('node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/user-prompt-submit.js"')
    ).toBe(true);
  });

  it('%USERPROFILE% form → true', () => {
    vi.stubEnv('USERPROFILE', homeDir);
    const expected = [path.join(homeDir, 'dist', 'hooks', 'user-prompt-submit.js')];
    expect(
      isRouterCommand('node "%USERPROFILE%/dist/hooks/user-prompt-submit.js"', expected)
    ).toBe(true);
  });

  it('$env:USERPROFILE form → true', () => {
    vi.stubEnv('USERPROFILE', homeDir);
    const expected = [path.join(homeDir, 'dist', 'hooks', 'user-prompt-submit.js')];
    expect(
      isRouterCommand('node "$env:USERPROFILE/dist/hooks/user-prompt-submit.js"', expected)
    ).toBe(true);
  });

  it('$USERPROFILE form → true', () => {
    vi.stubEnv('USERPROFILE', homeDir);
    const expected = [path.join(homeDir, 'dist', 'hooks', 'user-prompt-submit.js')];
    expect(
      isRouterCommand('node "$USERPROFILE/dist/hooks/user-prompt-submit.js"', expected)
    ).toBe(true);
  });

  it('%USERPROFILE% form with env unset → left unexpanded → false', () => {
    vi.stubEnv('USERPROFILE', '');
    const homeExpected = [path.join(homeDir, 'dist', 'hooks', 'user-prompt-submit.js')];
    const otherExpected = [path.join(tmpDir, 'other', 'dist', 'hooks', 'user-prompt-submit.js')];
    expect(
      isRouterCommand('node "%USERPROFILE%/dist/hooks/user-prompt-submit.js"', homeExpected)
    ).toBe(false);
    expect(
      isRouterCommand('node "%USERPROFILE%/dist/hooks/user-prompt-submit.js"', otherExpected)
    ).toBe(false);
  });

  it('single-quoted form → true', () => {
    const expected = [path.join(homeDir, 'dist', 'hooks', 'user-prompt-submit.js')];
    expect(isRouterCommand("node '$HOME/dist/hooks/user-prompt-submit.js'", expected)).toBe(true);
  });

  it('path containing spaces → true', () => {
    const expected = [path.join(homeDir, 'my dir', 'dist', 'hooks', 'user-prompt-submit.js')];
    const command = `node "${path.join(homeDir, 'my dir', 'dist', 'hooks', 'user-prompt-submit.js')}"`;
    expect(isRouterCommand(command, expected)).toBe(true);
  });

  it('user-prompt-submit.js.bak masquerade → false', () => {
    const expected = [path.join(homeDir, 'dist', 'hooks', 'user-prompt-submit.js')];
    expect(
      isRouterCommand('node "$HOME/dist/hooks/user-prompt-submit.js.bak"', expected)
    ).toBe(false);
  });

  it('same-named hook from another package → false', () => {
    const expected = [path.join(homeDir, 'dist', 'hooks', 'user-prompt-submit.js')];
    expect(
      isRouterCommand('node "/other/package/dist/hooks/user-prompt-submit.js"', expected)
    ).toBe(false);
  });

  it('unrelated command → false', () => {
    expect(isRouterCommand('/usr/bin/other-hook')).toBe(false);
  });

  it('non-string input → false', () => {
    expect(isRouterCommand(undefined)).toBe(false);
    expect(isRouterCommand(42)).toBe(false);
    expect(isRouterCommand(null)).toBe(false);
  });
});

describe('getHookCommand', () => {
  it.skipIf(process.platform === 'win32')('hook inside home → $HOME-relative form', () => {
    // Pick an ancestor of the hook so the relative path is deterministic.
    const home = path.resolve(getHookPath(), '..', '..', '..', '..');
    setHomedir(home);
    const relative = path.relative(home, getHookPath()).split(path.sep).join('/');
    expect(getHookCommand()).toBe(`node "$HOME/${relative}"`);
  });

  it.skipIf(process.platform === 'win32')('hook outside home → absolute path', () => {
    setHomedir(homeDir);
    expect(path.relative(homeDir, getHookPath()).startsWith('..')).toBe(true);
    expect(getHookCommand()).toBe(`node "${getHookPath()}"`);
  });

  it('round-trips through isRouterCommand', () => {
    const home = path.resolve(getHookPath(), '..', '..', '..', '..');
    setHomedir(home);
    expect(isRouterCommand(getHookCommand())).toBe(true);
  });
});

describe('isRouterHook', () => {
  it('nested matcher/hooks entry → true', () => {
    const expected = [path.join(homeDir, 'dist', 'hooks', 'user-prompt-submit.js')];
    const entry = {
      matcher: '',
      hooks: [
        { type: 'command', command: 'node "$HOME/dist/hooks/user-prompt-submit.js"' },
      ],
    };
    expect(isRouterHook(entry, expected)).toBe(true);
  });

  it('flat command entry → true', () => {
    const expected = [path.join(homeDir, 'dist', 'hooks', 'user-prompt-submit.js')];
    expect(
      isRouterHook({ command: 'node "$HOME/dist/hooks/user-prompt-submit.js"' }, expected)
    ).toBe(true);
  });

  it('unrelated entry → false', () => {
    const expected = [path.join(homeDir, 'dist', 'hooks', 'user-prompt-submit.js')];
    expect(
      isRouterHook(
        { matcher: '', hooks: [{ type: 'command', command: '/usr/bin/other-hook' }] },
        expected
      )
    ).toBe(false);
  });

  it('empty object → false', () => {
    expect(isRouterHook({})).toBe(false);
  });

  it('null → false', () => {
    expect(isRouterHook(null)).toBe(false);
  });
});
