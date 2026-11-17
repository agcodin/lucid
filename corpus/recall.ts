/**
 * Measures recall: of the errors a writer actually makes, how many does Lucid
 * catch, and does it offer the right fix?
 *
 * The false-positive harness answers the opposite question, and a checker can
 * score perfectly on that by finding nothing. This one takes clean,
 * copy-edited prose from the corpus, puts a known error into it at a known
 * position, and asks whether anything fires over that span.
 *
 * Errors are injected rather than taken from a labelled set so the whole thing
 * runs offline and reproducibly, and so each error type gets a rate of its own
 * rather than one aggregate number.
 */
import { readdir, readFile } from 'node:fs/promises';
import { LocalLinter, Dialect } from 'harper.js';
import { binary } from 'harper.js/binary';
import { toBlocks } from '../packages/engine/src/segment.js';
import { runRules } from '../packages/engine/src/tiers/rules.js';
import { applyReplacement } from '../packages/engine/src/scheduler.js';
import { categoryOfLintKind } from '../packages/engine/src/tiers/harper-kinds.js';
import type { Issue } from '../packages/engine/src/types.js';

interface Injection {
  /** What kind of mistake this is, for the per-type report. */
  type: string;
  /** Finds candidate sites in clean text. Must be anchored on a word boundary. */
  pattern: RegExp;
  /** The broken form to write in place of the match. */
  break: (match: RegExpMatchArray) => string | undefined;
}

