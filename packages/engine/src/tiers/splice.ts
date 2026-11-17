import type { Token } from '../segment.js';
import type { PatternHit } from './patterns.js';

/**
 * Comma splices: two independent clauses joined by a comma alone.
 *
 * This was the one correctness rule the recall harness found detection for
 * without a usable fix, because choosing between a period, a semicolon and a
 * conjunction needs to know that both halves stand on their own. Deciding that
 * from the words alone is what makes the rule dangerous, so every gate below
 * exists because a looser version of it flagged a correct sentence somewhere
 * in the corpus. The rule gives up recall to keep the false positive count at
 * zero, which is the trade the rest of the correctness tier already makes.
 */

/**
 * Auxiliaries and modals. The clause after the comma has to be built on one of
 * these. An ordinary verb was allowed at first, and it read appositives as
 * clauses, because an English past participle looks exactly like a past tense:
 * "binding to the ring, a structure found on the molecule" is one noun phrase,
 * not two sentences.
 */
const AUXILIARY = new Set([
  'is', 'are', 'was', 'were', 'am', 'be', "isn't", "aren't", "wasn't", "weren't",
  'has', 'have', 'had', "hasn't", "haven't", "hadn't",
  'does', 'do', 'did', "doesn't", "don't", "didn't",
  'will', 'would', 'can', 'could', 'shall', 'should', 'may', 'might', 'must',
  "won't", "wouldn't", 'cannot', "can't", "couldn't", "shouldn't", "mustn't",
  "'s", "'re", "'ve", "'ll", "'d", "'m",
]);

/** Ordinary verbs, enough to call the half before the comma a clause. */
const PLAIN_VERBS = new Set([
  'seems', 'seem', 'gets', 'get', 'goes', 'go', 'makes', 'make', 'needs', 'need',
  'means', 'mean', 'comes', 'come', 'takes', 'take', 'gives', 'give', 'says', 'say',
  'went', 'made', 'took', 'gave', 'said', 'came', 'got', 'knew', 'saw', 'ran',
  'wrote', 'found', 'left', 'kept', 'told', 'felt', 'thought', 'began', 'brought',
]);

/**
 * Frequent present-tense verbs. A word ending in -s is otherwise ambiguous
 * between a verb and a plural noun, and guessing wrong made the noun phrase
 * "the build tests" look like a clause.
 */
const PRESENT_S = new Set([
  'resembles', 'contains', 'includes', 'provides', 'requires', 'uses', 'allows',
  'shows', 'holds', 'carries', 'covers', 'describes', 'defines', 'returns',
  'means', 'refers', 'remains', 'consists', 'depends', 'applies', 'produces',
  'creates', 'causes', 'affects', 'reduces', 'supports', 'expects', 'prevents',
  'exists', 'occurs', 'appears', 'happens', 'works', 'runs', 'sits', 'stands',
]);

/**
 * Irregular past participles, which open a phrase rather than a sentence:
 * "Told in letters, it is as neatly plotted as a play". The regular ones are
 * caught by their -ed ending.
 */
const PARTICIPLE_OPENERS = new Set([
  'told', 'given', 'made', 'known', 'seen', 'taken', 'built', 'found', 'held',
  'left', 'kept', 'set', 'put', 'used', 'written', 'drawn', 'grown', 'sent',
  'begun', 'brought', 'built', 'driven', 'spoken', 'born',
]);

/**
 * Words ending in -ed or -en that are not verbs. "Often" is the one that
 * mattered: it made "Often, you will want to use this" look like two clauses.
 */
const NOT_VERBS = new Set([
  'often', 'even', 'seven', 'eleven', 'green', 'golden', 'sudden', 'wooden',
  'open', 'token', 'oxygen', 'garden', 'citizen', 'dozen', 'children', 'women',
  'hundred', 'thousand', 'sacred', 'naked', 'wicked', 'indeed', 'embed',
]);

/** Pronouns that can be a clause's whole subject. */
const SUBJECTS = new Set([
  'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'this', 'that', 'these', 'those', 'there',
]);

