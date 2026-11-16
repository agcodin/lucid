import { toBlocks } from './segment.js';
import { runRules } from './tiers/rules.js';
import { analyzeReadability } from './tiers/readability.js';
import { analyzeTone } from './tiers/tone.js';
import { PHRASE_RULE_COUNT } from './tiers/matcher.js';
import { DEFAULT_RULE_CONFIG } from './types.js';
import type { Block, Category, DocumentReport, Issue, RuleConfig } from './types.js';
import type { FromWorker, ToWorker } from './worker/protocol.js';

export interface EngineStats {
  /** Blocks in the document, and how many the last edit actually re-linted. */
  blocks: number;
  dirtyBlocks: number;
  /** Tier 0 wall time for the last edit, in milliseconds. */
  rulesMs: number;
  /** Tier 1 wall time for the last completed run. */
  harperMs: number;
  harperBlocksLinted: number;
  harperBlocksCached: number;
  /** Rules loaded, per tier. */
  phraseRules: number;
  harperRules: number;
  harperSetupMs: number;
  ready: boolean;
  /**
   * Set when the grammar worker failed. Tier 0 keeps working, so the editor
   * stays useful, but correctness checking is gone and the UI has to say so
   * rather than show a spinner forever.
   */
  error?: string;
}

export interface EngineState {
  issues: Issue[];
  report: DocumentReport;
  stats: EngineStats;
}

export interface LucidOptions {
  /** Worker running `harper.worker.ts`. Omit to run with tier 0 only. */
  worker?: Worker;
  /**
   * Quiet period before tier 1 runs. 120ms sits below the ~150ms at which a
   * pause stops feeling like typing, while still coalescing a fast typist's
   * keystrokes into one run.
   */
  debounceMs?: number;
  onUpdate: (state: EngineState) => void;
  /**
   * Labels this instance's traffic when the worker is shared with other
   * clients, as it is in the extension. Leave unset for a dedicated worker.
   */
  source?: string;
}

/**
 * How long to wait for a frame before flushing anyway. Comfortably longer than
 * a 60Hz frame, so a visible tab always coalesces on the frame instead.
 */
const BACKGROUND_FLUSH_MS = 50;

/** One block's worth of state, matched across edits by content hash. */
interface Slot {
  block: Block;
  rules: Issue[];
  harper: Issue[];
  /** False until tier 1 has reported for this block's current text. */
  harperFresh: boolean;
}

export class Lucid {
  private readonly worker?: Worker;
  private readonly debounceMs: number;
  private readonly onUpdate: (state: EngineState) => void;
  private readonly source: string | undefined;

  private text = '';
  private slots: Slot[] = [];
  private dismissed = new Set<string>();
  private ruleConfig: RuleConfig = DEFAULT_RULE_CONFIG;
  private dictionary: string[] = [];

  private gen = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private idleHandle: number | undefined;
  private disposed = false;
  private emitScheduled = false;
  private emitFrame: number | undefined;
  private emitTimer: ReturnType<typeof setTimeout> | undefined;

  private report: DocumentReport = emptyReport();
  private stats: EngineStats = {
    blocks: 0, dirtyBlocks: 0, rulesMs: 0, harperMs: 0,
    harperBlocksLinted: 0, harperBlocksCached: 0,
    phraseRules: PHRASE_RULE_COUNT, harperRules: 0, harperSetupMs: 0, ready: false,
  };

  constructor(options: LucidOptions) {
    this.worker = options.worker;
    this.debounceMs = options.debounceMs ?? 120;
    this.onUpdate = options.onUpdate;
    this.source = options.source;

    if (this.worker) {
      this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.onWorkerMessage(event.data);
      this.send({ type: 'init', dialect: 0 });
    }
  }

  /**
   * Feed the current document text. Safe to call on every keystroke: tier 0
   * runs only on blocks whose text changed, and tier 1 is debounced and
   * generation-stamped so superseded runs abandon themselves.
   */
  setText(text: string): void {
    if (this.disposed || text === this.text) return;
    this.text = text;

    const blocks = toBlocks(text);
    const t0 = now();
    const { slots, dirty } = this.matchSlots(blocks);
    this.slots = slots;
    this.stats.rulesMs = round(now() - t0);
    this.stats.blocks = blocks.length;
    this.stats.dirtyBlocks = dirty.length;

    this.emit();
    this.scheduleHarper(dirty);
    this.scheduleAnalysis();
  }

