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

test('words that name Object.prototype members are not treated as lookups', () => {
  // A plain object inherits from Object.prototype, so CONTRACTIONS["constructor"]
  // returned the Object constructor: truthy, so "constructor" was flagged, with
  // "function Object() { [native code] }" offered as the replacement.
  for (const word of [
    'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
    'propertyIsEnumerable', 'toLocaleString', 'prototype',
  ]) {
    assert.deepEqual(correctness(`The ${word} is documented here.`), [], word);
  }
});

test('every suggested replacement is a plain string', () => {
  const text = 'The constructor wont work. Its toString and valueOf are fine.';
  for (const issue of toBlocks(text).flatMap((block) => runRules(block))) {
    for (const replacement of issue.replacements) {
      assert.equal(typeof replacement.text, 'string', `${issue.rule} offered a non-string`);
      assert.ok(!replacement.text.includes('native code'), `${issue.rule} leaked a function`);
    }
  }
});

test('pronoun and be-verb agreement is caught', () => {
  const expected: [string, string][] = [
    ['They is ready.', 'they are'],
    ['We was late.', 'we were'],
    ['He are leaving.', 'he is'],
    ['You is correct.', 'you are'],
    ['I are going.', 'i am'],
    ['It are broken.', 'it is'],
  ];
  for (const [text, fix] of expected) {
    const found = correctness(text).find((issue) => issue.rule === 'confusion:be-agreement');
    assert.ok(found, `nothing flagged on ${text}`);
    assert.equal(found.fix?.toLowerCase(), fix, text);
  }
});

test('correct agreement and the subjunctive are left alone', () => {
  for (const text of [
    'They are ready.', 'We were late.', 'He is leaving.', 'I am going.',
    'If it were possible, we would.',
    'He talks as though he were in charge.',
    'I wish it were simpler.',
  ]) {
    assert.deepEqual(correctness(text).filter((i) => i.rule === 'confusion:be-agreement'), [], text);
  }
});

test('the letter i is not read as the pronoun', () => {
  // Both of these appear in real technical and scientific writing, and both
  // were flagged before the pronoun test was added.
  for (const text of [
    'The reaction center of photosystem I are replaced by transfer.',
    'The sizes are i and n, and i is uniform random from 0 to n.',
    'Section I is the introduction.',
  ]) {
    assert.deepEqual(correctness(text).filter((i) => i.rule === 'confusion:be-agreement'), [], text);
  }
});

test('"it\'s good practice to" is caught as the idiom it is', () => {
  for (const text of ['Its good practice to close it.', 'Its common practice to do so.', 'Its a bad idea to skip it.']) {
    assert.ok(correctness(text).some((issue) => issue.rule === 'confusion:its'), text);
  }
  // "its time to live" is a real possessive in networking writing.
  assert.deepEqual(correctness('The packet and its time to live are shown.'), []);
});

test('adverbs after "its" mark the contraction', () => {
  for (const text of ['Its often useful.', 'Its almost universally accepted.', 'Its clearly wrong.']) {
    assert.ok(correctness(text).some((issue) => issue.rule === 'confusion:its'), text);
  }
});
