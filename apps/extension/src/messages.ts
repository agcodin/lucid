import type { FromWorker, ToWorker } from '@lucid/engine';

/** Content script to service worker, and on to the offscreen document. */
export interface Envelope {
  channel: 'lucid';
  /** Identifies the content script's port; replies are routed back by it. */
  payload: ToWorker;
}

export interface Reply {
  channel: 'lucid';
  payload: FromWorker;
}

export const PORT_NAME = 'lucid';
