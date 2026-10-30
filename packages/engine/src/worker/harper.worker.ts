/// <reference lib="webworker" />
import { LocalLinter, Dialect, type Lint } from 'harper.js';
import { binary } from 'harper.js/binary';
import { hash } from '../hash.js';
import { categoryOfLintKind } from '../tiers/harper-kinds.js';
import type { Issue } from '../types.js';
import type { BlockRequest, FromWorker, Source, ToWorker } from './protocol.js';

let linter: LocalLinter | undefined;
let ready: Promise<void> | undefined;

/**
 * Block hash to its issues. Harper is deterministic for a given config, so an
 * unchanged paragraph never needs linting twice — this is what makes editing
 * the last paragraph of a long document cost the same as editing a short one.
 */
const cache = new Map<string, Issue[]>();
const CACHE_LIMIT = 2000;

/**
 * Newest generation seen per client. A run abandons itself as soon as its own
 * client sends a newer one; another client's traffic never cancels it.
 */
const currentGen = new Map<Source, number>();

function isCurrent(source: Source, gen: number): boolean {
  return currentGen.get(source) === gen;
}

/** Dismissal hashes, applied here so dismissed issues never cross the boundary. */
const ignored = new Set<string>();

function post(message: FromWorker): void {
  (self as unknown as Worker).postMessage(message);
}

function setup(dialect: number): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const t0 = performance.now();
    linter = new LocalLinter({ binary, dialect: dialect as Dialect });
    await linter.setup();
    const config = await linter.getLintConfig();
    post({ type: 'ready', rules: Object.keys(config).length, setupMs: Math.round(performance.now() - t0) });
  })();
  return ready;
}

/** Convert one WASM-backed Lint into a plain, postable Issue. */
function toIssue(lint: Lint, block: BlockRequest): Issue {
  const span = lint.span();
  const kind = lint.lint_kind();
  const problem = lint.get_problem_text();

  const replacements = lint.suggestions().map((suggestion) => {
    const text = suggestion.get_replacement_text();
    // SuggestionKind: 0 Replace, 1 Remove, 2 InsertAfter.
    const insertAfter = suggestion.kind() === 2;
    return {
      text: insertAfter ? problem + text : text,
      label: text === '' ? 'Remove' : undefined,
    };
  });

  return {
    id: `h:${block.hash}:${span.start}:${kind}`,
    category: categoryOfLintKind(kind),
    tier: 'harper',
    rule: `harper:${kind}`,
    start: block.start + span.start,
    end: block.start + span.end,
    title: lint.message(),
    detail: lint.lint_kind_pretty(),
    replacements,
    dismissHash: hash(`harper:${kind}|${problem.toLowerCase()}`),
  };
}

/**
 * Re-anchor cached issues onto a block's current absolute offset. The cache is
 * keyed on text, so the same paragraph moved down the document reuses its
 * issues with no linting at all.
 */
function reanchor(issues: Issue[], block: BlockRequest, cachedStart: number): Issue[] {
  const delta = block.start - cachedStart;
  if (delta === 0) return issues;
  return issues.map((issue) => ({ ...issue, start: issue.start + delta, end: issue.end + delta }));
}

/** Absolute start the cached issues for a hash were computed against. */
const cacheOrigin = new Map<string, number>();

async function lintBlocks(gen: number, blocks: BlockRequest[], source: Source): Promise<void> {
  await setup(Dialect.American);
  if (!linter || !isCurrent(source, gen)) return;

  const t0 = performance.now();
  let linted = 0;
  let cached = 0;

  for (const block of blocks) {
    // A newer edit landed. Abandon the rest of this run rather than finishing
    // work whose results are already stale.
    if (!isCurrent(source, gen)) return;

    const hit = cache.get(block.hash);
    let issues: Issue[];

    if (hit) {
      issues = reanchor(hit, block, cacheOrigin.get(block.hash) ?? block.start);
      cached++;
    } else {
      const lints = await linter.lint(block.text, { language: 'plaintext', dedup: true });
      if (!isCurrent(source, gen)) return;
      issues = lints.map((lint) => toIssue(lint, block));
      if (cache.size >= CACHE_LIMIT) {
        // Drop the oldest third rather than one entry, so eviction is amortized.
        const drop = [...cache.keys()].slice(0, Math.floor(CACHE_LIMIT / 3));
        for (const key of drop) { cache.delete(key); cacheOrigin.delete(key); }
      }
      cache.set(block.hash, issues);
      cacheOrigin.set(block.hash, block.start);
      linted++;
    }

    const visible = issues.filter((issue) => !issue.dismissHash || !ignored.has(issue.dismissHash));
    post({
      type: 'blockLints',
      gen,
      source,
      blockHash: block.hash,
      issues: visible,
      ms: Math.round((performance.now() - t0) * 10) / 10,
    });
  }

  post({
    type: 'lintDone',
    gen,
    source,
    ms: Math.round((performance.now() - t0) * 10) / 10,
    blocksLinted: linted,
    blocksCached: cached,
  });
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'init':
        await setup(message.dialect);
        break;

      case 'lint': {
        const source = message.source ?? '';
        currentGen.set(source, message.gen);
        await lintBlocks(message.gen, message.blocks, source);
        break;
      }

      case 'setConfig':
        await setup(Dialect.American);
        await linter!.setLintConfig(message.config);
        // Config changes invalidate everything the old config produced.
        cache.clear();
        cacheOrigin.clear();
        break;

      case 'getConfig': {
        await setup(Dialect.American);
        post({ type: 'config', config: await linter!.getLintConfig() });
        break;
      }

      case 'addWords':
        await setup(Dialect.American);
        await linter!.importWords(message.words);
        cache.clear();
        cacheOrigin.clear();
        break;

      case 'ignoreHash':
        ignored.add(message.hash);
        break;

      case 'dispose':
        await linter?.dispose();
        linter = undefined;
        ready = undefined;
        cache.clear();
        cacheOrigin.clear();
        break;
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
