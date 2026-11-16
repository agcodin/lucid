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

/**
 * Each corpus is a genre. Encyclopedic prose uses passive voice and long
 * sentences far more than technical documentation does, so a rule's rate only
 * means something next to the genre it was measured on. MDN is the sharper
 * test of the two, since its style guide asks for active voice and plain
 * wording, which is what the clarity rules claim to look for.
 */
const CORPORA: { name: string; dir: URL }[] = [
  { name: 'wikipedia', dir: new URL('./text/', import.meta.url) },
  { name: 'mdn docs', dir: new URL('./mdn/', import.meta.url) },
];

interface Hit {
  rule: string;
  category: Category;
  corpus: string;
  text: string;
  context: string;
}

const hits: Hit[] = [];
const wordsPer = new Map<string, number>();
let words = 0;
let fileCount = 0;

for (const corpus of CORPORA) {
  let files: string[] = [];
  try {
    files = (await readdir(corpus.dir)).filter((name) => name.endsWith('.txt'));
  } catch {
    continue; // Not fetched yet.
  }
  fileCount += files.length;

  for (const file of files) {
    const text = await readFile(new URL(file, corpus.dir), 'utf8');
    const count = text.split(/\s+/).filter(Boolean).length;
    words += count;
    wordsPer.set(corpus.name, (wordsPer.get(corpus.name) ?? 0) + count);

    for (const block of toBlocks(text)) {
      for (const issue of runRules(block) as Issue[]) {
        hits.push({
          rule: issue.rule,
          category: issue.category,
          corpus: corpus.name,
          text: text.slice(issue.start, issue.end).replace(/\s+/g, ' '),
          context: text.slice(Math.max(0, issue.start - 45), issue.end + 45).replace(/\s+/g, ' '),
        });
      }
    }
  }
}

if (words === 0) {
  console.error('No corpus. Run: node corpus/fetch.mjs && node corpus/fetch-mdn.mjs');
  process.exit(1);
}

const per1k = (n: number): string => ((n / words) * 1000).toFixed(2);

console.log(`corpus: ${words.toLocaleString()} words in ${fileCount} files`);
console.log(`flags:  ${hits.length.toLocaleString()} (${per1k(hits.length)} per 1,000 words)\n`);

const byCategory = new Map<Category, number>();
for (const hit of hits) byCategory.set(hit.category, (byCategory.get(hit.category) ?? 0) + 1);
console.log('by category (flags per 1,000 words)');
for (const [category, count] of [...byCategory].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${category.padEnd(13)} ${per1k(count).padStart(6)}   ${count}`);
}

// Side by side, so a rule that only fires in one register is visible as such.
console.log('\nper 1,000 words, by genre');
const names = [...wordsPer.keys()];
console.log(`  ${'rule'.padEnd(34)}${names.map((n) => n.padStart(12)).join('')}`);
const perGenre = new Map<string, Map<string, number>>();
for (const hit of hits) {
  const row = perGenre.get(hit.rule) ?? new Map<string, number>();
  row.set(hit.corpus, (row.get(hit.corpus) ?? 0) + 1);
  perGenre.set(hit.rule, row);
}
const family = (rule: string): string => rule.split('/')[0]!;
const byFamily = new Map<string, Map<string, number>>();
for (const [rule, row] of perGenre) {
  const target = byFamily.get(family(rule)) ?? new Map<string, number>();
  for (const [corpus, n] of row) target.set(corpus, (target.get(corpus) ?? 0) + n);
  byFamily.set(family(rule), target);
}
const rankedFamilies = [...byFamily].sort((a, b) =>
  [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0));
for (const [rule, row] of rankedFamilies.slice(0, 16)) {
  const cells = names.map((name) => {
    const n = row.get(name) ?? 0;
    const total = wordsPer.get(name) ?? 1;
    return ((n / total) * 1000).toFixed(2).padStart(12);
  });
  console.log(`  ${rule.padEnd(34)}${cells.join('')}`);
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
