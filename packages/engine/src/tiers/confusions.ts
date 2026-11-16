import type { Token } from '../segment.js';
import type { PatternHit } from './patterns.js';

/**
 * Missing-apostrophe contractions.
 *
 * A Map rather than an object, because a plain object inherits from
 * Object.prototype: looking up "constructor" returned the Object constructor,
 * which is truthy, so every use of that very common word was flagged with
 * "function Object() { [native code] }" offered as the fix.
 *
 * Harper's dictionary accepts several of these
 * as words in their own right ("wont", "cant", "shed"), so it leaves them
 * alone — but in running prose they are almost always the contraction. Only
 * forms with no common alternate reading are listed; "id", "ill", "hes",
 * "shes", "were", "well" and "lets" are deliberately absent — each is a common
 * word on its own, so flagging it would misfire more often than it helps.
 */
const CONTRACTIONS = new Map<string, string>(Object.entries({
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
}));

/**
 * Words after which a bare "its" is nearly always the contraction "it's".
 *
 * Adjectives are deliberately absent. "its true significance" and "its clear
 * advantage" are correct possessives, and an adjective cannot tell the two
 * apart without knowing whether a noun follows. What remains are negation,
 * adverbs, articles and other possessives, none of which can follow a
 * possessive "its".
 */
const ITS_FOLLOWERS = new Set([
  'a', 'an', 'the', 'not', 'just', 'already', 'been', 'also', 'still', 'now',
  'too', 'very', 'really', 'quite', 'because', 'always', 'never',
  'probably', 'definitely', 'my', 'our', 'your',
  'going', 'getting', 'becoming', 'unclear', 'unlikely',
]);

/**
 * Adverbs cannot follow a possessive, so "its often useful" has to be the
 * contraction. This is separate from the list above because it is a rule about
 * a part of speech rather than about particular words.
 */
const ADVERBS = new Set([
  'often', 'rarely', 'seldom', 'usually', 'generally', 'typically', 'normally',
  'commonly', 'certainly', 'clearly', 'obviously', 'apparently', 'perhaps',
  'hardly', 'barely', 'mostly', 'largely', 'entirely', 'completely',
  'absolutely', 'simply', 'merely', 'essentially', 'basically', 'actually',
  'truly', 'indeed', 'therefore', 'thus', 'sometimes', 'frequently',
  'almost', 'nearly', 'virtually', 'universally', 'widely', 'highly',
  'relatively', 'surprisingly', 'remarkably', 'increasingly', 'particularly',
  'especially', 'currently', 'originally', 'finally', 'eventually', 'recently',
  'previously', 'arguably', 'undoubtedly', 'unfortunately',
]);

/**
 * Nouns that only appear after "its" as part of an idiom meaning "it is", as
 * in "it's good practice to" and "it's a bad idea to".
 *
 * "time" is deliberately absent: "its time to live" is a real possessive in
 * networking writing, which is exactly the kind of text this runs on.
 */
const IDIOM_NOUNS = new Set(['practice', 'idea', 'habit', 'custom', 'policy', 'convention', 'wisdom']);

/**
 * Adjectives that take an infinitive after them. "its preferable to" cannot be
 * a possessive, because the "to" leaves the adjective with no noun to modify.
 */
const ADJECTIVES_BEFORE_TO = new Set([
  'preferable', 'important', 'useful', 'possible', 'impossible', 'necessary',
  'essential', 'better', 'best', 'easier', 'harder', 'easy', 'hard',
  'difficult', 'common', 'standard', 'typical', 'tempting', 'wise', 'safe',
  'good', 'bad', 'helpful', 'sensible', 'reasonable', 'crucial', 'vital',
  'critical', 'worth', 'enough', 'rare', 'usual', 'unusual', 'fine',
]);

/**
 * Pronouns paired with the wrong form of "be". Harper catches most of these
 * but not all, and when it does its suggestion often changes the pronoun
 * rather than the verb.
 */
const BE_AGREEMENT = new Map<string, string>([
  ['i|are', 'am'], ['i|is', 'am'], ['i|were', 'was'],
  ['you|is', 'are'], ['you|was', 'were'],
  ['he|are', 'is'], ['she|are', 'is'], ['it|are', 'is'],
  ['he|were', 'was'], ['she|were', 'was'], ['it|were', 'was'],
  ['we|is', 'are'], ['they|is', 'are'],
  ['we|was', 'were'], ['they|was', 'were'],
]);

/**
 * Conjunctions a subject pronoun can follow. Used to tell the pronoun "I" from
 * the letter, which appears constantly in technical and scientific writing as
 * a designation ("photosystem I") or a variable ("and i is uniform random").
 */
const CLAUSE_STARTERS = new Set([
  'and', 'or', 'but', 'that', 'if', 'when', 'while', 'because', 'so', 'then',
  'yet', 'nor', 'although', 'though', 'since', 'before', 'after', 'as',
]);

/**
 * Before these, "were" is the subjunctive and correct, as in "if it were
 * possible" and "as though he were leaving".
 */
const SUBJUNCTIVE_CUES = new Set(['if', 'though', 'wish', 'wishes', 'wished', 'as', 'whether', 'lest']);

/** Subjects and modals after which "loose" has to be the verb "lose". */
const LOSE_SUBJECTS = new Set([
  'you', 'we', 'they', 'i', 'he', 'she', 'it', 'to', 'will', 'would', 'can',
  'could', 'may', 'might', 'should', 'must', 'never', 'always', 'not',
  "don't", "won't", "didn't", "doesn't", 'dont', 'wont',
]);

