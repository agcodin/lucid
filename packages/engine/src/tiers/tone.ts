import { toSentences, tokenize } from '../segment.js';
import type { Tone, ToneLabel } from '../types.js';

/**
 * Lexical markers per tone. Scores are evidence weights, not probabilities:
 * each hit adds its weight, and the strongest three signals are reported.
 *
 * This is a feature-and-lexicon detector rather than a model, for the same
 * reason the rule tier is: it has to run on idle without a download.
 */
const MARKERS: Record<ToneLabel, Record<string, number>> = {
  formal: {
    furthermore: 2, moreover: 2, nevertheless: 2, consequently: 2, therefore: 1.5,
    thus: 1.5, hence: 1.5, accordingly: 2, notwithstanding: 2.5, whereas: 1.5,
    herein: 2.5, aforementioned: 2.5, pursuant: 3, regarding: 1, shall: 2,
    'with respect to': 2, 'in accordance with': 2.5, 'it is recommended': 2,
  },
  informal: {
    yeah: 2, yep: 2, nope: 2, gonna: 2.5, wanna: 2.5, gotta: 2.5, kinda: 2.5,
    sorta: 2.5, stuff: 1.5, things: 0.5, guys: 1.5, cool: 1.5, awesome: 1.5,
    huge: 1, super: 1.5, totally: 1.5, basically: 1, honestly: 1, anyway: 1,
    ok: 1, okay: 1, hey: 2, lol: 3, btw: 2.5, fyi: 1.5,
  },
  confident: {
    will: 1, must: 1.5, certainly: 1.5, clearly: 1.5, definitely: 1.5,
    undoubtedly: 2, absolutely: 1.5, always: 1, proven: 1.5, demonstrates: 1,
    'we recommend': 2, 'i recommend': 2, 'the answer is': 1.5, 'in fact': 1,
  },
  tentative: {
    might: 1.5, maybe: 1.5, perhaps: 1.5, possibly: 1.5, probably: 1,
    seems: 1.5, appears: 1.5, somewhat: 1.5, arguably: 1.5, presumably: 1.5,
    'i think': 2, 'i believe': 1.5, 'i feel': 1.5, 'not sure': 2,
    'could be': 1.5, 'it is possible': 2, 'to some extent': 2,
  },
  friendly: {
    thanks: 2, thank: 1.5, please: 1.5, welcome: 1.5, glad: 2, happy: 1.5,
    appreciate: 2, hope: 1, great: 1, wonderful: 1.5, excited: 2,
    'looking forward': 2.5, 'let me know': 1.5, 'feel free': 2, 'no worries': 2.5,
  },
  direct: {
    need: 1, require: 1.5, do: 0.5, send: 1, confirm: 1.5, provide: 1,
    stop: 2, ensure: 1.5, 'you must': 2.5, 'i need': 2, 'make sure': 1.5,
    'as soon as': 1.5, 'right away': 2,
  },
  optimistic: {
    opportunity: 1.5, improve: 1, growth: 1.5, promising: 2, strong: 1,
    success: 1.5, benefit: 1.5, gain: 1, progress: 1.5, forward: 1,
    confident: 1.5, 'well positioned': 2.5, 'on track': 2,
  },
  urgent: {
    urgent: 3, immediately: 2.5, asap: 3, critical: 2, deadline: 2,
    now: 1, today: 1, overdue: 2.5, blocked: 2, blocker: 2,
    'right now': 2.5, 'time sensitive': 3, 'as soon as possible': 2.5,
  },
  analytical: {
    data: 1.5, analysis: 1.5, result: 1, measured: 1.5, compared: 1.5,
    percent: 1.5, baseline: 2, correlation: 2, variance: 2, median: 2,
    'on average': 2, 'the data shows': 2.5, 'we observed': 2,
  },
  neutral: {},
};

