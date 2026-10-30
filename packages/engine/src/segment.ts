import { hash } from './hash.js';
import type { Block } from './types.js';

/** Abbreviations that end in a period without ending a sentence. */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'rev', 'hon',
  'inc', 'ltd', 'co', 'corp', 'dept', 'est', 'approx', 'vs', 'etc', 'al',
  'eg', 'ie', 'cf', 'viz', 'ca', 'fig', 'vol', 'no', 'pp', 'ed',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
  'usa', 'us', 'uk', 'eu', 'phd', 'md', 'ba', 'ma', 'bs', 'ms',
]);

/**
 * Split text into paragraph blocks on blank lines, preserving absolute offsets.
 *
 * Blocks are the unit of caching: editing one paragraph of a 20k-character
 * document re-lints that paragraph only, which is the difference between ~1ms
 * and ~53ms per keystroke.
 */
export function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const separator = /\n[ \t]*\n/g;
  let cursor = 0;

  for (let m = separator.exec(text); m !== null; m = separator.exec(text)) {
    pushBlock(blocks, text.slice(cursor, m.index), cursor);
    cursor = m.index + m[0].length;
  }
  pushBlock(blocks, text.slice(cursor), cursor);

  return blocks;
}

function pushBlock(blocks: Block[], raw: string, offset: number): void {
  // Trim without losing the offset: advance `start` past the leading whitespace.
  const leading = raw.length - raw.trimStart().length;
  const body = raw.trim();
  if (body.length === 0) return;
  blocks.push({ start: offset + leading, text: body, hash: hash(body) });
}

export interface Sentence {
  /** Offset relative to the text passed to `toSentences`. */
  start: number;
  end: number;
  text: string;
}

/**
 * Split text into sentences. Deliberately a heuristic rather than a model:
 * every clarity and engagement rule runs per sentence on every keystroke, so
 * this has to cost nothing.
 */
export function toSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    // Run past grouped terminators and any closing quote or bracket.
    let end = i + 1;
    while (end < text.length && '.!?"”\')]'.includes(text[end]!)) end++;

    // A terminator needs whitespace or end-of-text after it to close a sentence.
    if (end < text.length && !/\s/.test(text[end]!)) continue;
    if (ch === '.' && !closesSentence(text, i)) continue;

    const body = text.slice(start, end);
    if (body.trim().length > 0) {
      const leading = body.length - body.trimStart().length;
      out.push({ start: start + leading, end, text: body.trim() });
    }
    start = end;
    i = end - 1;
  }

  const tail = text.slice(start);
  if (tail.trim().length > 0) {
    const leading = tail.length - tail.trimStart().length;
    out.push({ start: start + leading, end: text.length, text: tail.trim() });
  }
  return out;
}

/** Decide whether the period at `dot` ends a sentence or belongs to a token. */
function closesSentence(text: string, dot: number): boolean {
  // Walk back over the word attached to the period.
  let wordStart = dot;
  while (wordStart > 0 && /[A-Za-z]/.test(text[wordStart - 1]!)) wordStart--;
  const word = text.slice(wordStart, dot).toLowerCase();

  if (word.length > 0 && ABBREVIATIONS.has(word)) return false;
  // Single letters are initials ("J. Smith") or acronyms spelled with periods.
  if (word.length === 1) return false;
  // Decimals: a digit on each side.
  if (dot > 0 && /\d/.test(text[dot - 1]!) && /\d/.test(text[dot + 1] ?? '')) return false;
  return true;
}

/** Words of a sentence with offsets relative to that sentence. */
export interface Token {
  start: number;
  end: number;
  text: string;
  lower: string;
}

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  // Letters, digits, and internal apostrophes or hyphens ("don't", "well-known").
  const word = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;
  for (let m = word.exec(text); m !== null; m = word.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0], lower: m[0].toLowerCase() });
  }
  return out;
}
