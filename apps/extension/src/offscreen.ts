/**
 * Offscreen document. Holds the one Harper worker and fans its replies back to
 * whichever tab asked.
 *
 * The worker's block cache is keyed on text and shared across tabs on purpose:
 * the same signature or boilerplate paragraph open in two tabs is linted once.
 * Cancellation is not shared — each tab's traffic carries its own `source`, so
 * one tab's typing never abandons another tab's in-flight run.
 */
import type { FromWorker, ToWorker } from '@lucid/engine';

const worker = new Worker(chrome.runtime.getURL('harper.worker.js'), { type: 'module' });

/** Ports currently attached, so broadcast replies (`ready`, `error`) reach them all. */
const livePorts = new Set<number>();

worker.onmessage = (event: MessageEvent<FromWorker>) => {
  const message = event.data;
  // Lint replies carry the source that asked; status replies go to everyone.
  const targets = 'source' in message && message.source !== undefined
    ? [Number(message.source)]
    : [...livePorts];
  for (const portId of targets) {
    chrome.runtime.sendMessage({ channel: 'lucid-from-engine', portId, payload: message }).catch(() => undefined);
  }
};

chrome.runtime.onMessage.addListener((message: { channel?: string; portId?: number; payload?: ToWorker }) => {
  if (message.channel === 'lucid-release' && message.portId !== undefined) {
    livePorts.delete(message.portId);
    return;
  }
  if (message.channel !== 'lucid-to-engine' || message.portId === undefined || !message.payload) return;

  livePorts.add(message.portId);
  worker.postMessage(message.payload);
});
