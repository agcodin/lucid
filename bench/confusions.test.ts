import { toBlocks, runRules } from '../packages/engine/src/index.js';

const cases = `It wont be ready and its not clear whether your going to ship.
Their is a problem. You could of told me. This is better then that.
Dont loose the thread. Thats what I meant. Its own merits are clear.
The dog wagged its tail. We were there. The well was deep. Let's go.`;

for (const block of toBlocks(cases)) {
  for (const issue of runRules(block)) {
    if (issue.category !== 'correctness') continue;
    console.log(`"${cases.slice(issue.start, issue.end)}" -> ${issue.replacements.map(r=>r.text).join('|')}  [${issue.rule}]`);
  }
}
console.log('\n(nothing flagged in "the dog wagged its tail", "we were there", "the well was deep" = no false positives)');
