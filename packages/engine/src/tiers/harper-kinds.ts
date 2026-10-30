import type { Category } from '../types.js';

/**
 * Harper's 21 lint kinds folded into the four categories users recognize.
 *
 * Correctness takes anything a reader would call an error. Clarity takes
 * readability and redundancy. Engagement takes word choice. Delivery takes the
 * kinds that change how a sentence lands rather than whether it is right.
 */
export const CATEGORY_OF_LINT_KIND: Record<string, Category> = {
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

export function categoryOfLintKind(kind: string): Category {
  return CATEGORY_OF_LINT_KIND[kind] ?? 'correctness';
}
