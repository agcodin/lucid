import { applyReplacement } from '../packages/engine/src/index.js';
import type { Issue } from '../packages/engine/src/index.js';

const issue = (start: number, end: number): Issue =>
  ({ id: 'x', category: 'clarity', tier: 'rules', rule: 'r', start, end, title: '', replacements: [] });

/** [text, span start, span end, replacement, expected] */
const cases: [string, number, number, string, string][] = [
  ['In order to ship, we tested.', 0, 11, 'to', 'To ship, we tested.'],
  ['We shipped. In order to test, we ran it.', 12, 23, 'to', 'We shipped. To test, we ran it.'],
  ['We utilize it daily.', 3, 10, 'use', 'We use it daily.'],
  ['The very large file broke.', 4, 8, '', 'The large file broke.'],
  ['Very large files broke.', 0, 4, '', 'Large files broke.'],
  ['It was, in my opinion, fine.', 8, 21, '', 'It was fine.'],
  ['In my opinion, this works.', 0, 13, '', 'This works.'],
  ['The build is really slow.', 13, 19, '', 'The build is slow.'],
];

let failed = 0;
for (const [text, start, end, replacement, expected] of cases) {
  const out = applyReplacement(text, issue(start, end), replacement).text;
  const ok = out === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${JSON.stringify(text)}\n      -> ${JSON.stringify(out)}${ok ? '' : `\n      expected ${JSON.stringify(expected)}`}`);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