  /**
   * Match new blocks against the previous edit's slots by content hash, so an
   * unchanged paragraph keeps its issues and a moved one only gets re-anchored.
   * Blocks with no match are dirty and get tier 0 run on them now.
   */
  private matchSlots(blocks: Block[]): { slots: Slot[]; dirty: Block[] } {
    const available = new Map<string, Slot[]>();
    for (const slot of this.slots) {
      const bucket = available.get(slot.block.hash);
      if (bucket) bucket.push(slot);
      else available.set(slot.block.hash, [slot]);
    }

    const slots: Slot[] = [];
    const dirty: Block[] = [];

    for (const block of blocks) {
      const reusable = available.get(block.hash)?.shift();
      if (reusable) {
        const delta = block.start - reusable.block.start;
        slots.push({
          block,
          rules: delta === 0 ? reusable.rules : shift(reusable.rules, delta),
          harper: delta === 0 ? reusable.harper : shift(reusable.harper, delta),
          harperFresh: reusable.harperFresh,
        });
        continue;
      }
      slots.push({ block, rules: runRules(block), harper: [], harperFresh: false });
      dirty.push(block);
    }

    return { slots, dirty };
  }

  private scheduleHarper(dirty: Block[]): void {
    if (!this.worker) return;
    const stale = this.slots.filter((slot) => !slot.harperFresh).map((slot) => slot.block);
    if (stale.length === 0) return;

    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.gen++;
      // Blocks the user just touched go first, so the paragraph under the
      // cursor gets its underlines before the rest of the document catches up.
      const dirtyHashes = new Set(dirty.map((block) => block.hash));
      const ordered = [
        ...stale.filter((block) => dirtyHashes.has(block.hash)),
        ...stale.filter((block) => !dirtyHashes.has(block.hash)),
      ];
      this.send({
        type: 'lint',
        gen: this.gen,
        source: this.source,
        blocks: ordered.map((block) => ({ start: block.start, text: block.text, hash: block.hash })),
      });
    }, this.debounceMs);
  }

  /** Document-wide metrics are never in the typing path; they wait for idle. */
  private scheduleAnalysis(): void {
    if (this.idleHandle !== undefined) cancelIdle(this.idleHandle);
    this.idleHandle = requestIdle(() => {
      this.idleHandle = undefined;
      this.report = {
        readability: analyzeReadability(this.text),
        tone: analyzeTone(this.text),
        counts: this.countByCategory(),
        score: 0,
      };
      this.report.score = scoreOf(this.report.counts, this.report.readability.words);
      this.emit();
    });
  }

  private onWorkerMessage(message: FromWorker): void {
    if (this.disposed) return; // A reply that outlived the caller's UI.
    switch (message.type) {
      case 'ready':
        this.stats.ready = true;
        this.stats.error = undefined; // A retry succeeded.
        this.stats.harperRules = message.rules;
        this.stats.harperSetupMs = message.setupMs;
        this.emit();
        break;

      case 'blockLints': {
        if (message.gen !== this.gen) return; // Superseded by a newer edit.
        const slot = this.slots.find((candidate) => candidate.block.hash === message.blockHash && !candidate.harperFresh);
        if (!slot) return;
        slot.harper = message.issues;
        slot.harperFresh = true;
        this.emit();
        break;
      }

      case 'lintDone':
        if (message.gen !== this.gen) return;
        this.stats.harperMs = message.ms;
        this.stats.harperBlocksLinted = message.blocksLinted;
        this.stats.harperBlocksCached = message.blocksCached;
        this.emit();
        break;

      case 'error':
        console.error('[lucid] worker:', message.message);
        this.stats.error = message.message;
        this.emit();
        break;
    }
  }

  /** Every issue in the document, in reading order, dismissals removed. */
  get issues(): Issue[] {
    const out: Issue[] = [];
    for (const slot of this.slots) {
      for (const issue of slot.rules) if (this.shows(issue)) out.push(issue);
      for (const issue of slot.harper) if (this.shows(issue)) out.push(issue);
    }
    out.sort((a, b) => a.start - b.start || b.end - a.end);
    return dedupeCorrectness(out);
  }

  private shows(issue: Issue): boolean {
    return !this.isDismissed(issue) && !this.isMuted(issue);
  }

  private isDismissed(issue: Issue): boolean {
    return issue.dismissHash !== undefined && this.dismissed.has(issue.dismissHash);
  }

  /** True when the user has switched this issue's category or rule off. */
  private isMuted(issue: Issue): boolean {
    if (!this.ruleConfig.categories[issue.category]) return true;
    return this.ruleConfig.disabledRules.some((disabled) => matchesRule(issue.rule, disabled));
  }

  /**
   * Choose which suggestions to show. This filters issues already found rather
   * than re-running the tiers, so a toggle is instant and no linting repeats.
   */
  setRuleConfig(config: RuleConfig): void {
    this.ruleConfig = config;
    this.emit();
  }

  getRuleConfig(): RuleConfig {
    return this.ruleConfig;
  }

  /** Hide this issue, and future identical ones, for the rest of the session. */
  dismiss(issue: Issue): void {
    if (issue.dismissHash === undefined) return;
    this.dismissed.add(issue.dismissHash);
    this.send({ type: 'ignoreHash', hash: issue.dismissHash });
    this.emit();
  }

  /**
   * Teach the spell checker a word, and re-lint everything that mentioned it.
   *
   * The list is kept here rather than only in the worker so the UI can show it
   * and take entries back out. A word added by mistake is otherwise invisible
   * and permanent.
   */
  addToDictionary(word: string): void {
    const clean = word.trim();
    if (clean.length === 0 || this.dictionary.includes(clean)) return;
    this.setDictionary([...this.dictionary, clean]);
  }

  removeFromDictionary(word: string): void {
    this.setDictionary(this.dictionary.filter((entry) => entry !== word));
  }

  /** Replace the whole custom dictionary and re-lint against it. */
  setDictionary(words: string[]): void {
    this.dictionary = [...new Set(words)].sort((a, b) => a.localeCompare(b));
    this.send({ type: 'setWords', words: this.dictionary });
    for (const slot of this.slots) slot.harperFresh = false;
    this.scheduleHarper(this.slots.map((slot) => slot.block));
    this.emit();
  }

  getDictionary(): string[] {
    return [...this.dictionary];
  }

  setHarperConfig(config: Record<string, boolean | null>): void {
    this.send({ type: 'setConfig', config });
    for (const slot of this.slots) slot.harperFresh = false;
    this.scheduleHarper(this.slots.map((slot) => slot.block));
  }

  /** Count by category over an already-built list, so `issues` is walked once. */
  private countByCategory(issues: Issue[] = this.issues): Record<Category, number> {
    const counts: Record<Category, number> = { correctness: 0, clarity: 0, engagement: 0, delivery: 0 };
    for (const issue of issues) counts[issue.category]++;
    return counts;
  }

  /**
   * Coalesce updates to one per frame. Tier 1 reports a block at a time, so a
   * first load of a long document would otherwise fire `onUpdate` once per
   * block — and since each one rebuilds every Range and re-renders the whole
   * sidebar, that is quadratic in block count.
   *
   * A frame callback alone is not enough: in a background tab the browser stops
   * firing them, which would leave results stranded until the tab is focused
   * again. The timer races the frame so work still lands when nothing is being
   * painted, and whichever fires first cancels the other.
   */
  private emit(): void {
    if (this.disposed || this.emitScheduled) return;
    this.emitScheduled = true;

    const flush = (): void => {
      if (!this.emitScheduled) return;
      this.emitScheduled = false;
      if (this.emitFrame !== undefined) cancelFrame(this.emitFrame);
      if (this.emitTimer !== undefined) clearTimeout(this.emitTimer);
      this.emitFrame = undefined;
      this.emitTimer = undefined;

      // Build the list once: the getter filters and sorts, which is not free
      // on a long document, and emit runs on every frame that has changes.
      const issues = this.issues;
      this.report.counts = this.countByCategory(issues);
      this.onUpdate({ issues, report: this.report, stats: { ...this.stats } });
    };

    this.emitFrame = requestFrame(flush);
    this.emitTimer = setTimeout(flush, BACKGROUND_FLUSH_MS);
  }

  private send(message: ToWorker): void {
    // `dispose` and `release` are the one pair allowed through, since they are
    // what announces the teardown.
    if (this.disposed && message.type !== 'dispose' && message.type !== 'release') return;
    this.worker?.postMessage(message);
  }

  /**
   * Stop this engine and let go of the worker.
   *
   * Two things matter here. Late replies must not reach `onUpdate` after the
   * caller has torn its UI down, or a destroyed attachment keeps rendering over
   * a live one. And a client that shares the worker must not send the global
   * teardown, which would dispose the linter and clear the block cache for
   * every other client — in the extension that is every other tab, each then
   * reloading 20MB of WebAssembly.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    if (this.idleHandle !== undefined) cancelIdle(this.idleHandle);
    if (this.emitFrame !== undefined) cancelFrame(this.emitFrame);
    if (this.emitTimer !== undefined) clearTimeout(this.emitTimer);

    // A source means the worker serves several clients, so only this client's
    // state is released.
    this.send(this.source === undefined ? { type: 'dispose' } : { type: 'release', source: this.source });
  }
}

/**
 * Replace `issue`'s span in `text`, returning the new text and the offset to
 * put the caret at.
 *
 * Two tidy-ups the raw replacement cannot do on its own: a deletion would
 * otherwise leave a doubled space or a space before punctuation, and a
 * replacement at the start of a sentence has to keep its capital.
 */