/** Markers flattened into a lookup from phrase to the tones it signals. */
const LEXICON: Map<string, { label: ToneLabel; weight: number }[]> = (() => {
  const map = new Map<string, { label: ToneLabel; weight: number }[]>();
  for (const [label, words] of Object.entries(MARKERS) as [ToneLabel, Record<string, number>][]) {
    for (const [phrase, weight] of Object.entries(words)) {
      const existing = map.get(phrase);
      if (existing) existing.push({ label, weight });
      else map.set(phrase, [{ label, weight }]);
    }
  }
  return map;
})();

const MAX_PHRASE_WORDS = 4;

export function analyzeTone(text: string): Tone {
  const tokens = tokenize(text);
  const sentences = toSentences(text);
  const scores = new Map<ToneLabel, number>();

  const add = (label: ToneLabel, weight: number): void => {
    scores.set(label, (scores.get(label) ?? 0) + weight);
  };

  // Lexical evidence: try the longest phrase at each position first.
  for (let i = 0; i < tokens.length; i++) {
    for (let n = Math.min(MAX_PHRASE_WORDS, tokens.length - i); n >= 1; n--) {
      const phrase = tokens.slice(i, i + n).map((t) => t.lower).join(' ');
      const entries = LEXICON.get(phrase);
      if (!entries) continue;
      for (const entry of entries) add(entry.label, entry.weight);
      i += n - 1;
      break;
    }
  }

  // Structural evidence, normalized so long documents do not swamp short ones.
  const words = Math.max(tokens.length, 1);

  // Below this, structure says nothing. A four-word sentence is short because
  // it is a fragment, not because the writer is being direct, and reading tone
  // off that produces a confident label from no evidence.
  const ENOUGH_FOR_STRUCTURE = 12;
  const per100 = (n: number): number => (n / words) * 100;

  const contractions = (text.match(/\b\w+['’](?:t|s|re|ve|ll|d|m)\b/g) ?? []).length;
  const exclamations = (text.match(/!/g) ?? []).length;
  const questions = (text.match(/\?/g) ?? []).length;
  const secondPerson = tokens.filter((t) => t.lower === 'you' || t.lower === 'your').length;
  const firstPerson = tokens.filter((t) => t.lower === 'i' || t.lower === 'we').length;
  const longWords = tokens.filter((t) => t.text.length >= 9).length;
  const avgSentence = sentences.length > 0 ? words / sentences.length : words;

  if (words >= ENOUGH_FOR_STRUCTURE) {
    add('informal', per100(contractions) * 0.6 + per100(exclamations) * 1.2);
    add('friendly', per100(exclamations) * 0.5 + per100(secondPerson) * 0.3 + per100(questions) * 0.4);
    add('formal', per100(longWords) * 0.4 + Math.max(0, avgSentence - 18) * 0.3);
    add('direct', per100(secondPerson) * 0.25 + Math.max(0, 14 - avgSentence) * 0.2);
    add('analytical', per100((text.match(/\d/g) ?? []).length) * 0.15);
    if (firstPerson === 0 && words > 40) add('formal', 1.5);
  }

  const formalScore = scores.get('formal') ?? 0;
  const informalScore = scores.get('informal') ?? 0;
  const confidentScore = scores.get('confident') ?? 0;
  const tentativeScore = scores.get('tentative') ?? 0;

  const labels = [...scores.entries()]
    .filter(([label, score]) => label !== 'neutral' && score >= 1.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, score]) => ({ label, strength: Math.min(1, round(score / 12, 2)) }));

  if (labels.length === 0) labels.push({ label: 'neutral', strength: 1 });

  return {
    labels,
    formality: ratio(formalScore, informalScore),
    confidence: ratio(confidentScore, tentativeScore),
  };
}

/** Map two competing scores onto 0-1, landing on 0.5 when there is no evidence. */
function ratio(a: number, b: number): number {
  const total = a + b;
  if (total < 1) return 0.5;
  return round(a / total, 2);
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
