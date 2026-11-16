import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBlocks } from '../src/segment.js';
import { runRules } from '../src/tiers/rules.js';

function correctness(text: string): { rule: string; span: string; fix: string | undefined }[] {
  return toBlocks(text)
    .flatMap((block) => runRules(block))
    .filter((issue) => issue.category === 'correctness')
    .map((issue) => ({
      rule: issue.rule,
      span: text.slice(issue.start, issue.end),
      fix: issue.replacements[0]?.text,
    }));
}

test('missing-apostrophe contractions are caught with the right fix', () => {
  const expected: [string, string, string][] = [
    ['It wont work.', 'wont', "won't"],
    ['I cant tell.', 'cant', "can't"],
    ['Dont stop now.', 'Dont', "Don't"],
    ['Thats the plan.', 'Thats', "That's"],
    ['Theyre leaving soon.', 'Theyre', "They're"],
    ['Youre early today.', 'Youre', "You're"],
    ['It doesnt matter.', 'doesnt', "doesn't"],
    ['She couldnt attend.', 'couldnt', "couldn't"],
  ];
  for (const [text, span, fix] of expected) {
    const found = correctness(text).find((issue) => issue.span === span);
    assert.ok(found, `nothing flagged on ${text}`);
    assert.equal(found.fix, fix, text);
  }
});

test('words that are also contractions-without-apostrophes are left alone', () => {
  // Each of these is a common word in its own right. Flagging them would
  // misfire constantly, which is why they are absent from the table.
  for (const text of [
    'We were there yesterday.',
    'The well was deep.',
    'He paid the bill.',
    'Let us go now.',
    'She lets him drive.',
    'I feel ill today.',
    'His id was checked.',
  ]) {
    assert.deepEqual(correctness(text), [], text);
  }
});

test('its and it\'s are told apart by what follows', () => {
  assert.equal(correctness('Its not ready.')[0]?.fix, "It's");
  assert.equal(correctness('Its a problem.')[0]?.fix, "It's");
  assert.equal(correctness('Its going to rain.')[0]?.fix, "It's");

  // Possessives, including before an adjective, must stay untouched.
  for (const text of [
    'The dog wagged its tail.',
    'Its true significance was missed.',
    'Its clear advantage is speed.',
    'The company raised its forecast.',
    'It is on its own merits.',
  ]) {
    assert.deepEqual(correctness(text), [], text);
  }
});

test('your and you\'re are told apart by what follows', () => {
  assert.equal(correctness('Your welcome.')[0]?.fix, "You're");
  assert.equal(correctness('Your probably right.')[0]?.fix, "You're");
  for (const text of ['Your car is outside.', 'I read your report.']) {
    assert.deepEqual(correctness(text), [], text);
  }
});

test('then and than, their and there, loose and lose', () => {
  assert.equal(correctness('This is better then that.')[0]?.fix, 'than');
  assert.equal(correctness('Their is a problem.')[0]?.fix, 'There');
  assert.equal(correctness('Dont loose the thread.').find((i) => i.span === 'loose')?.fix, 'lose');

  for (const text of [
    'We went home, then slept.',
    'Their car broke down.',
    'The screw is loose.',
    'There is a problem.',
  ]) {
    assert.deepEqual(correctness(text), [], text);
  }
});

test('modal plus "of" becomes "have"', () => {
  for (const text of ['You could of told me.', 'It should of worked.', 'We would of gone.']) {
    assert.equal(correctness(text)[0]?.fix, 'have', text);
  }
  assert.deepEqual(correctness('He thought of a plan.'), []);
});

test('capitalization carries onto the replacement', () => {
  assert.equal(correctness('Wont work.')[0]?.fix, "Won't");
  assert.equal(correctness('Their is one.')[0]?.fix, 'There');
});