/** Words after which a bare "your" is nearly always "you're". */
const YOURE_FOLLOWERS = new Set([
  'welcome', 'right', 'wrong', 'correct', 'not', 'already', 'probably',
  'definitely', 'absolutely', 'going', 'getting', 'doing', 'looking', 'making',
  'being', 'always', 'never', 'still', 'just', 'the', 'a', 'an', 'in',
  'about', 'free', 'able', 'sure', 'ready', 'good', 'great', 'better', 'best',
]);

/** Words that mark the thing an -ing verb acts on, as opposed to a noun's own verb. */
const GERUND_OBJECTS = new Set([
  'a', 'an', 'the', 'to', 'it', 'them', 'this', 'that', 'these', 'those',
  'some', 'any', 'my', 'his', 'her', 'our', 'their', 'me', 'us', 'him',
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

    const contraction = CONTRACTIONS.get(word);
    if (contraction !== undefined) {
      push(hits, token, `Missing apostrophe in "${token.text}"`, [matchCase(token.text, contraction)],
        'confusion:contraction',
        `"${token.text}" is being read as a word in its own right. The contraction takes an apostrophe.`);
      continue;
    }

    if (!next) continue;

    if (word === 'its' && (ITS_FOLLOWERS.has(next.lower) || ADVERBS.has(next.lower))) {
      push(hits, token, 'Did you mean "it\'s"?', [matchCase(token.text, "it's")], 'confusion:its',
        '"Its" is the possessive. Before a verb or an article you want "it is", shortened to "it\'s".');
      continue;
    }
    // "its preferable to ..." — the infinitive leaves the adjective nothing to
    // modify, so this cannot be a possessive.
    // "its good practice to ..." — an idiom with an optional adjective in it.
    const idiomAt = IDIOM_NOUNS.has(next.lower) ? i + 1
      : IDIOM_NOUNS.has(tokens[i + 2]?.lower ?? '') ? i + 2
      : undefined;
    if (word === 'its' && idiomAt !== undefined && tokens[idiomAt + 1]?.lower === 'to') {
      push(hits, token, 'Did you mean "it\'s"?', [matchCase(token.text, "it's")], 'confusion:its',
        'This is the idiom "it is good practice to", which takes the contraction.');
      continue;
    }
    if (word === 'its' && ADJECTIVES_BEFORE_TO.has(next.lower) && tokens[i + 2]?.lower === 'to') {
      push(hits, token, 'Did you mean "it\'s"?', [matchCase(token.text, "it's")], 'confusion:its',
        'A possessive "its" needs a noun after it. Here the sentence means "it is".');
      continue;
    }
    if (word === "it's" && next.lower === 'own') {
      push(hits, token, 'Did you mean "its"?', ['its'], 'confusion:its-possessive',
        '"It\'s" means "it is". The possessive has no apostrophe.');
      continue;
    }
    // "your writing a regular expression" — a gerund followed by an object is
    // a verb, where "your writing is good" is a noun and stays possessive.
    const gerundObject = next.lower.endsWith('ing') && next.lower.length > 5
      && tokens[i + 2] !== undefined && GERUND_OBJECTS.has(tokens[i + 2]!.lower);
    if (word === 'your' && (YOURE_FOLLOWERS.has(next.lower) || gerundObject)) {
      push(hits, token, 'Did you mean "you\'re"?', [matchCase(token.text, "you're")], 'confusion:youre',
        '"Your" is the possessive. Here the sentence needs "you are".');
      continue;
    }
    if (word === 'their' && (next.lower === 'is' || next.lower === 'are' || next.lower === 'was' || next.lower === 'were')) {
      push(hits, token, 'Did you mean "there"?', [matchCase(token.text, 'there')], 'confusion:their-there',
        '"Their" is the possessive. "There is" and "there are" introduce something.');
      continue;
    }
    const previous = tokens[i - 1];

    const agreement = BE_AGREEMENT.get(`${word}|${next.lower}`);
    if (agreement !== undefined && isSubjectPronoun(token, previous)) {
      // "if it were possible" is the subjunctive, not a mistake.
      const subjunctive = next.lower === 'were'
        && previous !== undefined && SUBJUNCTIVE_CUES.has(previous.lower);
      if (!subjunctive) {
        hits.push({
          category: 'correctness',
          rule: 'confusion:be-agreement',
          start: token.start,
          end: next.end,
          title: `"${token.text} ${next.text}" should be "${token.text} ${agreement}"`,
          detail: `"${token.text}" takes "${agreement}".`,
          replacements: [{ text: `${token.text} ${matchCase(next.text, agreement)}` }],
        });
        i++;
        continue;
      }
    }

    if (word === 'loose' && (LOSE_FOLLOWERS.has(next.lower) || (previous !== undefined && LOSE_SUBJECTS.has(previous.lower)))) {
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

/**
 * Whether this token is the pronoun rather than the letter.
 *
 * "I" is the only one that needs the test. It is always capitalized, and as a
 * subject it opens a clause, where the letter sits inside a phrase.
 */
function isSubjectPronoun(token: Token, previous: Token | undefined): boolean {
  if (token.lower !== 'i') return true;
  if (token.text !== 'I') return false;
  return previous === undefined || CLAUSE_STARTERS.has(previous.lower);
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