/** Determiners that can open a clause's subject noun phrase. */
const DETERMINERS = new Set([
  'the', 'a', 'an', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'each', 'every', 'both', 'all', 'some', 'most', 'no', 'one', 'two',
]);

/** Relative pronouns, which turn the noun phrase they follow into one phrase. */
const RELATIVE = new Set(['that', 'which', 'who', 'whom', 'whose']);

/**
 * Subordinators, scanned anywhere between the start of the clause and the
 * comma. One of these means the comma most likely closes a subordinate clause
 * rather than splicing two sentences, as in "when adult corals are exposed to
 * stressors, the zooxanthellae gain a mutation".
 */
const SUBORDINATORS = new Set([
  'after', 'although', 'as', 'because', 'before', 'if', 'once', 'since',
  'than', 'that', 'though', 'unless', 'until', 'when', 'whenever', 'where',
  'whereas', 'wherever', 'whether', 'while', 'whilst', 'why', 'which', 'who',
  'whom', 'whose',
]);

/**
 * Words that cannot open a sentence on their own. These are checked only at
 * the start of the clause, because a preposition in the middle of one is
 * ordinary ("the report on the outage was late") while a preposition at the
 * front of it makes the whole half a phrase ("In the report he wrote, the data
 * was wrong").
 */
const WEAK_OPENERS = new Set([
  'in', 'on', 'at', 'by', 'for', 'from', 'with', 'within', 'without',
  'during', 'despite', 'upon', 'among', 'between', 'through', 'under',
  'over', 'about', 'against', 'toward', 'towards', 'into', 'onto', 'like',
  'and', 'but', 'or', 'nor', 'to', 'of', 'not',
  'given', 'assuming', 'provided', 'supposing', 'considering',
]);

/**
 * Adverbs that join two sentences and take a comma after themselves. The comma
 * belongs to the adverb, so the sentence before it has already ended, usually
 * at a semicolon or a dash.
 */
const CONJUNCTIVE = new Set([
  'however', 'therefore', 'thus', 'hence', 'instead', 'moreover', 'furthermore',
  'nevertheless', 'nonetheless', 'meanwhile', 'otherwise', 'besides', 'indeed',
  'accordingly', 'consequently', 'similarly', 'conversely', 'finally', 'then',
  'also', 'so', 'still', 'yet', 'anyway', 'first', 'second', 'third',
]);

/** Comparatives after "the", which mark the correlative "the more X, the less Y". */
function isComparative(word: string): boolean {
  if (word === 'more' || word === 'less' || word === 'fewer') return true;
  if (word === 'better' || word === 'worse' || word === 'later' || word === 'sooner') return true;
  return word.length > 4 && word.endsWith('er');
}

/**
 * Whether a finite clause starts at `from`: a pronoun subject or a short
 * determiner phrase, then an auxiliary. The noun phrase gets one adjective, so
 * "the last build was late" matches, but nothing longer, because a longer one
 * is usually a subject carrying a relative clause.
 */
function opensClause(tokens: Token[], from: number, limit: number): boolean {
  const head = tokens[from];
  if (!head) return false;
  const aux = (at: number) => at < limit && AUXILIARY.has(tokens[at]?.lower ?? '');
  if (SUBJECTS.has(head.lower)) return aux(from + 1);
  if (!DETERMINERS.has(head.lower)) return false;
  const noun = tokens[from + 1];
  if (!noun || isComparative(noun.lower)) return false;
  if (aux(from + 2)) return true;
  if (RELATIVE.has(tokens[from + 2]?.lower ?? '')) return false;
  return aux(from + 3);
}

/**
 * Whether the half before the comma is a sentence: a finite verb somewhere in
 * it, and nothing that makes it dependent. The subject here can carry a
 * relative clause of its own, so the verb is looked for anywhere rather than
 * right after the subject.
 *
 * A bare -s word counts as a verb only directly after a pronoun, so "it works"
 * is a clause while the noun phrase "the build tests" is not.
 */
