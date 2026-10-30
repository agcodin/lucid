import type { Token } from '../segment.js';
import type { PatternHit } from './patterns.js';

/**
 * Missing-apostrophe contractions. Harper's dictionary accepts several of these
 * as words in their own right ("wont", "cant", "shed"), so it leaves them
 * alone — but in running prose they are almost always the contraction. Only
 * forms with no common alternate reading are listed; "id", "ill", "hes",
 * "shes", "were", "well" and "lets" are deliberately absent — each is a common
 * word on its own, so flagging it would misfire more often than it helps.
 */
const CONTRACTIONS: Record<string, string> = {
  wont: "won't", cant: "can't", dont: "don't", doesnt: "doesn't", didnt: "didn't",
  isnt: "isn't", arent: "aren't", wasnt: "wasn't", werent: "weren't",
  hasnt: "hasn't", havent: "haven't", hadnt: "hadn't",
  couldnt: "couldn't", wouldnt: "wouldn't", shouldnt: "shouldn't",
  mustnt: "mustn't", neednt: "needn't", aint: "isn't",
  theyre: "they're", theyve: "they've", theyll: "they'll", theyd: "they'd",
  youre: "you're", youve: "you've", youll: "you'll", youd: "you'd",
  weve: "we've",
  whos: "who's", whats: "what's", wheres: "where's", hows: "how's", whens: "when's",
  thats: "that's", theres: "there's", heres: "here's",
  couldve: "could've", wouldve: "would've", shouldve: "should've",
  oclock: "o'clock", yall: "y'all",
};

/** Words after which a bare "its" is nearly always the contraction "it's". */
const ITS_FOLLOWERS = new Set([
  'a', 'an', 'the', 'not', 'just', 'already', 'been', 'also', 'still', 'now',
  'too', 'very', 'really', 'quite', 'clear', 'important', 'possible', 'likely',
  'unlikely', 'true', 'false', 'easy', 'hard', 'difficult', 'better', 'worse',
  'time', 'one', 'my', 'our', 'your', 'about', 'because', 'always', 'never',
  'probably', 'definitely', 'obvious', 'fine', 'okay', 'ok', 'good', 'bad',
  'worth', 'going', 'getting', 'taking', 'becoming', 'looking', 'working',
]);

/** Words after which a bare "your" is nearly always "you're". */
const YOURE_FOLLOWERS = new Set([
  'welcome', 'right', 'wrong', 'correct', 'not', 'already', 'probably',
  'definitely', 'absolutely', 'going', 'getting', 'doing', 'looking', 'making',
  'being', 'always', 'never', 'still', 'just', 'the', 'a', 'an', 'in',
  'about', 'free', 'able', 'sure', 'ready', 'good', 'great', 'better', 'best',
]);

/** Comparatives after which "then" should be "than". */
const COMPARATIVES = new Set([
  'more', 'less', 'fewer', 'better', 'worse', 'greater', 'larger', 'smaller',
  'bigger', 'higher', 'lower', 'faster', 'slower', 'easier', 'harder',
  'older', 'younger', 'longer', 'shorter', 'cheaper', 'other', 'rather',
  'stronger', 'weaker', 'simpler', 'sooner', 'later',
]);

/** Verbs after which "loose" should be "lose". */
const LOSE_FOLLOWERS = new Set([
  'the', 'a', 'an', 'my', 'your', 'his', 'her', 'their', 'our', 'it',
  'weight', 'money', 'track', 'sight', 'control', 'interest', 'time', 'face',
]);

/** Modals that take "have", not the misheard "of". */
const MODALS_OF = new Set(['could', 'should', 'would', 'must', 'might', 'may']);

/**
 * Correctness rules covering the confusions Harper's dictionary lets through.
 * Each one is gated on a following word, so it fires on the construction rather
 * than on the word alone.
 */
export function matchConfusions(tokens: Token[], hits: PatternHit[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const next = tokens[i + 1];
    const word = token.lower;

    const contraction = CONTRACTIONS[word];
    if (contraction !== undefined) {
      push(hits, token, `Missing apostrophe in "${token.text}"`, [matchCase(token.text, contraction)],
        'confusion:contraction',
        `"${token.text}" is being read as a word in its own right. The contraction takes an apostrophe.`);
      continue;
    }

    if (!next) continue;

    if (word === 'its' && ITS_FOLLOWERS.has(next.lower)) {
      push(hits, token, 'Did you mean "it\'s"?', [matchCase(token.text, "it's")], 'confusion:its',
        '"Its" is the possessive. Before a verb or an article you want "it is", shortened to "it\'s".');
      continue;
    }
    if (word === "it's" && next.lower === 'own') {
      push(hits, token, 'Did you mean "its"?', ['its'], 'confusion:its-possessive',
        '"It\'s" means "it is". The possessive has no apostrophe.');
      continue;
    }
    if (word === 'your' && YOURE_FOLLOWERS.has(next.lower)) {
      push(hits, token, 'Did you mean "you\'re"?', [matchCase(token.text, "you're")], 'confusion:youre',
        '"Your" is the possessive. Here the sentence needs "you are".');
      continue;
    }
    if (word === 'their' && (next.lower === 'is' || next.lower === 'are' || next.lower === 'was' || next.lower === 'were')) {
      push(hits, token, 'Did you mean "there"?', [matchCase(token.text, 'there')], 'confusion:their-there',
        '"Their" is the possessive. "There is" and "there are" introduce something.');
      continue;
    }
    if (word === 'loose' && LOSE_FOLLOWERS.has(next.lower)) {
      push(hits, token, 'Did you mean "lose"?', ['lose'], 'confusion:loose-lose',
        '"Loose" is the opposite of tight. "Lose" is the verb.');
      continue;
    }
    if (word === 'of' && i > 0 && MODALS_OF.has(tokens[i - 1]!.lower)) {
      push(hits, token, 'Use "have" after a modal', ['have'], 'confusion:modal-of',
        '"Could of" is how "could\'ve" sounds. In writing it is "could have".');
      continue;
    }
    if (next.lower === 'then' && COMPARATIVES.has(word)) {
      push(hits, next, 'Did you mean "than"?', [matchCase(next.text, 'than')], 'confusion:then-than',
        '"Then" is about time. Comparisons take "than".');
    }
  }
}

function push(hits: PatternHit[], token: Token, title: string, replacements: string[], rule: string, detail: string): void {
  hits.push({
    category: 'correctness',
    rule,
    start: token.start,
    end: token.end,
    title,
    detail,
    replacements: replacements.map((text) => ({ text })),
  });
}

/** Carry the original word's capitalization onto the replacement. */
function matchCase(original: string, replacement: string): string {
  if (original[0] === original[0]?.toUpperCase() && original[0] !== original[0]?.toLowerCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}
