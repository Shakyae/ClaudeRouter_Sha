import type { Tier } from '../types';

const FOLLOW_UP_PATTERN =
  /^(?:yes|no|y|n|ok|okay|sure|go ahead|do it|proceed|continue|confirmed|sounds good|looks good|lgtm|按这个方案继续|照刚才的做)[。.!！]?$/i;

const TRIVIAL_PATTERNS = [
  /^(?:find|search for|where is|locate)\b/i,
  /^(?:list files?|show files?)\b/i,
  /^(?:rename|fix (?:a )?typo|format)\b/i,
  /^(?:explain|what does|what is)\b/i,
];

const COMPLEX_PATTERNS = [
  /\bcross[- ]module\b.*\b(?:race condition|deadlock|concurrency)\b/i,
  /\b(?:race condition|deadlock)\b.*\bcross[- ]module\b/i,
];

const EXTREME_PATTERNS = [
  /\bredesign (?:the )?(?:entire|whole) (?:system|architecture)\b/i,
  /\bsystem[- ]wide architecture\b/i,
  /\b(?:entire|whole) (?:repository|codebase)\b.*\b(?:analysis|migration|refactor)\b/i,
  /\bsecurity architecture\b/i,
];

export function quickClassify(prompt: string): Tier | null {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return 'STANDARD';
  }

  // Follow-ups rely on the main conversation and must stay with it.
  if (FOLLOW_UP_PATTERN.test(trimmed)) {
    return 'STANDARD';
  }

  for (const pattern of EXTREME_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'EXTREME';
    }
  }

  for (const pattern of COMPLEX_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'COMPLEX';
    }
  }

  // Long prompts are not inherently difficult, so let the classifier decide.
  if (trimmed.split(/\s+/).filter(Boolean).length > 100) {
    return null;
  }

  for (const pattern of TRIVIAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'TRIVIAL';
    }
  }

  // Ambiguous verbs and prompt length deliberately fall through to the classifier.
  return null;
}
