import { tokenize, type Sentence, type Token } from '../segment.js';
import { matchConfusions } from './confusions.js';
import type { Category } from '../types.js';

export interface PatternHit {
  category: Category;
  rule: string;
  /** Offsets relative to the sentence. */
  start: number;
  end: number;
  title: string;
  detail?: string;
  replacements?: { text: string; label?: string }[];
}

const BE_VERBS = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', "isn't", "aren't", "wasn't", "weren't"]);

/** Irregular past participles that do not end in -ed. */
const IRREGULAR_PARTICIPLES = new Set([
  'arisen', 'awoken', 'beaten', 'become', 'begun', 'bent', 'bitten', 'blown', 'broken',
  'brought', 'built', 'bought', 'caught', 'chosen', 'come', 'cost', 'cut', 'dealt',
  'done', 'drawn', 'driven', 'drunk', 'eaten', 'fallen', 'felt', 'fought', 'found',
  'flown', 'forgotten', 'forgiven', 'frozen', 'given', 'gone', 'grown', 'hung', 'heard',
  'hidden', 'hit', 'held', 'hurt', 'kept', 'known', 'laid', 'led', 'left', 'lent',
  'let', 'lost', 'made', 'meant', 'met', 'paid', 'put', 'read', 'ridden', 'rung',
  'risen', 'run', 'said', 'seen', 'sold', 'sent', 'set', 'shaken', 'shot', 'shown',
  'shut', 'sung', 'sunk', 'sat', 'slept', 'spoken', 'spent', 'stood', 'stolen',
  'struck', 'sworn', 'taken', 'taught', 'torn', 'told', 'thought', 'thrown',
  'understood', 'woken', 'worn', 'won', 'written', 'withheld', 'overseen',
]);

/**
 * Participles that form a fixed description rather than a hidden action.
 * "X is known as Y", "is based on", "is located in" are not passives a writer
 * should rewrite, and together they were ~8% of all passive flags on edited
 * prose.
 */
const STATIVE_PARTICIPLES = new Set([
  'based', 'known', 'called', 'named', 'located', 'situated', 'composed',
  'comprised', 'involved', 'related', 'considered', 'entitled', 'titled',
  'intended', 'supposed', 'concerned', 'interested', 'aimed', 'set',
  'referred', 'defined', 'described',
]);

function isPastParticiple(token: Token): boolean {
  const w = token.lower;
  if (IRREGULAR_PARTICIPLES.has(w)) return true;
  if (!w.endsWith('ed') || w.length < 5) return false;
  // "embed", "exceed", "indeed" and friends end in -ed without being participles.
  return !/(?:[aeiou]ed|need|[sdfl]eed)$/.test(w);
}

/**
 * Pattern rules that need sentence structure rather than a phrase table.
 * Every one of these is a linear scan over tokens the caller already produced.
 */
export function matchPatterns(sentence: Sentence, index: number, all: Sentence[]): PatternHit[] {
  const text = sentence.text;
  const tokens = tokenize(text);
  const hits: PatternHit[] = [];

  matchConfusions(tokens, hits);
  passiveVoice(text, tokens, hits);
  expletiveOpening(text, tokens, hits);
  longSentence(text, tokens, hits);
  adverbPileup(text, tokens, hits);
  nominalizations(text, tokens, hits);
  doubleNegative(text, tokens, hits);
  shouting(text, tokens, hits);
  repeatedOpener(text, tokens, index, all, hits);

  return hits;
}

function passiveVoice(text: string, tokens: Token[], hits: PatternHit[]): void {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!BE_VERBS.has(tokens[i]!.lower)) continue;

    // Allow one adverb between the auxiliary and the participle ("was clearly written").
    let j = i + 1;
    if (j < tokens.length && tokens[j]!.lower.endsWith('ly')) j++;
    const participle = tokens[j];
    if (!participle || !isPastParticiple(participle)) continue;
    if (STATIVE_PARTICIPLES.has(participle.lower)) continue;

    // "by <agent>" right after makes the passive unambiguous and names the actor,
    // which is the version worth rewriting. Without it, flag more gently.
    const next = tokens[j + 1];
    const hasAgent = next?.lower === 'by';

    hits.push({
      category: 'clarity',
      rule: hasAgent ? 'clarity:passive-with-agent' : 'clarity:passive-voice',
      start: tokens[i]!.start,
      end: participle.end,
      title: hasAgent ? 'Passive voice hides the actor at the end' : 'Passive voice',
      detail: hasAgent
        ? 'Naming who acted before the verb reads faster. Try putting the subject after "by" at the front of the sentence.'
        : 'Active voice is usually shorter and clearer. Keep the passive when the actor genuinely does not matter.',
    });
    i = j;
  }
}

