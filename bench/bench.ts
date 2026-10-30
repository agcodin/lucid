/**
 * Measures the two numbers the design depends on: tier 0 cost on the typing
 * path, and tier 1 cost per edit once block caching is in play.
 */
import { LocalLinter, Dialect } from 'harper.js';
import { binary } from 'harper.js/binary';
import { toBlocks, runRules, analyzeReadability, analyzeTone, PHRASE_RULE_COUNT } from '../packages/engine/src/index.js';

const PARA = `In order to facilitate the utilization of the new system, we have made a decision to implement a change that will have an impact on the way in which the team operates on a daily basis. The report was written by the committee prior to the meeting. There is a very real possibility that, due to the fact that the requirements were not communicated in a timely manner, the implementation of the solution will be delayed. I think that maybe we should probably circle back on this at the end of the day. Their going to send alot of thigs and it wont be ready.`;

function doc(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, i) => `${PARA} Paragraph ${i} ends here.`).join('\n\n');
}

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
  return `median ${at(0.5).toFixed(2)}ms  p95 ${at(0.95).toFixed(2)}ms  max ${sorted[sorted.length - 1]!.toFixed(2)}ms`;
}

const linter = new LocalLinter({ binary, dialect: Dialect.American });
const t0 = performance.now();
await linter.setup();
console.log(`harper setup:        ${(performance.now() - t0).toFixed(0)}ms (once, in a worker, off the main thread)`);
console.log(`phrase rules loaded: ${PHRASE_RULE_COUNT}`);
console.log(`harper rules loaded: ${Object.keys(await linter.getLintConfig()).length}\n`);

for (const paragraphs of [1, 10, 50, 200]) {
  const text = doc(paragraphs);
  const blocks = toBlocks(text);
  console.log(`--- ${paragraphs} paragraph(s), ${text.length.toLocaleString()} chars, ${blocks.length} blocks ---`);

  // Tier 0 over the whole document, which is the worst case (first paint).
  const whole: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    for (const block of blocks) runRules(block);
    whole.push(performance.now() - t);
  }
  console.log(`  tier0 whole doc:   ${stats(whole)}`);

  // Tier 0 on one edited block, which is what a keystroke actually costs.
  const last = blocks[blocks.length - 1]!;
  const one: number[] = [];
  for (let i = 0; i < 400; i++) {
    const t = performance.now();
    runRules(last);
    one.push(performance.now() - t);
  }
  console.log(`  tier0 one block:   ${stats(one)}   <- per keystroke`);

  // Tier 1 naive: re-lint the entire document, which is what an extension that
  // does not segment has to do.
  const naive: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await linter.lint(text, { language: 'plaintext' });
    naive.push(performance.now() - t);
  }
  console.log(`  tier1 whole doc:   ${stats(naive)}   <- naive, no segmentation`);

  // Tier 1 incremental: only the edited block is uncached.
  const incremental: number[] = [];
  for (let i = 0; i < 20; i++) {
    const edited = { ...last, text: `${last.text} Edit ${i} alot.` };
    const t = performance.now();
    await linter.lint(edited.text, { language: 'plaintext' });
    incremental.push(performance.now() - t);
  }
  console.log(`  tier1 one block:   ${stats(incremental)}   <- what lucid does`);

  const analysis: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    analyzeReadability(text);
    analyzeTone(text);
    analysis.push(performance.now() - t);
  }
  console.log(`  tier2 analysis:    ${stats(analysis)}   <- on idle only\n`);
}