function closesClause(tokens: Token[], from: number, end: number): boolean {
  let verb = false;
  for (let i = from; i < end; i++) {
    const w = tokens[i]!.lower;
    if (SUBORDINATORS.has(w) || WEAK_OPENERS.has(w)) return false;
    if (AUXILIARY.has(w) || PLAIN_VERBS.has(w)) verb = true;
    else if (w.length > 4 && !NOT_VERBS.has(w) && (w.endsWith('ed') || w.endsWith('en'))) verb = true;
    else if (PRESENT_S.has(w)) verb = true;
    else if (w.endsWith('s') && i > from && SUBJECTS.has(tokens[i - 1]!.lower)) verb = true;
    else if (w.endsWith('s') && i > from && tokens[i - 1]!.lower.endsWith('ly')) verb = true;
  }
  return verb;
}

export function matchSplices(text: string, tokens: Token[], hits: PatternHit[]): void {
  for (let after = 1; after < tokens.length; after++) {
    const gap = text.slice(tokens[after - 1]!.end, tokens[after]!.start);
    // The comma has to be a plain word-to-word join rather than part of a
    // quotation, a number or a bracket.
    if (gap !== ', ') continue;
    if (test(text, tokens, after, hits)) return;
  }
}

/** Test the comma that falls between `after - 1` and `after`. */
function test(text: string, tokens: Token[], after: number, hits: PatternHit[]): boolean {
  // A semicolon, colon, dash or earlier comma ends the clause before it, so
  // the half under test starts after the last one rather than at the start of
  // the sentence. A bracket is deliberately not in that set, because "(s = 3)"
  // sits inside a clause rather than closing it.
  let clause = 0;
  for (let i = 1; i < after; i++) {
    const gap = text.slice(tokens[i - 1]!.end, tokens[i]!.start);
    // ", " and not "," alone, so the comma inside "7,300" does not read as a
    // clause break and leave the subordinator behind it unseen.
    if (gap === ', ' || /[;:—–]/.test(gap)) clause = i;
  }

  // The subject's verb has to arrive before any later comma. Without that,
  // "The report, a long one, was late" reads as a clause, because the noun
  // phrase runs on past the second comma to reach the verb.
  let limit = tokens.length;
  for (let i = after + 1; i < tokens.length; i++) {
    if (text.slice(tokens[i - 1]!.end, tokens[i]!.start).includes(',')) { limit = i; break; }
  }

  const first = tokens[clause];
  // A participle opening makes the first half a phrase however many verbs it
  // holds: "Dying when the empire was at peace, he was succeeded by Anastasius".
  if (!first || first.lower.endsWith('ing') || first.lower.endsWith('ed')) return false;
  if (WEAK_OPENERS.has(first.lower) || PARTICIPLE_OPENERS.has(first.lower)) return false;
  // An auxiliary in front is an inverted conditional or a question, not a
  // subject: "Had Austen sold it on commission, she would have made a profit".
  if (AUXILIARY.has(first.lower)) return false;
  if (CONJUNCTIVE.has(tokens[after - 1]!.lower)) return false;
  // The first half has to start the sentence and be short enough to read as a
  // whole clause on its own. A splice buried after a colon or an earlier comma
  // was a false positive every time it appeared in the corpus, because what
  // looked like the end of a sentence was the end of a phrase inside one.
  if (clause !== 0 || after > 9) return false;
  if (!closesClause(tokens, clause, after)) return false;
  if (!opensClause(tokens, after, limit)) return false;
  // "..., all of which are volcanic" is a relative clause, not a sentence.
  if (tokens[after + 1]?.lower === 'of') return false;
  // Both halves need enough past the verb to stand alone.
  if (tokens.length - after < 3) return false;

  const subject = tokens[after]!;
  const capitalized = subject.text[0]!.toUpperCase() + subject.text.slice(1);
  hits.push({
    category: 'correctness',
    rule: 'correctness:comma-splice',
    start: subject.start - 2,
    end: subject.end,
    title: 'Comma splice',
    detail: 'A comma cannot join two sentences on its own. Use a period, a semicolon, or add a conjunction after it.',
    replacements: [
      { text: `. ${capitalized}`, label: 'Split in two' },
      { text: `; ${subject.text}`, label: 'Semicolon' },
      { text: `, and ${subject.text}`, label: 'Add "and"' },
    ],
  });
  return true;
}
