import { toSentences, tokenize } from '../segment.js';
import { hash } from '../hash.js';
import type { Block, Issue } from '../types.js';
import { matchPhrases } from './matcher.js';
import { matchPatterns } from './patterns.js';

/**
 * Tier 0. Runs synchronously on the edited block on every keystroke, so it
 * must stay in the sub-millisecond range for a paragraph. Everything here is a
 * table lookup or a single linear pass over tokens.
 *
 * Offsets returned are document-absolute.
 */
export function runRules(block: Block): Issue[] {
  const issues: Issue[] = [];
  const sentences = toSentences(block.text);

  for (let s = 0; s < sentences.length; s++) {
    const sentence = sentences[s]!;
    const base = block.start + sentence.start;
    const tokens = tokenize(sentence.text);

    for (const match of matchPhrases(sentence.text, tokens)) {
      const replacements = match.rule.to.map((text) => ({
        text,
        label: text === '' ? 'Remove' : undefined,
      }));
      issues.push({
        id: `r:${block.hash}:${sentence.start + match.start}:${match.rule.rule}`,
        category: match.rule.category,
        tier: 'rules',
        rule: match.rule.rule,
        start: base + match.start,
        end: base + match.end,
        title: match.rule.title,
        detail: match.rule.detail,
        replacements,
        dismissHash: hash(`${match.rule.rule}|${match.text.toLowerCase()}`),
      });
    }

    for (const hit of matchPatterns(sentence, s, sentences)) {
      issues.push({
        id: `r:${block.hash}:${sentence.start + hit.start}:${hit.rule}`,
        category: hit.category,
        tier: 'rules',
        rule: hit.rule,
        start: base + hit.start,
        end: base + hit.end,
        title: hit.title,
        detail: hit.detail,
        replacements: hit.replacements ?? [],
        dismissHash: hash(`${hit.rule}|${sentence.text.slice(hit.start, hit.end).toLowerCase()}`),
      });
    }
  }

  return issues;
}