export interface TextEdit {
  /** The span to replace, after whitespace and capitalization adjustment. */
  start: number;
  end: number;
  /** What to put there. */
  insert: string;
  /** The whole document after the edit, for callers that want it. */
  text: string;
  /** Where the caret belongs afterwards. */
  cursor: number;
}

export function applyReplacement(text: string, issue: Issue, replacementText: string): TextEdit {
  let start = issue.start;
  let end = issue.end;
  let insert = replacementText;

  if (insert === '') {
    const prev = prevNonSpace(text, start);

    if (text[prev] === ',' && text[end] === ',') {
      // A comma-bounded parenthetical: both commas belong to the phrase being
      // cut, so "It was, in my opinion, fine." loses all of ", in my opinion,".
      start = prev;
      end += 1;
    } else if (text[end] === ',' && prev < 0) {
      // Leads the sentence, as in "In my opinion, this works." Take its comma.
      end += 1;
    }

    // Collapse the whitespace the removal would otherwise double up.
    if (text[end] === ' ' && (start === 0 || text[start - 1] === ' ' || text[start - 1] === undefined)) end++;
    else if (text[start - 1] === ' ' && /[\s.,;:!?]/.test(text[end] ?? '')) start--;
  }

  // A span that begins a sentence hands its capital to whatever replaces it.
  if (startsSentence(text, start)) {
    if (insert === '') {
      const rest = text.slice(end);
      const match = /^(\s*)([a-z])/.exec(rest);
      if (match) {
        // Swallow the whitespace too and re-capitalize the next word, so the
        // edit stays a single contiguous replacement.
        const at = end + match[1]!.length;
        const capitalized = match[2]!.toUpperCase();
        return {
          start,
          end: at + 1,
          insert: text.slice(end, at) + capitalized,
          text: text.slice(0, start) + text.slice(end, at) + capitalized + text.slice(at + 1),
          cursor: start,
        };
      }
    } else if (/^[a-z]/.test(insert)) {
      insert = insert[0]!.toUpperCase() + insert.slice(1);
    }
  }

  return {
    start,
    end,
    insert,
    text: text.slice(0, start) + insert + text.slice(end),
    cursor: start + insert.length,
  };
}

