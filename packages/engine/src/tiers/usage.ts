import type { Token } from '../segment.js';
import type { PatternHit } from './patterns.js';

/**
 * Word-choice confusions that spelling cannot catch, because both spellings are
 * real words. Harper does not cover these, and they were missed outright by the
 * recall harness.
 *
 * Each rule is gated on the construction rather than the word, because both
 * members of every pair here are correct somewhere. Where a pair cannot be
 * told apart without parsing the sentence, it is left out rather than guessed.
 */

/** Words before "principal" that mark it as the noun "principle". */
const PRINCIPLE_CUES = new Set([
  'basic', 'guiding', 'core', 'fundamental', 'general', 'moral', 'first',
  'key', 'same', 'these', 'those', 'underlying', 'governing', 'design',
]);
// Determiners are deliberately absent. Adding "the" caught "the principal of
// uptake" but also flagged "she is the principal of the school", and the two
// cannot be told apart without knowing what the "of" phrase names.

/** Nouns after "principle" that mark it as the adjective "principal". */
const PRINCIPAL_NOUNS = new Set([
  'investigator', 'engineer', 'architect', 'reason', 'reasons', 'cause',
  'causes', 'component', 'components', 'amount', 'goal', 'goals', 'aim',
  'concern', 'concerns', 'objective', 'objectives', 'source', 'sources',
  'factor', 'factors', 'advantage', 'advantages', 'difference', 'differences',
]);

/** Perfect auxiliaries, after which "lead" has to be the past participle "led". */
const PERFECT_AUXILIARIES = new Set(['has', 'have', 'had', 'having']);

/** Determiners before "passed" that mark it as the noun or adjective "past". */
const PAST_DETERMINERS = new Set(['the', 'this', 'in', 'over', 'during', 'from']);

/**
 * Nouns that "passed" can genuinely modify, as in "a passed ball". Everywhere
 * else a determiner before "passed" means the noun "past" was meant.
 */
const PASSED_NOUNS = new Set(['ball', 'balls', 'pawn', 'pawns', 'exam', 'exams', 'test', 'tests']);

/**
 * Acronyms whose last letter already says the following word.
 * Keyed by the acronym, valued by the word that repeats it.
 */
const REDUNDANT_ACRONYMS = new Map<string, string>([
  ['url', 'address'], ['pin', 'number'], ['atm', 'machine'], ['lcd', 'display'],
  ['led', 'display'], ['hiv', 'virus'], ['ram', 'memory'], ['rom', 'memory'],
  ['isbn', 'number'], ['gps', 'system'], ['cpu', 'unit'], ['nic', 'card'],
  ['dc', 'current'], ['ac', 'current'], ['vin', 'number'], ['sat', 'test'],
  ['gui', 'interface'], ['api', 'interface'], ['rpc', 'call'], ['ssn', 'number'],
]);

/**
 * Countable plurals that take "fewer" rather than "less". A list, because
 * telling a countable plural from a mass noun by its spelling fails on
 * "progress", "stress" and "access".
 */
const COUNTABLE_PLURALS = new Set([
  'items', 'people', 'things', 'words', 'files', 'users', 'requests', 'errors',
  'options', 'steps', 'lines', 'pages', 'characters', 'elements', 'nodes',
  'calls', 'ways', 'places', 'cases', 'examples', 'problems', 'issues',
  'changes', 'results', 'values', 'numbers', 'resources', 'devices',
  'browsers', 'versions', 'features', 'tests', 'bugs', 'rows', 'columns',
  'entries', 'records', 'documents', 'messages', 'sentences', 'students',
  'customers', 'employees', 'members', 'countries', 'companies', 'products',
]);