function expletiveOpening(text: string, tokens: Token[], hits: PatternHit[]): void {
  const first = tokens[0];
  const second = tokens[1];
  if (!first || !second) return;
  const lead = first.lower;
  if (lead !== 'there' && lead !== 'it') return;
  if (!BE_VERBS.has(second.lower)) return;
  // "it is" followed by an adjective is often fine ("it is cold"); the weak form
  // is "it is <adj> that" / "there are <n> things".
  hits.push({
    category: 'clarity',
    rule: `clarity:expletive/${lead}`,
    start: first.start,
    end: second.end,
    title: `"${text.slice(first.start, second.end)}" delays the real subject`,
    detail: 'The sentence gets to its point faster if it starts with the thing it is about.',
  });
}

/** Thresholds for sentence length, in words. */
const LONG = 30;
const VERY_LONG = 45;

function longSentence(text: string, tokens: Token[], hits: PatternHit[]): void {
  if (tokens.length < LONG) return;
  const veryLong = tokens.length >= VERY_LONG;
  hits.push({
    category: 'clarity',
    rule: veryLong ? 'clarity:sentence-very-long' : 'clarity:sentence-long',
    start: 0,
    end: text.length,
    title: `${tokens.length}-word sentence`,
    detail: veryLong
      ? 'This is long enough that a reader will lose the thread. Split it at a natural clause break.'
      : 'Consider splitting this in two. Sentences past about 25 words get harder to follow.',
  });
}

function adverbPileup(text: string, tokens: Token[], hits: PatternHit[]): void {
  const adverbs = tokens.filter((t) => t.lower.length > 5 && t.lower.endsWith('ly'));
  if (adverbs.length < 3) return;
  hits.push({
    category: 'engagement',
    rule: 'engagement:adverb-pileup',
    start: adverbs[0]!.start,
    end: adverbs[adverbs.length - 1]!.end,
    title: `${adverbs.length} -ly adverbs in one sentence`,
    detail: 'Stacked adverbs usually mean the verbs and adjectives are doing too little. A stronger verb replaces most of them.',
  });
}

/**
 * Nouns built from verbs, where the verb is the better word.
 *
 * An earlier version matched the -tion/-ment/-ness suffixes and kept an
 * allowlist of exceptions. Measured against 74,000 words of edited prose it
 * fired 2,036 times — once every 36 words — on ordinary concrete nouns like
 * "thickness", "precipitation" and "expedition". No allowlist can cover the
 * noun vocabulary of English, so this is an explicit list instead.
 */
const NOMINALIZATIONS = new Set([
  'application', 'assessment', 'assumption', 'calculation', 'cancellation',
  'classification', 'collection', 'completion', 'conclusion', 'consideration',
  'construction', 'creation', 'declaration', 'description', 'determination',
  'discussion', 'distribution', 'elimination', 'establishment', 'evaluation',
  'examination', 'expansion', 'explanation', 'exploration', 'identification',
  'implementation', 'improvement', 'inclusion', 'installation', 'integration',
  'interpretation', 'introduction', 'investigation', 'management',
  'measurement', 'modification', 'notification', 'observation', 'operation',
  'organization', 'participation', 'preparation', 'presentation', 'prevention',
  'production', 'protection', 'provision', 'publication', 'recognition',
  'reduction', 'registration', 'rejection', 'removal', 'replacement',
  'resolution', 'restoration', 'retention', 'selection', 'separation',
  'simplification', 'specification', 'submission', 'suggestion', 'termination',
  'transformation', 'transmission', 'utilization', 'validation', 'verification',
]);

/** Determiners that mark the weak "the <noun> of <thing>" construction. */
const DETERMINERS = new Set(['the', 'a', 'an', 'this', 'that', 'its', 'their', 'our', 'his', 'her', 'your']);

/**
 * Flag only the construction that is actually weak: a determiner, a
 * nominalization, then "of". "The implementation of the solution" buries the
 * verb; "the organization held a vote" does not, and neither does "an average
 * thickness of 1.9 km".
 */
