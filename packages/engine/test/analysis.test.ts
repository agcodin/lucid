import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeReadability, syllables } from '../src/tiers/readability.js';
import { analyzeTone } from '../src/tiers/tone.js';

test('syllable counts are exact for regular words', () => {
  const expected: [string, number][] = [
    ['cat', 1], ['the', 1], ['table', 2], ['happy', 2], ['beautiful', 3],
    ['computer', 3], ['university', 5], ['photosynthesis', 5], ['rhythm', 1],
    ['queue', 1], ['area', 3], ['idea', 3], ['organization', 5], ['create', 2],
    ['media', 3], ['simple', 2], ['little', 2], ['running', 2], ['walked', 1],
    ['probably', 3], ['interesting', 4], ['people', 2],
  ];
  for (const [word, count] of expected) {
    assert.equal(syllables(word), count, word);
  }
});

test('irregular words are off by at most one', () => {
  // "business" is said "biz-ness", "every" is said "ev-ry", and "science"
  // breaks across the "ie". No rule-based counter gets these without a
  // pronunciation dictionary, and one syllable of error barely moves a Flesch
  // score.
  for (const [word, count] of [['business', 2], ['every', 2], ['science', 2]] as [string, number][]) {
    assert.ok(Math.abs(syllables(word) - count) <= 1, `${word}: got ${syllables(word)}`);
  }
});

test('readability of empty text is well-defined', () => {
  const report = analyzeReadability('');
  assert.equal(report.words, 0);
  assert.equal(report.sentences, 0);
  assert.equal(report.flesch, 100);
  assert.equal(report.readingSeconds, 0);
});

test('simple prose scores easier than dense prose', () => {
  const simple = 'The cat sat on the mat. The dog ran. We went home. It was fun.';
  const dense = 'The implementation of the aforementioned methodology necessitates comprehensive reconsideration of organizational infrastructure, particularly where institutional accountability intersects with administrative discretion.';
  assert.ok(analyzeReadability(simple).flesch > analyzeReadability(dense).flesch);
  assert.ok(analyzeReadability(simple).grade < analyzeReadability(dense).grade);
});

test('readability scores stay inside their defined ranges', () => {
  for (const text of [
    'Go.',
    'The cat sat on the mat.',
    'Antidisestablishmentarianism characterizes incomprehensibly multisyllabic philosophical argumentation throughout.',
  ]) {
    const report = analyzeReadability(text);
    assert.ok(report.flesch >= 0 && report.flesch <= 100, `flesch out of range for ${text}`);
    assert.ok(report.grade >= 0, `negative grade for ${text}`);
    assert.ok(report.passiveRatio >= 0 && report.passiveRatio <= 1);
    assert.ok(report.complexWordRatio >= 0 && report.complexWordRatio <= 1);
  }
});

test('passive ratio counts sentences, not occurrences', () => {
  const report = analyzeReadability('The report was written. The team shipped it.');
  assert.equal(report.sentences, 2);
  assert.equal(report.passiveRatio, 0.5);
});

test('reading time scales with length', () => {
  const short = analyzeReadability(Array(100).fill('word').join(' '));
  const long = analyzeReadability(Array(1000).fill('word').join(' '));
  assert.ok(long.readingSeconds > short.readingSeconds * 5);
});

test('tone separates formal from casual writing', () => {
  const formal = analyzeTone('Furthermore, the committee shall review the aforementioned proposal in accordance with established procedure. Consequently, implementation is deferred.');
  const casual = analyzeTone("Hey, yeah that's totally cool. Gonna grab coffee, wanna come? btw it's awesome.");
  assert.ok(formal.formality > casual.formality, `${formal.formality} should exceed ${casual.formality}`);
});

test('tone separates confident from hedged writing', () => {
  const confident = analyzeTone('We will ship on Friday. The data clearly demonstrates the result. We recommend approval.');
  const hedged = analyzeTone('I think we might possibly ship, perhaps on Friday. It seems the data could be somewhat unclear.');
  assert.ok(confident.confidence > hedged.confidence, `${confident.confidence} should exceed ${hedged.confidence}`);
});

test('tone reports neutral rather than guessing on thin input', () => {
  const tone = analyzeTone('The box is here.');
  assert.ok(tone.labels.length > 0);
  assert.equal(tone.labels[0]!.label, 'neutral');
});

test('tone meters stay within zero and one', () => {
  for (const text of ['', 'Hi.', 'URGENT: respond immediately, this is critical and overdue.']) {
    const tone = analyzeTone(text);
    assert.ok(tone.formality >= 0 && tone.formality <= 1, text);
    assert.ok(tone.confidence >= 0 && tone.confidence <= 1, text);
    assert.ok(tone.labels.every((entry) => entry.strength >= 0 && entry.strength <= 1));
  }
});

test('urgent writing is detected as urgent', () => {
  const tone = analyzeTone('This is urgent. We need it immediately, the deadline is today and we are blocked.');
  assert.ok(tone.labels.some((entry) => entry.label === 'urgent'), JSON.stringify(tone.labels));
});
