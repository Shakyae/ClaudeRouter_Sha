import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const { getHomedir, setHomedir } = vi.hoisted(() => {
  let homedir = '';
  return {
    getHomedir: () => homedir,
    setHomedir: (value: string) => {
      homedir = value;
    },
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: getHomedir };
});

import { loadConfig } from '../../src/router/config';

let tempDir: string;
let homeDir: string;
let projectDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'claude-router-config-'));
  homeDir = path.join(tempDir, 'home');
  projectDir = path.join(tempDir, 'project');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  setHomedir(homeDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(directory: string, config: object): void {
  writeFileSync(path.join(directory, '.claude-router.json'), JSON.stringify(config), 'utf-8');
}

describe('config loading', () => {
  it('loads four independent default tier executions', () => {
    const config = loadConfig(projectDir);

    expect(config.tiers.SIMPLE).toEqual({ mode: 'delegate', model: 'haiku' });
    expect(config.tiers.STANDARD).toEqual({ mode: 'delegate', model: 'sonnet' });
    expect(config.tiers.COMPLEX).toEqual({ mode: 'delegate', model: 'opus' });
    expect(config.tiers.EXTREME).toEqual({ mode: 'delegate', model: 'fable' });
    expect(config.fallback_tier).toBe('STANDARD');
    expect(config.classifier).toEqual({ model: 'haiku', timeout_ms: 3000 });
  });

  it('deep-merges a partial tier override without changing other tiers', () => {
    writeConfig(projectDir, {
      tiers: {
        EXTREME: { mode: 'delegate', model: 'frontier-v2' },
      },
    });

    const config = loadConfig(projectDir);

    expect(config.tiers.EXTREME).toEqual({ mode: 'delegate', model: 'frontier-v2' });
    expect(config.tiers.SIMPLE).toEqual({ mode: 'delegate', model: 'haiku' });
    expect(config.tiers.STANDARD).toEqual({ mode: 'delegate', model: 'sonnet' });
  });

  it('applies project configuration after global configuration', () => {
    writeConfig(homeDir, {
      tiers: {
        SIMPLE: { mode: 'delegate', model: 'global-simple' },
      },
      classifier: { model: 'global-classifier', timeout_ms: 1500 },
      debug: { enabled: true },
    });
    writeConfig(projectDir, {
      tiers: {
        SIMPLE: { mode: 'delegate', model: 'project-simple' },
      },
      classifier: { timeout_ms: 2500 },
      debug: { prompt_preview_chars: 80 },
    });

    const config = loadConfig(projectDir);

    expect(config.tiers.SIMPLE).toEqual({ mode: 'delegate', model: 'project-simple' });
    expect(config.classifier).toEqual({ model: 'global-classifier', timeout_ms: 2500 });
    expect(config.debug).toEqual({ enabled: true, prompt_preview_chars: 80 });
  });

  it('accepts direct execution without a model', () => {
    writeConfig(projectDir, {
      tiers: {
        COMPLEX: { mode: 'direct' },
      },
    });

    expect(loadConfig(projectDir).tiers.COMPLEX).toEqual({ mode: 'direct' });
  });

  it('ignores a delegate tier without a model and fails open to the previous valid execution', () => {
    writeConfig(projectDir, {
      tiers: {
        EXTREME: { mode: 'delegate' },
      },
    });

    expect(loadConfig(projectDir).tiers.EXTREME).toEqual({ mode: 'delegate', model: 'fable' });
  });

  it('ignores an invalid execution mode', () => {
    writeConfig(projectDir, {
      tiers: {
        STANDARD: { mode: 'remote', model: 'unknown' },
      },
    });

    expect(loadConfig(projectDir).tiers.STANDARD).toEqual({ mode: 'delegate', model: 'sonnet' });
  });

  it('ignores an invalid fallback tier', () => {
    writeConfig(projectDir, { fallback_tier: 'HIGH' });

    expect(loadConfig(projectDir).fallback_tier).toBe('STANDARD');
  });

  it('uses the default timeout when a standalone invalid timeout is supplied', () => {
    writeConfig(projectDir, { classifier: { timeout_ms: -1 } });

    expect(loadConfig(projectDir).classifier.timeout_ms).toBe(3000);
  });

  it('supports configurable manual overrides', () => {
    writeConfig(projectDir, {
      overrides: {
        '//architect': 'EXTREME',
      },
    });

    const config = loadConfig(projectDir);

    expect(config.overrides['//architect']).toBe('EXTREME');
    expect(config.overrides['//trivial']).toBe('SIMPLE');
  });

  it('ignores malformed JSON and non-object configuration roots', () => {
    writeFileSync(path.join(homeDir, '.claude-router.json'), '{invalid', 'utf-8');
    writeFileSync(path.join(projectDir, '.claude-router.json'), '[]', 'utf-8');

    expect(loadConfig(projectDir).tiers.STANDARD).toEqual({ mode: 'delegate', model: 'sonnet' });
  });

  it('migrates a legacy TRIVIAL tier key to SIMPLE without shifting other tier names', () => {
    writeConfig(projectDir, {
      tiers: {
        TRIVIAL: { mode: 'delegate', model: 'legacy-fast' },
      },
    });

    const config = loadConfig(projectDir);

    expect(config.tiers.SIMPLE).toEqual({ mode: 'delegate', model: 'legacy-fast' });
    expect(config.tiers.STANDARD).toEqual({ mode: 'delegate', model: 'sonnet' });
    expect(config.tiers.COMPLEX).toEqual({ mode: 'delegate', model: 'opus' });
    expect(config.tiers.EXTREME).toEqual({ mode: 'delegate', model: 'fable' });
  });

  it('lets an explicit new tier key override a migrated legacy tier entry', () => {
    writeConfig(projectDir, {
      tiers: {
        TRIVIAL: { mode: 'delegate', model: 'legacy-fast' },
        SIMPLE: { mode: 'delegate', model: 'fresh-simple' },
      },
    });

    expect(loadConfig(projectDir).tiers.SIMPLE).toEqual({ mode: 'delegate', model: 'fresh-simple' });
  });

  it('migrates legacy TRIVIAL in fallback_tier and overrides to SIMPLE', () => {
    writeConfig(projectDir, {
      fallback_tier: 'TRIVIAL',
      overrides: {
        '//quick': 'TRIVIAL',
      },
    });

    const config = loadConfig(projectDir);

    expect(config.fallback_tier).toBe('SIMPLE');
    expect(config.overrides['//quick']).toBe('SIMPLE');
  });

  it('treats SIMPLE/STANDARD/COMPLEX/EXTREME keys under the current four-tier semantics', () => {
    writeConfig(projectDir, {
      tiers: {
        SIMPLE: { mode: 'direct' },
        STANDARD: { mode: 'delegate', model: 'new-standard' },
        COMPLEX: { mode: 'delegate', model: 'new-complex' },
        EXTREME: { mode: 'direct' },
      },
    });

    const config = loadConfig(projectDir);

    expect(config.tiers.SIMPLE).toEqual({ mode: 'direct' });
    expect(config.tiers.STANDARD).toEqual({ mode: 'delegate', model: 'new-standard' });
    expect(config.tiers.COMPLEX).toEqual({ mode: 'delegate', model: 'new-complex' });
    expect(config.tiers.EXTREME).toEqual({ mode: 'direct' });
  });
});
