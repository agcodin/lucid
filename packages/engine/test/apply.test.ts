import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReplacement } from '../src/scheduler.js';
import type { Issue } from '../src/types.js';

const at = (start: number, end: number): Issue =>
  ({ id: 'x', category: 'clarity', tier: 'rules', rule: 'r', start, end, title: '', replacements: [] });

/** Locate `phrase` in `text` so cases read without hand-counted offsets. */
function span(text: string, phrase: string): Issue {
  const start = text.indexOf(phrase);
  assert.notEqual(start, -1, `"${phrase}" not in ${JSON.stringify(text)}`);
  return at(start, start + phrase.length);
}

const cases: [string, string, string, string][] = [
  // text, phrase to replace, replacement, expected result
  ['In order to ship, we tested.', 'In order to', 'to', 'To ship, we tested.'],
  ['We shipped. In order to test, we ran it.', 'In order to', 'to', 'We shipped. To test, we ran it.'],
  ['We utilize it daily.', 'utilize', 'use', 'We use it daily.'],
  ['The very large file broke.', 'very', '', 'The large file broke.'],
  ['Very large files broke.', 'Very', '', 'Large files broke.'],
  ['It was, in my opinion, fine.', 'in my opinion', '', 'It was fine.'],
  ['In my opinion, this works.', 'In my opinion', '', 'This works.'],
  ['The build is really slow.', 'really', '', 'The build is slow.'],
  ['It wont work.', 'wont', "won't", "It won't work."],
  ['Thats the plan.', 'Thats', "That's", "That's the plan."],
];

test('applyReplacement produces well-formed text', () => {
  for (const [text, phrase, replacement, expected] of cases) {
    assert.equal(applyReplacement(text, span(text, phrase), replacement).text, expected, text);
  }
});

test('the cursor lands after the inserted text', () => {
  const text = 'We utilize it daily.';
  const result = applyReplacement(text, span(text, 'utilize'), 'use');
  assert.equal(result.text.slice(0, result.cursor), 'We use');
});

test('a deletion never leaves a doubled space or a space before punctuation', () => {
  for (const [text, phrase, replacement] of cases) {
    if (replacement !== '') continue;
    const result = applyReplacement(text, span(text, phrase), replacement).text;
    assert.ok(!result.includes('  '), `doubled space in ${JSON.stringify(result)}`);
    assert.ok(!/\s[.,;:!?]/.test(result), `space before punctuation in ${JSON.stringify(result)}`);
  }
});

test('the result never starts with a lowercase letter when the original did not', () => {
  for (const [text, phrase, replacement] of cases) {
    const result = applyReplacement(text, span(text, phrase), replacement).text;
    assert.ok(/^[A-Z]/.test(result), `lost the leading capital in ${JSON.stringify(result)}`);
  }
});

test('a replacement mid-sentence keeps its lowercase form', () => {
  const text = 'We will utilize the tool.';
  assert.equal(applyReplacement(text, span(text, 'utilize'), 'use').text, 'We will use the tool.');
});
