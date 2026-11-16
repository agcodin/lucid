import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBlocks, toSentences, tokenize } from '../src/segment.js';

test('toBlocks splits on blank lines and keeps absolute offsets', () => {
  const text = 'First para.\n\nSecond para.\n\n\nThird para.';
  const blocks = toBlocks(text);
  assert.equal(blocks.length, 3);
  for (const block of blocks) {
    assert.equal(text.slice(block.start, block.start + block.text.length), block.text);
  }
});

test('toBlocks skips blank and whitespace-only regions', () => {
  assert.equal(toBlocks('\n\n   \n\n').length, 0);
  assert.equal(toBlocks('one\n\n   \n\ntwo').length, 2);
});

test('toBlocks gives identical text the same hash', () => {
  const [a, b] = toBlocks('Same text here.\n\nSame text here.');
  assert.equal(a!.hash, b!.hash);
  assert.notEqual(a!.start, b!.start);
});

test('toSentences offsets round-trip', () => {
  const text = 'One. Two! Three? Four.';
  for (const sentence of toSentences(text)) {
    assert.equal(text.slice(sentence.start, sentence.start + sentence.text.length), sentence.text);
  }
});

test('toSentences does not split on abbreviations, initials or decimals', () => {
  const cases: [string, number][] = [
    ['Dr. Smith arrived at 9 a.m. and left.', 1],
    ['We met Mr. Jones and Ms. Lee.', 1],
    ['It cost 3.5 million dollars.', 1],
    ['J. R. Tolkien wrote it.', 1],
    ['Use vs. the other one.', 1],
    ['He left. She stayed.', 2],
    ['Really? Yes! Fine.', 3],
  ];
  for (const [text, expected] of cases) {
    assert.equal(toSentences(text).length, expected, text);
  }
});

test('toSentences keeps closing quotes and brackets with their sentence', () => {
  const sentences = toSentences('She said "go." Then she left.');
  assert.equal(sentences.length, 2);
  assert.equal(sentences[0]!.text, 'She said "go."');
});

test('tokenize keeps internal apostrophes and hyphens together', () => {
  assert.deepEqual(tokenize("don't well-known x").map((t) => t.text), ["don't", 'well-known', 'x']);
});

test('tokenize offsets point at the token', () => {
  const text = '  hello   world  ';
  for (const token of tokenize(text)) {
    assert.equal(text.slice(token.start, token.end), token.text);
  }
});

test('ordinary words that look like abbreviations still end sentences', () => {
  // Regression: a single abbreviation set containing "sat", "us", "no", "wed"
  // and "sun" merged these into one sentence each, which silently broke every
  // sentence-level rule downstream.
  const cases: [string, number][] = [
    ['The cat sat. The dog ran.', 2],
    ['He gave it to us. Then he left.', 2],
    ['The answer is no. We move on.', 2],
    ['They were wed. The party followed.', 2],
    ['Clouds hid the sun. Rain came.', 2],
    ['She holds an MD. He does not.', 2],
    ['It cost a lot. We paid.', 2],
  ];
  for (const [text, expected] of cases) {
    assert.equal(toSentences(text).length, expected, text);
  }
});

test('capitalized abbreviations are still respected', () => {
  const cases: [string, number][] = [
    ['We met Dr. Chen on Tuesday.', 1],
    ['The deadline is Mon. and nothing moves it.', 1],
    ['Acme Inc. filed the report.', 1],
    ['See pp. 14 for details.', 1],
    ['Use this vs. the other one.', 1],
  ];
  for (const [text, expected] of cases) {
    assert.equal(toSentences(text).length, expected, text);
  }
});

test('lowercase prose still splits, so casual writing is not one long sentence', () => {
  assert.equal(toSentences('hey. whats up. im fine').length, 3);
});
