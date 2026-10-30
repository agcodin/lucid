export { Lucid, applyReplacement } from './scheduler.js';
export type { EngineState, EngineStats, LucidOptions } from './scheduler.js';

export { toBlocks, toSentences, tokenize } from './segment.js';
export type { Sentence, Token } from './segment.js';
export { hash } from './hash.js';

export { runRules } from './tiers/rules.js';
export { analyzeReadability, syllables } from './tiers/readability.js';
export { analyzeTone } from './tiers/tone.js';
export { matchPhrases, PHRASE_RULE_COUNT } from './tiers/matcher.js';
export { ALL_PHRASES, WORDY, FILLER, HEDGES, CLICHES } from './tiers/phrases.js';
export { CATEGORY_OF_LINT_KIND, categoryOfLintKind } from './tiers/harper-kinds.js';

export type { RemoteProvider, TransformKind, TransformRequest, TransformVariant } from './providers/types.js';

export type {
  Block, Category, DocumentReport, Issue, Readability, Replacement, Tier, Tone, ToneLabel,
} from './types.js';
export type { FromWorker, ToWorker, BlockRequest, Source } from './worker/protocol.js';
