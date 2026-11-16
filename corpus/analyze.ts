/**
 * Measures how often each rule fires on well-edited prose.
 *
 * Every flag here is a judgement call rather than a certain error, since the
 * corpus has already been through copy-editing. Correctness rules should be
 * near silent — those claim an outright mistake, so a hit is almost always a
 * false positive. Clarity and engagement rules are advisory and will fire on
 * any real text, but a rule firing far more than its peers is usually too loose
 * rather than unusually insightful.
 */
import { readdir, readFile } from 'node:fs/promises';
import { toBlocks } from '../packages/engine/src/segment.js';
import { runRules } from '../packages/engine/src/tiers/rules.js';
import type { Category, Issue } from '../packages/engine/src/types.js';

const DIR = new URL('./text/', import.meta.url);

interface Hit {
  rule: string;
  category: Category;
  text: string;
  context: string;
}

const hits: Hit[] = [];
let words = 0;
const files = (await readdir(DIR)).filter((name) => name.endsWith('.txt'));
if (files.length === 0) {
  console.error('No corpus. Run: node corpus/fetch.mjs');
  process.exit(1);
}

for (const file of files) {
  const text = await readFile(new URL(file, DIR), 'utf8');
  words += text.split(/\s+/).filter(Boolean).length;
  for (const block of toBlocks(text)) {
    for (const issue of runRules(block) as Issue[]) {
      hits.push({
        rule: issue.rule,
        category: issue.category,
        text: text.slice(issue.start, issue.end).replace(/\s+/g, ' '),
        context: text.slice(Math.max(0, issue.start - 45), issue.end + 45).replace(/\s+/g, ' '),
      });
    }
  }
}

const per1k = (n: number): string => ((n / words) * 1000).toFixed(2);

console.log(`corpus: ${words.toLocaleString()} words in ${files.length} files`);
console.log(`flags:  ${hits.length.toLocaleString()} (${per1k(hits.length)} per 1,000 words)\n`);

const byCategory = new Map<Category, number>();
for (const hit of hits) byCategory.set(hit.category, (byCategory.get(hit.category) ?? 0) + 1);
console.log('by category (flags per 1,000 words)');
for (const [category, count] of [...byCategory].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${category.padEnd(13)} ${per1k(count).padStart(6)}   ${count}`);
}

const byRule = new Map<string, Hit[]>();
for (const hit of hits) byRule.set(hit.rule, [...(byRule.get(hit.rule) ?? []), hit]);
const ranked = [...byRule].sort((a, b) => b[1].length - a[1].length);

console.log('\ntop 25 rules by rate');
for (const [rule, list] of ranked.slice(0, 25)) {
  console.log(`  ${per1k(list.length).padStart(6)}  ${String(list.length).padStart(5)}  ${rule}`);
}

// Correctness rules claim an outright error, so each hit here is worth reading.
const correctness = hits.filter((hit) => hit.category === 'correctness');
console.log(`\ncorrectness flags: ${correctness.length} (${per1k(correctness.length)} per 1,000 words)`);
const byCorrectnessRule = new Map<string, Hit[]>();
for (const hit of correctness) byCorrectnessRule.set(hit.rule, [...(byCorrectnessRule.get(hit.rule) ?? []), hit]);
for (const [rule, list] of [...byCorrectnessRule].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n  ${rule}  (${list.length})`);
  for (const hit of list.slice(0, 6)) console.log(`    …${hit.context}…`);
}

// Samples for whichever rules were named on the command line.
for (const wanted of process.argv.slice(2)) {
  const list = hits.filter((hit) => hit.rule.startsWith(wanted));
  console.log(`\n=== ${wanted} — ${list.length} hits, showing 12 ===`);
  for (const hit of list.slice(0, 12)) console.log(`  [${hit.text}]  …${hit.context}…`);
}