const INJECTIONS: Injection[] = [
  { type: "its -> it's", pattern: /\bit's\b/gi, break: () => 'its' },
  { type: "it's -> its", pattern: /\bits\b(?= own)/gi, break: () => "it's" },
  { type: "they're -> their", pattern: /\bthey're\b/gi, break: () => 'their' },
  { type: "there -> their", pattern: /\bthere (?=is|are|was|were)/gi, break: () => 'their ' },
  { type: "you're -> your", pattern: /\byou're\b/gi, break: () => 'your' },
  { type: 'than -> then', pattern: /\b(more|less|better|worse|larger|smaller|faster|slower|rather) than\b/gi,
    break: (m) => `${m[1]} then` },
  { type: 'lose -> loose', pattern: /\blose\b/gi, break: () => 'loose' },
  { type: 'have -> of (after modal)', pattern: /\b(could|should|would|must) have\b/gi, break: (m) => `${m[1]} of` },
  { type: 'dropped apostrophe', pattern: /\b(won|can|don|doesn|didn|isn|aren|wasn|couldn|wouldn|shouldn)'t\b/gi,
    break: (m) => `${m[1]}t` },
  { type: 'dropped apostrophe (thats)', pattern: /\bthat's\b/gi, break: () => 'thats' },
  { type: 'doubled word', pattern: /\bthe (\w{4,})\b/gi, break: (m) => `the the ${m[1]}` },
  { type: 'a -> an mismatch', pattern: /\ban ([aeiou]\w+)/gi, break: (m) => `a ${m[1]}` },
  { type: 'misspelling (transposed)', pattern: /\bthe\b/g, break: () => 'teh' },
  { type: 'misspelling (ie/ei)', pattern: /\breceive\b/gi, break: () => 'recieve' },
  { type: 'misspelling (common)', pattern: /\bseparate\b/gi, break: () => 'seperate' },
  { type: 'misspelling (double letter)', pattern: /\boccurred\b/gi, break: () => 'occured' },
  { type: 'subject-verb agreement', pattern: /\bthey (are|were)\b/gi, break: () => 'they is' },
  { type: 'wordiness (in order to)', pattern: /\bto (\w+) the\b/gi, break: (m) => `in order to ${m[1]} the` },
  { type: 'wordiness (utilize)', pattern: /\buses?\b/gi, break: () => 'utilizes' },
  { type: 'filler (very)', pattern: /\bis (\w{5,})\b/gi, break: (m) => `is very ${m[1]}` },

  // Homophone pairs, which no spell checker can catch on the word alone.
  { type: 'effect -> affect', pattern: /\bthe effect\b/gi, break: () => 'the affect' },
  { type: 'affect -> effect', pattern: /\b(can|may|will|would) affect\b/gi, break: (m) => `${m[1]} effect` },
  { type: 'principle -> principal', pattern: /\bprinciples?\b/gi, break: (m) => m[0].replace(/ple/i, 'pal') },
  { type: 'complement -> compliment', pattern: /\bcomplements? each other\b/gi, break: (m) => m[0].replace(/ple/i, 'pli') },
  { type: 'led -> lead', pattern: /\b(has|have|had|which) led\b/gi, break: (m) => `${m[1]} lead` },
  { type: 'past -> passed', pattern: /\bthe past\b/gi, break: () => 'the passed' },
  { type: 'except -> accept', pattern: /\bexcept\b/gi, break: () => 'accept' },

  // Mechanics.
  { type: 'comma splice', pattern: /\b(\w+)\. (The|This|It|These|They) \b/g, break: (m) => `${m[1]}, ${m[2].toLowerCase()} ` },
  { type: 'lowercase sentence start', pattern: /\. ([A-Z])(\w+)/g, break: (m) => `. ${m[1].toLowerCase()}${m[2]}` },
  { type: 'repeated punctuation', pattern: /\. /g, break: () => '.. ' },
  { type: 'plural apostrophe', pattern: /\b(19|20)(\d0)s\b/g, break: (m) => `${m[1]}${m[2]}'s` },
  { type: 'redundant acronym', pattern: /\bthe URL\b/g, break: () => 'the URL address' },
  { type: 'nonstandard word', pattern: /\bregardless\b/gi, break: () => 'irregardless' },
  { type: 'alot', pattern: /\ba lot\b/gi, break: () => 'alot' },
  { type: 'fewer -> less', pattern: /\bfewer (?!than)(\w+)\b/gi, break: (m) => `less ${m[1]}` },
  { type: 'me -> I (object)', pattern: /\bbetween (\w+) and (?:me|us)\b/gi, break: (m) => `between ${m[1]} and I` },
];

/** One trial: a sentence, the span that was broken, and which type broke it. */
interface Trial {
  type: string;
  text: string;
  start: number;
  end: number;
  /** The text that was there before, which a correct fix should restore. */
  original: string;
}

const linter = new LocalLinter({ binary, dialect: Dialect.American });
await linter.setup();

/** Lint a block with both tiers, the way the scheduler does. */
async function check(text: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const block of toBlocks(text)) {
    issues.push(...runRules(block));
    for (const lint of await linter.lint(block.text, { language: 'plaintext', dedup: true })) {
      const span = lint.span();
      issues.push({
        id: 'h', category: categoryOfLintKind(lint.lint_kind()), tier: 'harper',
        rule: `harper:${lint.lint_kind()}`,
        start: block.start + span.start, end: block.start + span.end,
        title: lint.message(),
        replacements: lint.suggestions().map((s) => ({ text: s.get_replacement_text() })),
      });
    }
  }
  return issues;
}

// --- Build the trials -----------------------------------------------------

const DIRS = ['./text/', './mdn/'].map((d) => new URL(d, import.meta.url));
const sentences: string[] = [];

for (const dir of DIRS) {
  let files: string[] = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.txt')); } catch { continue; }
  for (const file of files) {
    const text = await readFile(new URL(file, dir), 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      // Sentences long enough to carry context, short enough to lint quickly.
      if (trimmed.length >= 40 && trimmed.length <= 400) sentences.push(trimmed);
    }
  }
}

const PER_TYPE = 60;
const trials: Trial[] = [];

for (const injection of INJECTIONS) {
  let made = 0;
  for (const sentence of sentences) {
    if (made >= PER_TYPE) break;
    injection.pattern.lastIndex = 0;
    const match = injection.pattern.exec(sentence);
    if (!match) continue;
    let broken = injection.break(match);
    if (broken === undefined) continue;
    // Carry the original capitalization onto the broken form, so a fix that
    // correctly restores "There" is not scored against a lowercase expectation.
    const first = match[0][0]!;
    if (first === first.toUpperCase() && first !== first.toLowerCase()) {
      broken = broken[0]!.toUpperCase() + broken.slice(1);
    }

    const start = match.index!;
    const text = sentence.slice(0, start) + broken + sentence.slice(start + match[0].length);
    trials.push({ type: injection.type, text, start, end: start + broken.length, original: match[0] });
    made++;
  }
}

// --- Run them -------------------------------------------------------------

interface Score { made: number; found: number; fixed: number }
const scores = new Map<string, Score>();
const misses = new Map<string, string[]>();

for (const trial of trials) {
  const score = scores.get(trial.type) ?? { made: 0, found: 0, fixed: 0 };
  score.made++;

  const issues = await check(trial.text);
  // Any issue whose span overlaps the injected error counts as a detection.
  const over = issues.filter((issue) => issue.start < trial.end && issue.end > trial.start);
  if (over.length > 0) {
    score.found++;
    // A correct fix is one that puts the original text back. Applied through
    // applyReplacement, because that is what the user actually gets: it also
    // fixes the spacing and capitalization around the edit, and comparing
    // against a raw splice scored those as wrong.
    const restores = over.some((issue) =>
      issue.replacements.some((replacement) =>
        applyReplacement(trial.text, issue, replacement.text).text.includes(trial.original),
      ),
    );
    if (restores) score.fixed++;
  } else {
    const list = misses.get(trial.type) ?? [];
    if (list.length < 5) list.push(trial.text.slice(Math.max(0, trial.start - 35), trial.end + 35));
    misses.set(trial.type, list);
  }
  scores.set(trial.type, score);
}

// --- Report ---------------------------------------------------------------

const rows = [...scores].sort((a, b) => (a[1].found / a[1].made) - (b[1].found / b[1].made));
let made = 0;
let found = 0;
let fixed = 0;

console.log(`${trials.length} injected errors across ${scores.size} types, from ${sentences.length.toLocaleString()} clean sentences\n`);
console.log(`  ${'error type'.padEnd(30)}${'n'.padStart(5)}${'caught'.padStart(9)}${'right fix'.padStart(11)}`);
for (const [type, score] of rows) {
  made += score.made; found += score.found; fixed += score.fixed;
  const caught = `${Math.round((score.found / score.made) * 100)}%`;
  const right = `${Math.round((score.fixed / score.made) * 100)}%`;
  console.log(`  ${type.padEnd(30)}${String(score.made).padStart(5)}${caught.padStart(9)}${right.padStart(11)}`);
}
console.log(`  ${'overall'.padEnd(30)}${String(made).padStart(5)}${`${Math.round((found / made) * 100)}%`.padStart(9)}${`${Math.round((fixed / made) * 100)}%`.padStart(11)}`);

const worst = rows.filter(([, score]) => score.found / score.made < 0.95);
if (worst.length > 0) {
  console.log('\nmissed examples');
  for (const [type] of worst) {
    for (const example of misses.get(type) ?? []) console.log(`  ${type}\n    …${example}…`);
  }
}