export function matchUsage(tokens: Token[], hits: PatternHit[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const word = token.lower;
    const next = tokens[i + 1];
    const previous = tokens[i - 1];

    // "in principal" is always the idiom "in principle".
    if (word === 'principal' && previous?.lower === 'in') {
      flag(hits, token, 'Did you mean "principle"?', ['principle'], 'usage:principal-principle',
        'The idiom is "in principle", meaning in theory.');
      continue;
    }
    // "the principals of engineering" — the noun is "principle". The plural is
    // safe on its own, since a school has one principal; the singular needs a
    // cue, because "the principal of the school" is correct.
    if ((word === 'principals' && next?.lower === 'of')
      || (word === 'principal' && next?.lower === 'of'
        && previous !== undefined && PRINCIPLE_CUES.has(previous.lower))) {
      flag(hits, token, 'Did you mean "principle"?',
        [word === 'principals' ? 'principles' : 'principle'], 'usage:principal-principle',
        'A "principle" is a rule or belief. "Principal" means main, or the head of a school.');
      continue;
    }
    // "the principle reason" — used as an adjective, so it is "principal".
    if (word === 'principle' && next !== undefined && PRINCIPAL_NOUNS.has(next.lower)) {
      flag(hits, token, 'Did you mean "principal"?', ['principal'], 'usage:principle-principal',
        '"Principal" means main. "Principle" is a rule or belief, and is only ever a noun.');
      continue;
    }

    // "has lead to" — after a perfect auxiliary it is the participle "led".
    if (word === 'lead' && previous !== undefined && PERFECT_AUXILIARIES.has(previous.lower)) {
      flag(hits, token, 'Did you mean "led"?', ['led'], 'usage:lead-led',
        'The past tense of "lead" is "led". "Lead" is the present tense, or the metal.');
      continue;
    }

    // "in the passed few years" — a determiner before it means the noun "past".
    if (word === 'passed' && previous !== undefined && PAST_DETERMINERS.has(previous.lower)
      && (next === undefined || !PASSED_NOUNS.has(next.lower))) {
      flag(hits, token, 'Did you mean "past"?', ['past'], 'usage:passed-past',
        '"Passed" is the past tense of "pass". "Past" is the time before now.');
      continue;
    }

    // "the URL address" — the acronym already contains the word.
    const repeated = REDUNDANT_ACRONYMS.get(word);
    if (repeated !== undefined && next?.lower === repeated && token.text === token.text.toUpperCase()) {
      hits.push({
        category: 'clarity',
        rule: 'usage:redundant-acronym',
        start: token.start,
        end: next.end,
        title: `"${token.text}" already means "${repeated}"`,
        detail: `The last letter of ${token.text} stands for ${repeated}, so the word repeats it.`,
        replacements: [{ text: token.text }],
      });
      i++;
      continue;
    }

    // "less items" — a countable plural takes "fewer".
    //
    // Only a plural directly after it counts. Allowing an adjective between
    // them caught "less total bits" but also flagged "less developed
    // countries", where "less" modifies the adjective and is correct. One
    // false correctness flag is worse than one missed suggestion.
    if (word === 'less' && next !== undefined && COUNTABLE_PLURALS.has(next.lower)) {
      flag(hits, token, 'Did you mean "fewer"?', ['fewer'], 'usage:less-fewer',
        '"Fewer" counts separate things. "Less" is for quantities you do not count, like water or time.');
      continue;
    }

    // "irregardless" is not a standard word.
    if (word === 'irregardless') {
      flag(hits, token, '"Irregardless" is not standard', ['regardless'], 'usage:irregardless',
        'The standard word is "regardless".');
      continue;
    }

    // "compliments each other" — the one that completes is "complement".
    if ((word === 'compliment' || word === 'compliments')
      && next?.lower === 'each' && tokens[i + 2]?.lower === 'other') {
      flag(hits, token, 'Did you mean "complement"?',
        [word === 'compliments' ? 'complements' : 'complement'], 'usage:compliment-complement',
        'Things that go well together "complement" each other. A "compliment" is praise.');
    }
  }
}

function flag(hits: PatternHit[], token: Token, title: string, replacements: string[], rule: string, detail: string): void {
  hits.push({
    category: 'correctness',
    rule,
    start: token.start,
    end: token.end,
    title,
    detail,
    replacements: replacements.map((text) => ({ text: matchCase(token.text, text) })),
  });
}

/** Carry the original word's capitalization onto the replacement. */
function matchCase(original: string, replacement: string): string {
  if (original[0] === original[0]?.toUpperCase() && original[0] !== original[0]?.toLowerCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}
