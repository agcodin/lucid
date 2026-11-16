import type { Issue } from '../types.js';

/** Plain-object block, safe to post across the worker boundary. */
export interface BlockRequest {
  start: number;
  text: string;
  hash: string;
}

/**
 * Identifies the client a message belongs to. One worker serves several
 * clients in the extension (one per tab), and each needs its own cancellation
 * generation — otherwise a newer edit in one tab would abandon another tab's
 * in-flight run. Absent means the single-client case.
 */
export type Source = string;

export type ToWorker =
  | { type: 'init'; dialect: number }
  /**
   * Lint these blocks, in order. `gen` stamps the edit that produced them;
   * the worker abandons a run as soon as a newer `gen` arrives, which is what
   * keeps a fast typist from queueing work behind themselves.
   */
  | { type: 'lint'; gen: number; blocks: BlockRequest[]; source?: Source }
  | { type: 'setConfig'; config: Record<string, boolean | null> }
  | { type: 'getConfig' }
  | { type: 'addWords'; words: string[] }
  /** Replace the custom dictionary outright, so a word can be taken back out. */
  | { type: 'setWords'; words: string[] }
  | { type: 'ignoreHash'; hash: string }
  /**
   * Drop one client's state. Sent instead of `dispose` when the worker is
   * shared, because tearing the linter down would take it from every other
   * client too.
   */
  | { type: 'release'; source: Source }
  | { type: 'dispose' };

export type FromWorker =
  | { type: 'ready'; rules: number; setupMs: number }
  /** One message per block, posted as each finishes so the UI paints early. */
  | { type: 'blockLints'; gen: number; blockHash: string; issues: Issue[]; ms: number; source?: Source }
  /** All blocks for this generation are done. */
  | { type: 'lintDone'; gen: number; ms: number; blocksLinted: number; blocksCached: number; source?: Source }
  | { type: 'config'; config: Record<string, boolean | null> }
  | { type: 'error'; message: string };
