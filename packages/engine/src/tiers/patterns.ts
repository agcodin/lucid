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

/** Noun forms that bury a verb. The verb is almost always the better word. */
const NOMINALIZATION_SUFFIX = /(?:tion|sion|ment|ance|ence|ity|ness)s?$/;
const NOMINALIZATION_ALLOW = new Set([
  'information', 'question', 'nation', 'station', 'section', 'option', 'version',
  'condition', 'position', 'function', 'solution', 'direction', 'relation',
  'tradition', 'institution', 'constitution', 'generation', 'population',
  'mention', 'moment', 'document', 'element', 'equipment', 'environment',
  'government', 'department', 'instrument', 'argument', 'experiment',
  'distance', 'instance', 'balance', 'chance', 'performance', 'importance',
  'difference', 'reference', 'experience', 'evidence', 'audience', 'science',
  'quality', 'quantity', 'ability', 'security', 'activity', 'community',
  'university', 'opportunity', 'majority', 'minority', 'priority', 'city',
  'business', 'witness', 'illness', 'fitness',
]);

function nominalizations(text: string, tokens: Token[], hits: PatternHit[]): void {
  for (const token of tokens) {
    if (token.lower.length < 8) continue;
    if (!NOMINALIZATION_SUFFIX.test(token.lower)) continue;
    if (NOMINALIZATION_ALLOW.has(token.lower.replace(/s$/, ''))) continue;
    hits.push({
      category: 'clarity',
      rule: 'clarity:nominalization',
      start: token.start,
      end: token.end,
      title: `"${token.text}" is a verb turned into a noun`,
      detail: 'Nouns built from verbs make sentences longer and vaguer. Using the verb form usually cuts several words.',
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

function shouting(text: string, tokens: Token[], hits: PatternHit[]): void {
  const caps = tokens.filter((t) => t.text.length > 2 && t.text === t.text.toUpperCase() && /[A-Z]/.test(t.text));
  if (caps.length >= 2) {
    hits.push({
      category: 'delivery',
      rule: 'delivery:all-caps',
      start: caps[0]!.start,
      end: caps[caps.length - 1]!.end,
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