/**
 * Whether `rule` is `disabled` or sits under it.
 *
 * Rule names separate their parts with either character, as in
 * `clarity:wordy/in-order-to` and `clarity:sentence-long`, so a prefix has to
 * accept both. Matching on the prefix alone would make `clarity:passive` also
 * silence a future `clarity:passiveness`, and requiring a slash left the
 * hyphenated families unreachable, which made two of the rule toggles inert.
 */
function matchesRule(rule: string, disabled: string): boolean {
  if (rule === disabled) return true;
  if (!rule.startsWith(disabled)) return false;
  const boundary = rule[disabled.length];
  return boundary === '/' || boundary === '-';
}

/**
 * Drop correctness issues that overlap one already kept.
 *
 * The rule tier covers errors Harper's dictionary lets through, and the two
 * sometimes find the same one: "They is" draws both a `confusion:be-agreement`
 * over the pair and a `harper:Agreement` over the verb. Those are one mistake
 * and belong in one card.
 *
 * Only correctness is deduped. An overlap in the other categories is usually
 * two different observations about the same words, such as a wordy phrase
 * inside a sentence that is also too long, and both are worth showing.
 */
function dedupeCorrectness(issues: Issue[]): Issue[] {
  const out: Issue[] = [];
  let lastEnd = -1;

  for (const issue of issues) {
    if (issue.category !== 'correctness') {
      out.push(issue);
      continue;
    }
    if (issue.start < lastEnd) continue; // Covered by one already kept.
    out.push(issue);
    lastEnd = issue.end;
  }
  return out;
}

