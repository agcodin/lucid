import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBlocks } from '../src/segment.js';
import { runRules } from '../src/tiers/rules.js';
import type { Issue } from '../src/types.js';

function check(text: string): Issue[] {
  return toBlocks(text).flatMap((block) => runRules(block));
}

function rules(text: string): string[] {
  return check(text).map((issue) => issue.rule);
}

/** Assert that a rule whose name starts with `prefix` fired on `text`. */
function flags(text: string, prefix: string): void {
  const fired = rules(text);
  assert.ok(
    fired.some((rule) => rule.startsWith(prefix)),
    `expected ${prefix} on ${JSON.stringify(text)}, got [${fired.join(', ')}]`,
  );
}

/** Assert that no rule starting with `prefix` fired. */
function clean(text: string, prefix: string): void {
  const fired = rules(text).filter((rule) => rule.startsWith(prefix));
  assert.deepEqual(fired, [], `unexpected ${prefix} on ${JSON.stringify(text)}`);
}

test('every issue span lies inside the document and matches its text', () => {
  const text = 'In order to ship, we utilize a very large number of tools.\n\nThe report was written by the team. Its not ready.';
  for (const issue of check(text)) {
    assert.ok(issue.start >= 0 && issue.end <= text.length, `${issue.rule} out of bounds`);
    assert.ok(issue.end > issue.start, `${issue.rule} has an empty span`);
    assert.ok(issue.title.length > 0, `${issue.rule} has no title`);
  }
});

test('issues are unique per span and rule', () => {
  const text = 'In order to ship, in order to test, we utilize it.';
  const keys = check(text).map((issue) => `${issue.rule}@${issue.start}`);
  assert.equal(new Set(keys).size, keys.length, 'duplicate issues emitted');
});

test('wordy phrases fire and offer a shorter form', () => {
  for (const [text, replacement] of [
    ['In order to ship, we tested.', 'to'],
    ['Due to the fact that it broke, we stopped.', 'because'],
    ['We will utilize the new tool.', 'use'],
    ['At this point in time we are done.', 'now'],
    ['A large number of users complained.', 'many'],
  ] as [string, string][]) {
    const issue = check(text).find((candidate) => candidate.rule.startsWith('clarity:wordy'));
    assert.ok(issue, `no wordy flag on ${text}`);
    assert.ok(
      issue.replacements.some((candidate) => candidate.text === replacement),
      `${text}: expected "${replacement}", got [${issue.replacements.map((r) => r.text).join(', ')}]`,
    );
  }
});

test('longest phrase wins over a shorter one inside it', () => {
  // "in my personal opinion" contains "in my opinion"; the long form must win.
  const fired = rules('In my personal opinion it shipped.');
  assert.ok(
    fired.includes('clarity:wordy/in-my-personal-opinion'),
    `got [${fired.join(', ')}]`,
  );
});

test('passive voice fires, and active voice does not', () => {
  flags('The report was written by the team.', 'clarity:passive');
  flags('The bug was fixed yesterday.', 'clarity:passive');
  flags('The file was clearly marked.', 'clarity:passive');

  clean('The team wrote the report.', 'clarity:passive');
  clean('She is happy with the result.', 'clarity:passive');
  clean('They are ready to go.', 'clarity:passive');
  clean('The water was cold and deep.', 'clarity:passive');
});

test('passive with a named agent is distinguished from passive without one', () => {
  assert.ok(rules('The report was written by the team.').includes('clarity:passive-with-agent'));
  assert.ok(rules('The report was written yesterday.').includes('clarity:passive-voice'));
});

test('sentence length rules fire only past their thresholds', () => {
  const short = `${Array(20).fill('word').join(' ')}.`;
  const long = `${Array(34).fill('word').join(' ')}.`;
  const veryLong = `${Array(50).fill('word').join(' ')}.`;
  clean(short, 'clarity:sentence');
  assert.ok(rules(long).includes('clarity:sentence-long'));
  assert.ok(rules(veryLong).includes('clarity:sentence-very-long'));
});

test('double negatives fire only when the negatives are close together', () => {
  flags('I do not have nothing to say.', 'clarity:double-negative');
  clean('I do not think the second clause here is negative at all in any way.', 'clarity:double-negative');
});

test('repeated opener fires on the third in a row, not the second', () => {
  clean('The cat sat. The dog ran.', 'engagement:repeated-opener');
  flags('The cat sat. The dog ran. The bird flew.', 'engagement:repeated-opener');
});

test('adverb pileup needs three adverbs in one sentence', () => {
  clean('He quickly finished the quietly written report.', 'engagement:adverb-pileup');
  flags('He quickly and quietly and carefully finished it.', 'engagement:adverb-pileup');
});

test('shouting and exclamation pileups fire in delivery', () => {
  flags('THIS IS URGENT, fix it now.', 'delivery:all-caps');
  flags('WHY DID YOU DO THAT', 'delivery:all-caps');
  flags('Thanks so much!!', 'delivery:exclamation-pileup');
  clean('Thanks so much!', 'delivery:exclamation-pileup');
  // Scattered capitals are acronyms, not shouting.
  clean('I sent the PDF to the API team.', 'delivery:all-caps');
  clean('The HTTP request returned JSON.', 'delivery:all-caps');
});

test('hedges fire in delivery', () => {
  flags('I think that we should ship.', 'delivery:hedge');
  flags('Sorry to bother you, but the build broke.', 'delivery:hedge');
});

test('nominalizations fire but common nouns are allowed through', () => {
  flags('The implementation of the solution took weeks.', 'clarity:nominalization');
  for (const allowed of [
    'The information was useful.',
    'The government department met.',
    'Performance and security matter.',
    'The university community gathered.',
    'That is a difference of opinion.',
  ]) {
    clean(allowed, 'clarity:nominalization');
  }
});

test('expletive openings fire only at the start of a sentence', () => {
  flags('There is a problem with the build.', 'clarity:expletive');
  flags('It is clear that we must ship.', 'clarity:expletive');
  clean('We know there is a problem.', 'clarity:expletive');
});

test('no phrase appears in two tables, where the later one could never fire', async () => {
  const { WORDY, FILLER, HEDGES, CLICHES } = await import('../src/tiers/phrases.js');
  const seen = new Map<string, string[]>();
  for (const [name, table] of Object.entries({ WORDY, FILLER, HEDGES, CLICHES })) {
    for (const rule of table) {
      seen.set(rule.from, [...(seen.get(rule.from) ?? []), name]);
    }
  }
  const duplicated = [...seen].filter(([, where]) => where.length > 1);
  assert.deepEqual(duplicated, [], 'a phrase in two tables makes one rule unreachable');
});

test('rule names are unique across every phrase table', async () => {
  const { ALL_PHRASES } = await import('../src/tiers/phrases.js');
  const names = ALL_PHRASES.map((rule) => rule.rule);
  assert.equal(new Set(names).size, names.length);
});
