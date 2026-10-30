/**
 * Verifies the extension's offset mapping against markup shaped like a real
 * editor's: nested inline elements, a list, a blockquote, and a hidden node.
 * The rules engine runs locally; only Harper is skipped, since this checks the
 * DOM mapping rather than the linting.
 */
import { toBlocks, runRules } from '@lucid/engine';
import type { Issue } from '@lucid/engine';
import { buildTextIndex, rangeFor } from '../../extension/src/textindex.js';

const host = document.querySelector<HTMLElement>('#ce')!;
const out = document.querySelector<HTMLElement>('#out')!;

const index = buildTextIndex(host);
const issues: Issue[] = toBlocks(index.text).flatMap((block) => runRules(block));

for (const category of ['correctness', 'clarity', 'engagement', 'delivery'] as const) {
  CSS.highlights.set(`lucid-${category}`, new Highlight());
}

const lines: string[] = [];
let mapped = 0;
let mismatched = 0;

for (const issue of issues) {
  const range = rangeFor(index, issue.start, issue.end);
  if (!range) { lines.push(`UNMAPPED  ${issue.rule}`); continue; }
  CSS.highlights.get(`lucid-${issue.category}`)!.add(range);

  // The real check: does the Range the browser resolves contain exactly the
  // text the engine thought it had flagged?
  const expected = index.text.slice(issue.start, issue.end);
  const actual = range.toString();
  mapped++;
  if (expected !== actual) {
    mismatched++;
    lines.push(`MISMATCH  ${issue.rule}\n  engine: ${JSON.stringify(expected)}\n  range:  ${JSON.stringify(actual)}`);
  }
}

const hiddenLeaked = index.text.includes('hidden and must not');

out.textContent = [
  `text indexed:     ${index.text.length} chars across ${index.nodes.length} text nodes`,
  `blocks:           ${toBlocks(index.text).length}`,
  `issues found:     ${issues.length}`,
  `ranges mapped:    ${mapped}`,
  `offset mismatches: ${mismatched}`,
  `hidden text leaked: ${hiddenLeaked}`,
  '',
  mismatched === 0 && !hiddenLeaked && mapped === issues.length
    ? 'PASS — every issue maps to a Range containing exactly the flagged text'
    : 'FAIL',
  '',
  ...lines,
].join('\n');

(window as unknown as Record<string, unknown>).__testbed = { index, issues, mapped, mismatched };
