import test from 'node:test';
import assert from 'node:assert/strict';
import { runRules } from '../src/tiers/rules.js';
import { applyReplacement } from '../src/scheduler.js';

function splices(text: string) {
  return runRules({ text, start: 0, hash: 'h', index: 0 }).filter(
    (issue) => issue.rule === 'correctness:comma-splice',
  );
}

test('comma splice fires on two sentences joined by a comma', () => {
  const cases = [
    'The build finished, the tests were still running.',
    'It works, this is the fix we needed.',
    'They were late, we had to start without them.',
    'The meeting ran long, I was late for dinner.',
    'She is the lead, he is the backup.',
  ];
  for (const text of cases) assert.equal(splices(text).length, 1, text);
});

test('comma splice stays quiet where the comma is doing another job', () => {
  const cases = [
    // An introductory clause, which is what every looser version of this rule
    // flagged first.
    'After the build finished, the tests were still running.',
    'Given the delay, the tests were skipped.',
    'Often, you will want to use this defensively.',
    'First, the tests were run.',
    // A parenthetical or an appositive, where the subject runs past the comma.
    'The report, a long one, was late.',
    'At the top, we have the function we are in, and the caller.',
    'There are islands around it, most of which are volcanic.',
    // A phrase rather than a clause before the comma.
    'In the report he wrote, the data was wrong.',
    'Told in letters, it is as neatly plotted as a play.',
    'Had Austen sold it on commission, she would have made a profit.',
    // Correct joins.
    'The build failed, but the tests were fine.',
    'The more he tried, the worse it got.',
    '"Stop," he said quietly.',
  ];
  for (const text of cases) assert.equal(splices(text).length, 0, text);
});

test('the comma splice fix restores the two sentences', () => {
  const text = 'The build finished, the tests were still running.';
  const issue = splices(text)[0]!;
  const edit = applyReplacement(text, issue, issue.replacements[0]!.text);
  assert.equal(edit.text, 'The build finished. The tests were still running.');
  assert.equal(
    applyReplacement(text, issue, issue.replacements[1]!.text).text,
    'The build finished; the tests were still running.',
  );
});