/** Index of the last non-space character before `offset`, or -1 if there is none. */
function prevNonSpace(text: string, offset: number): number {
  for (let i = offset - 1; i >= 0; i--) {
    if (text[i] !== ' ' && text[i] !== '\t') return i;
  }
  return -1;
}

/** True when `offset` is the first character of a sentence or of the document. */
function startsSentence(text: string, offset: number): boolean {
  for (let i = offset - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t') continue;
    if (ch === '\n') return true;
    return ch === '.' || ch === '!' || ch === '?';
  }
  return true; // Nothing but whitespace before it: the start of the document.
}

function shift(issues: Issue[], delta: number): Issue[] {
  return issues.map((issue) => ({ ...issue, start: issue.start + delta, end: issue.end + delta }));
}

/**
 * A 0-100 writing score. Weighted by category, normalized against length so a
 * long document is not punished for having more words to be wrong in.
 */
function scoreOf(counts: Record<Category, number>, words: number): number {
  if (words === 0) return 100;
  const weighted =
    counts.correctness * 1.0 + counts.clarity * 0.6 + counts.engagement * 0.4 + counts.delivery * 0.4;
  const per100 = (weighted / words) * 100;
  return Math.max(0, Math.min(100, Math.round(100 - per100 * 7)));
}

function emptyReport(): DocumentReport {
  return {
    readability: {
      flesch: 100, grade: 0, words: 0, sentences: 0,
      avgSentenceLength: 0, complexWordRatio: 0, passiveRatio: 0, readingSeconds: 0,
    },
    tone: { labels: [{ label: 'neutral', strength: 1 }], formality: 0.5, confidence: 0.5 },
    counts: { correctness: 0, clarity: 0, engagement: 0, delivery: 0 },
    score: 100,
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** requestAnimationFrame, with a timer fallback for non-DOM hosts such as tests. */
function requestFrame(fn: () => void): number {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
  return raf ? raf(fn) : (setTimeout(fn, 16) as unknown as number);
}

function cancelFrame(handle: number): void {
  const caf = (globalThis as { cancelAnimationFrame?: (h: number) => void }).cancelAnimationFrame;
  if (caf) caf(handle);
  else clearTimeout(handle);
}

/** requestIdleCallback with a timer fallback, since Safari only shipped it recently. */
function requestIdle(fn: () => void): number {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) return ric(fn, { timeout: 600 });
  return setTimeout(fn, 200) as unknown as number;
}

function cancelIdle(handle: number): void {
  const cic = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
  if (cic) cic(handle);
  else clearTimeout(handle);
}
