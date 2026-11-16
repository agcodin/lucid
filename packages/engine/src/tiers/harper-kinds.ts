import type { Category } from '../types.js';

/**
 * Harper's 21 lint kinds folded into the four categories users recognize.
 *
 * Correctness takes anything a reader would call an error. Clarity takes
 * readability and redundancy. Engagement takes word choice. Delivery takes the
 * kinds that change how a sentence lands rather than whether it is right.
 */
const KIND_TO_CATEGORY: Record<string, Category> = {
  Agreement: 'correctness',
  BoundaryError: 'correctness',
  Capitalization: 'correctness',
  Eggcorn: 'correctness',
  Grammar: 'correctness',
  Malapropism: 'correctness',
  Punctuation: 'correctness',
  Spelling: 'correctness',
  Typo: 'correctness',
  Usage: 'correctness',
  Nonstandard: 'correctness',
  WordOrder: 'correctness',

  Readability: 'clarity',
  Redundancy: 'clarity',
  Repetition: 'clarity',

  WordChoice: 'engagement',
  Enhancement: 'engagement',

  Style: 'delivery',
  Formatting: 'delivery',
  Regionalism: 'delivery',
  Miscellaneous: 'delivery',
};

/**
 * A Map, so a lint kind that happens to name an Object.prototype property
 * cannot resolve to an inherited value instead of falling back.
 */
export const CATEGORY_OF_LINT_KIND = new Map<string, Category>(
  Object.entries(KIND_TO_CATEGORY) as [string, Category][],
);

export function categoryOfLintKind(kind: string): Category {
  return CATEGORY_OF_LINT_KIND.get(kind) ?? 'correctness';
}
