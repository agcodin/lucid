import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBlocks } from '../src/segment.js';
import { runRules } from '../src/tiers/rules.js';

function usage(text: string): { rule: string; fix: string | undefined }[] {
  return toBlocks(text)
    .flatMap((block) => runRules(block))
    .filter((issue) => issue.rule.startsWith('usage:'))
    .map((issue) => ({ rule: issue.rule, fix: issue.replacements[0]?.text }));
}

test('principal and principle are told apart by construction', () => {
  assert.equal(usage('It works in principal.')[0]?.fix, 'principle');
  assert.equal(usage('The principals of engineering apply.')[0]?.fix, 'principles');
  assert.equal(usage('The principle reason is cost.')[0]?.fix, 'principal');

  // Both of these are correct and must stay untouched.
  for (const text of [
    'The principal met the students.',
    'She is the principal of the school.',
    'The principle of least privilege applies.',
    'He repaid the principal and the interest.',
  ]) {
    assert.deepEqual(usage(text), [], text);
  }
});

test('lead becomes led only after a perfect auxiliary', () => {
  assert.equal(usage('That has lead to problems.')[0]?.fix, 'led');
  assert.equal(usage('It had lead nowhere.')[0]?.fix, 'led');
  for (const text of ['They lead the team.', 'The pipes contain lead.', 'This will lead to problems.']) {
    assert.deepEqual(usage(text), [], text);
  }
});

test('passed becomes past after a determiner', () => {
  assert.equal(usage('In the passed, we shipped weekly.')[0]?.fix, 'past');
  assert.equal(usage('Over the passed few years it grew.')[0]?.fix, 'past');
  for (const text of ['He passed the test.', 'The passed ball rolled away.', 'Time passed slowly.']) {
    assert.deepEqual(usage(text), [], text);
  }
});

test('redundant acronyms are flagged, with the acronym kept', () => {
  const flagged = usage('Enter the URL address and the PIN number.');
  assert.equal(flagged.length, 2);
  assert.equal(flagged[0]?.rule, 'usage:redundant-acronym');
  assert.deepEqual(usage('Enter the URL and the PIN.'), []);
  // Lowercase means it is a word, not the acronym.
  assert.deepEqual(usage('The url address field is here.'), []);
});

test('fewer and less are told apart by countability', () => {
  assert.equal(usage('There are less items now.')[0]?.fix, 'fewer');
  for (const text of [
    'There is less water now.',
    'We made less progress than hoped.',
    'It took less time.',
    // "less" modifying an adjective is correct, and flagging it was a real
    // false positive on edited prose.
    'Vaccines reach less developed countries slowly.',
    'The range has less than two elements.',
  ]) {
    assert.deepEqual(usage(text), [], text);
  }
});

test('irregardless is flagged', () => {
  assert.equal(usage('Irregardless of cost, we ship.')[0]?.fix, 'Regardless');
  assert.deepEqual(usage('Regardless of cost, we ship.'), []);
});