function nominalizations(text: string, tokens: Token[], hits: PatternHit[]): void {
  for (let i = 1; i < tokens.length - 1; i++) {
    const token = tokens[i]!;
    if (!NOMINALIZATIONS.has(token.lower)) continue;
    if (!DETERMINERS.has(tokens[i - 1]!.lower)) continue;
    if (tokens[i + 1]!.lower !== 'of') continue;

    hits.push({
      category: 'clarity',
      rule: 'clarity:nominalization',
      start: tokens[i - 1]!.start,
      end: tokens[i + 1]!.end,
      title: `"${token.text}" is a verb turned into a noun`,
      detail: 'This construction buries the verb and adds words. Using the verb directly is usually shorter and more direct.',
    });
  }
}

const NEGATIVES = new Set([
  'not', 'no', 'never', 'none', 'nobody', 'nothing', 'nowhere', 'neither', 'nor',
  "don't", "doesn't", "didn't", "won't", "can't", "cannot", "shouldn't", "wouldn't",
  "couldn't", "isn't", "aren't", "wasn't", "weren't", "haven't", "hasn't", "hadn't",
  'hardly', 'scarcely', 'barely',
]);

function doubleNegative(text: string, tokens: Token[], hits: PatternHit[]): void {
  const found = tokens.filter((t) => NEGATIVES.has(t.lower));
  if (found.length < 2) return;
  // Only flag negatives close enough together to actually compound.
  for (let i = 0; i < found.length - 1; i++) {
    const a = found[i]!;
    const b = found[i + 1]!;
    const between = tokens.filter((t) => t.start > a.start && t.start < b.start).length;
    if (between > 3) continue;
    hits.push({
      category: 'clarity',
      rule: 'clarity:double-negative',
      start: a.start,
      end: b.end,
      title: 'Two negatives in a row',
      detail: 'A reader has to cancel them out to work out what you mean. Say it positively.',
    });
    return;
  }
}

/** Roman numerals are capitalized by convention, not by shouting. */
const ROMAN = /^[IVXLCDM]+$/;

function shouting(text: string, tokens: Token[], hits: PatternHit[]): void {
  // Only an unbroken run counts. Scattered capitals are acronyms — "I sent the
  // PDF to the API team" is not shouting, and neither is "Class II MHC" or
  // "HIV/AIDS". Three in a row is the point at which it stops being plausible
  // that every one of them is an initialism.
  let run: Token[] = [];
  let longest: Token[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const isShout = token.text.length >= 2 && token.text === token.text.toUpperCase()
      && /[A-Z]/.test(token.text) && !ROMAN.test(token.text);

    if (isShout && (run.length === 0 || tokens[i - 1] === run[run.length - 1])) run.push(token);
    else run = isShout ? [token] : [];

    if (run.length > longest.length) longest = [...run];
  }

  if (longest.length >= 3) {
    hits.push({
      category: 'delivery',
      rule: 'delivery:all-caps',
      start: longest[0]!.start,
      end: longest[longest.length - 1]!.end,
      title: 'Capitals read as shouting',
      detail: 'Italics or bold carry emphasis without the raised voice.',
    });
  }

  const bangs = text.match(/!{2,}|!\s*!/g);
  if (bangs) {
    const at = text.indexOf(bangs[0]!);
    hits.push({
      category: 'delivery',
      rule: 'delivery:exclamation-pileup',
      start: at,
      end: at + bangs[0]!.length,
      title: 'Repeated exclamation marks',
      replacements: [{ text: '!' }],
      detail: 'One is enough. More reads as unserious.',
    });
  }
}

function repeatedOpener(text: string, tokens: Token[], index: number, all: Sentence[], hits: PatternHit[]): void {
  const first = tokens[0];
  if (!first || index === 0) return;
  const prev = tokenize(all[index - 1]!.text)[0];
  if (!prev || prev.lower !== first.lower) return;
  // Three in a row is the point at which it reads as a tic rather than a parallel.
  const beforeThat = index >= 2 ? tokenize(all[index - 2]!.text)[0] : undefined;
  if (!beforeThat || beforeThat.lower !== first.lower) return;
  hits.push({
    category: 'engagement',
    rule: 'engagement:repeated-opener',
    start: first.start,
    end: first.end,
    title: `Three sentences in a row open with "${first.text}"`,
    detail: 'Varying how sentences begin keeps a paragraph from reading as a list.',
  });
}
