import { describe, expect, it } from 'vitest';
import { quickClassify } from '../src/classifier/signals';

describe('quickClassify', () => {
  it.each([
    ['find calculatePrice', 'TRIVIAL'],
    ['where is the router defined', 'TRIVIAL'],
    ['list files in src', 'TRIVIAL'],
    ['fix typo', 'TRIVIAL'],
    ['rename the variable', 'TRIVIAL'],
    ['format this file', 'TRIVIAL'],
  ] as const)('classifies %s as %s', (prompt, tier) => {
    expect(quickClassify(prompt)).toBe(tier);
  });

  it.each(['yes', 'ok', 'do it', 'continue', '按这个方案继续', '照刚才的做'])(
    'keeps follow-up %s at STANDARD',
    (prompt) => {
      expect(quickClassify(prompt)).toBe('STANDARD');
    },
  );

  it('does not infer difficulty from prompt length', () => {
    expect(quickClassify(Array(1000).fill('format the generated output').join(' '))).toBeNull();
  });

  it('defers broad implementation verbs to the classifier', () => {
    expect(quickClassify('implement a new authentication system')).toBeNull();
    expect(quickClassify('debug the failing integration')).toBeNull();
    expect(quickClassify('refactor this module')).toBeNull();
  });

  it('identifies high-confidence concurrency and architecture tasks', () => {
    expect(quickClassify('investigate a cross-module race condition')).toBe('COMPLEX');
    expect(quickClassify('redesign the entire architecture')).toBe('EXTREME');
  });

  it('uses STANDARD for an empty prompt instead of treating it as trivial', () => {
    expect(quickClassify('')).toBe('STANDARD');
  });
});
