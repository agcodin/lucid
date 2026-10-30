import { tokenize, type Token } from '../segment.js';
import { ALL_PHRASES, type PhraseRule } from './phrases.js';

interface IndexedRule extends PhraseRule {
  /** `from` split into lowercased words, precomputed at module load. */
  words: string[];
}

/**
 * Phrase rules bucketed by their first word. Matching then costs one map
 * lookup per token in the sentence rather than a scan over every rule.
 */
const INDEX: Map<string, IndexedRule[]> = (() => {
  const index = new Map<string, IndexedRule[]>();
  for (const rule of ALL_PHRASES) {
    const words = rule.from.split(/\s+/);
    const head = words[0]!;
    const bucket = index.get(head);
    const entry: IndexedRule = { ...rule, words };
    if (bucket) bucket.push(entry);
    else index.set(head, [entry]);
  }
  // Longest phrase first, so "at the end of the day" wins over "the".
  for (const bucket of index.values()) bucket.sort((a, b) => b.words.length - a.words.length);
  return index;
})();

export interface PhraseMatch {
  rule: IndexedRule;
  /** Offsets into the text passed to `matchPhrases`. */
  start: number;
  end: number;
  text: string;
}

/**
 * Find every phrase rule that fires in `text`, leftmost-longest, without
 * overlaps. Tokens are passed in when the caller already has them.
 */
export function matchPhrases(text: string, tokens: Token[] = tokenize(text)): PhraseMatch[] {
  const matches: PhraseMatch[] = [];
  let i = 0;

  while (i < tokens.length) {
    const bucket = INDEX.get(tokens[i]!.lower);
    if (!bucket) {
      i++;
      continue;
    }

    let hit: PhraseMatch | undefined;
    for (const rule of bucket) {
      if (i + rule.words.length > tokens.length) continue;
      let ok = true;
      for (let w = 1; w < rule.words.length; w++) {
        if (tokens[i + w]!.lower !== rule.words[w]) { ok = false; break; }
      }
      if (!ok) continue;
      const start = tokens[i]!.start;
      const end = tokens[i + rule.words.length - 1]!.end;
      hit = { rule, start, end, text: text.slice(start, end) };
      break; // Bucket is sorted longest-first, so this is the longest match.
    }

    if (hit) {
      matches.push(hit);
      i += hit.rule.words.length;
    } else {
      i++;
    }
  }

  return matches;
}

/** Number of loaded phrase rules. Reported in the engine's stats panel. */
export const PHRASE_RULE_COUNT = ALL_PHRASES.length;
