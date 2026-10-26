import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function getPackageRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

export function getHookPath(): string {
  return path.resolve(getPackageRoot(), 'dist', 'hooks', 'user-prompt-submit.js');
}

export function getLegacyHookPath(): string {
  return path.resolve(getPackageRoot(), 'hooks', 'user-prompt-submit.sh');
}

export function getHookCommand(): string {
  return `node "${getHookPath()}"`;
}

function getRouterHookPaths(): string[] {
  return [getHookPath(), getLegacyHookPath()];
}

/**
 * Split a hook command into the path-like tokens it contains. Quoted segments
 * are taken whole so paths containing spaces survive; bare tokens are split on
 * whitespace.
 */
function extractHookPathTokens(command: string): string[] {
  const tokens: string[] = [];

  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'/g)) {
    const segment = match[1] ?? match[2];
    if (segment) {
      tokens.push(segment);
    }
  }

  for (const token of command.replace(/"[^"]*"|'[^']*'/g, ' ').split(/\s+/)) {
    if (token) {
      tokens.push(token);
    }
  }

  return tokens.filter((token) => /user-prompt-submit\.(?:js|sh)$/.test(token));
}

/**
 * Expand `$HOME`, `${HOME}`, `~`, `${CLAUDE_PLUGIN_ROOT}` and the Windows home
 * variable spellings `%USERPROFILE%`, `$env:USERPROFILE` and `$USERPROFILE`.
 * `CLAUDE_PLUGIN_ROOT` resolves to the environment variable when it is set and
 * to the running package root otherwise, so both spellings are covered.
 * The Windows spellings are only expanded when `USERPROFILE` is set, because an
 * unset variable would not resolve in the shell either.
 */
function expandPathVariables(raw: string): string[] {
  const home = os.homedir();
  const pluginRoots = [process.env.CLAUDE_PLUGIN_ROOT, getPackageRoot()].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );

  const variants = new Set<string>();
  for (const pluginRoot of pluginRoots) {
    let expanded = raw
      .replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, () => home)
      .replace(
        /\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT(?![A-Za-z0-9_])/g,
        () => pluginRoot
      );
    const userProfile = process.env.USERPROFILE;
    if (userProfile) {
      expanded = expanded
        .replace(/%USERPROFILE%/g, () => userProfile)
        .replace(/\$env:USERPROFILE(?![A-Za-z0-9_])/g, () => userProfile)
        .replace(/\$USERPROFILE(?![A-Za-z0-9_])/g, () => userProfile);
    }
    if (expanded === '~') {
      expanded = home;
    } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
      expanded = path.join(home, expanded.slice(2));
    }
    variants.add(expanded);
  }
  return Array.from(variants);
}

/**
 * The resolved path plus its real path. Symlinks are resolved on the nearest
 * existing ancestor, so a not-yet-built hook script still compares equal to
 * the same path reached through a symlinked directory.
 */
function pathVariants(target: string): string[] {
  const resolved = path.resolve(target);
  const variants = new Set<string>([resolved]);

  let current = resolved;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      variants.add(tail.length > 0 ? path.join(real, ...tail) : real);
      break;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      tail.unshift(path.basename(current));
      current = parent;
    }
  }

  return Array.from(variants);
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function samePath(left: string, right: string): boolean {
  const leftVariants = pathVariants(left);
  const rightVariants = pathVariants(right);
  return leftVariants.some((value) =>
    rightVariants.some((other) => pathsEqual(value, other))
  );
}

function resolveExpectedPaths(
  expectedPaths: readonly string[] | undefined
): readonly string[] {
  return Array.isArray(expectedPaths) ? expectedPaths : getRouterHookPaths();
}

export function isRouterCommand(
  command: unknown,
  expectedPaths?: readonly string[]
): boolean {
  if (typeof command !== 'string') {
    return false;
  }
  const expected = resolveExpectedPaths(expectedPaths);
  for (const token of extractHookPathTokens(command)) {
    for (const expanded of expandPathVariables(token)) {
      const resolved = path.resolve(expanded);
      if (expected.some((candidate) => samePath(resolved, candidate))) {
        return true;
      }
    }
  }
  return false;
}

export function isRouterHook(
  entry: unknown,
  expectedPaths?: readonly string[]
): boolean {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const command = (entry as { command?: unknown }).command;
  if (isRouterCommand(command, expectedPaths)) {
    return true;
  }
  const hooks = (entry as { hooks?: unknown }).hooks;
  return Array.isArray(hooks) && hooks.some(
    (hook: unknown) => isRouterHook(hook, expectedPaths)
  );
}
