/**
 * Suggestion categories, mirroring the four buckets users already understand
 * from Grammarly. Harper's 21 lint kinds are folded into these by `CATEGORY_OF_LINT_KIND`.
 */
export type Category = 'correctness' | 'clarity' | 'engagement' | 'delivery';

/** Which tier produced an issue. Used for staged rendering and for metrics. */
export type Tier = 'rules' | 'harper' | 'analysis' | 'remote';

export interface Replacement {
  /** Text that replaces the issue span. Empty string means "delete the span". */
  text: string;
  /** Shown instead of `text` when the raw replacement reads badly in a chip (e.g. ""). */
  label?: string;
}

export interface Issue {
  /** Stable within a session; survives re-linting of an unchanged block. */
  id: string;
  category: Category;
  tier: Tier;
  /** Rule identity, e.g. `harper:ItsContraction` or `clarity:passive-voice`. */
  rule: string;
  /** Document-absolute character offsets, half-open: [start, end). */
  start: number;
  end: number;
  /** One short sentence, sentence case, no trailing period. */
  title: string;
  /** Optional longer explanation. May contain inline HTML from Harper. */
  detail?: string;
  replacements: Replacement[];
  /**
   * Context-stable hash used to remember dismissals across edits elsewhere in
   * the document. Absent for issues whose rule cannot produce one.
   */
  dismissHash?: string;
}

/** A paragraph-sized unit of text. The unit of caching and of incremental work. */
export interface Block {
  /** Document-absolute offset of this block's first character. */
  start: number;
  text: string;
  /** Content hash of `text`. Equal hashes mean cached issues are still valid. */
  hash: string;
}

export interface Readability {
  /** Flesch Reading Ease, 0-100. Higher is easier. */
  flesch: number;
  /** Flesch-Kincaid grade level. */
  grade: number;
  words: number;
  sentences: number;
  /** Words per sentence, averaged. */
  avgSentenceLength: number;
  /** Fraction of words with 3+ syllables. */
  complexWordRatio: number;
  /** Fraction of sentences in the passive voice. */
  passiveRatio: number;
  /** Estimated reading time in seconds at 238 wpm. */
  readingSeconds: number;
}

export type ToneLabel =
  | 'formal' | 'informal' | 'confident' | 'tentative' | 'friendly'
  | 'direct' | 'optimistic' | 'urgent' | 'analytical' | 'neutral';

export interface Tone {
  /** Strongest signals first, at most three. */
  labels: { label: ToneLabel; strength: number }[];
  /** 0 = very informal, 1 = very formal. */
  formality: number;
  /** 0 = hedged, 1 = assertive. */
  confidence: number;
}

export interface DocumentReport {
  readability: Readability;
  tone: Tone;
  /** Issue counts per category, for the sidebar badges. */
  counts: Record<Category, number>;
  /** 0-100, weighted by issue density against document length. */
  score: number;
}
