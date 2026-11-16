import { toSentences, tokenize } from '../segment.js';
import type { Readability } from '../types.js';

/**
 * Syllable count by vowel groups, with the corrections that matter most for
 * Flesch scores.
 *
 * Vowel runs are matched greedily. Capping them at two characters splits
 * "beautiful" into ea-u-i-u and then a separate triphthong correction added
 * another, giving 5 for a three-syllable word. Greedy runs read "eau" as the
 * one glide it is.
 *
 * Exact syllabification needs a pronunciation dictionary. The residual error
 * here is a fraction of a grade level and costs nothing to compute.
 */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;

  // Silent trailing -e, -es and -ed, but never the "-le" of "table", where the
  // e carries its own syllable.
  const body = w
    .replace(/(?:[^laeiouy]es|[^aeiouy]ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '');

  const groups = body.match(/[aeiouy]+/g);
  let count = groups ? groups.length : 1;

  // Vowel pairs pronounced as two syllables rather than one glide, as in
  // "media", "violet" and "duo". The "-tion"/"-sion" ending is excluded, since
  // it is one syllable, and "eo" is excluded because "people" and "leopard"
  // outnumber the hiatus cases.
  count += (w.match(/[^aeiouy](?:ia|io|ua|uo)/g) ?? []).length;
  count -= (w.match(/[tsc]io[nu]/g) ?? []).length;
  // "area", "idea", "create": an "ea" ending a stem is two syllables. Tested on
  // the stem, so a stripped silent e ("create" -> "crea") still counts.
  if (/[^aeiouy]ea$/.test(body)) count++;

  return Math.max(1, count);
}

const BE_VERBS = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'being', 'am']);

export function analyzeReadability(text: string): Readability {
  const sentences = toSentences(text);
  const allTokens = tokenize(text);
  const words = allTokens.length;

  if (words === 0 || sentences.length === 0) {
    return {
      flesch: 100, grade: 0, words: 0, sentences: 0,
      avgSentenceLength: 0, complexWordRatio: 0, passiveRatio: 0, readingSeconds: 0,
    };
  }

  let totalSyllables = 0;
  let complex = 0;
  for (const token of allTokens) {
    const n = syllables(token.text);
    totalSyllables += n;
    if (n >= 3) complex++;
  }

  let passive = 0;
  for (const sentence of sentences) {
    const tokens = tokenize(sentence.text);
    for (let i = 0; i < tokens.length - 1; i++) {
      if (!BE_VERBS.has(tokens[i]!.lower)) continue;
      let j = i + 1;
      if (tokens[j]!.lower.endsWith('ly')) j++;
      const next = tokens[j];
      if (next && (next.lower.endsWith('ed') || next.lower.endsWith('en'))) { passive++; break; }
    }
  }

  const wordsPerSentence = words / sentences.length;
  const syllablesPerWord = totalSyllables / words;

  // Flesch Reading Ease and Flesch-Kincaid grade level, the standard forms.
  const flesch = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
  const grade = 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59;

  return {
    flesch: clamp(round(flesch, 1), 0, 100),
    grade: Math.max(0, round(grade, 1)),
    words,
    sentences: sentences.length,
    avgSentenceLength: round(wordsPerSentence, 1),
    complexWordRatio: round(complex / words, 3),
    passiveRatio: round(passive / sentences.length, 3),
    // 238 wpm is the mean silent reading rate for English prose (Brysbaert 2019).
    readingSeconds: Math.round((words / 238) * 60),
  };
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
