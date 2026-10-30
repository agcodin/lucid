/**
 * Service worker. Owns exactly one offscreen document, which hosts the single
 * Harper worker for the whole browser, and routes each tab's port through it.
 *
 * The alternative — a WASM instance per tab — is what makes a checker extension
 * expensive to leave installed. Harper's binary is ~20MB; paying for it once
 * per browser rather than once per tab is the difference between tens of
 * megabytes and gigabytes across a working set of tabs.
 */
import { PORT_NAME } from './messages.js';

const OFFSCREEN_PATH = 'offscreen.html';
let creating: Promise<void> | undefined;

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) return;

  // Concurrent ports would otherwise race to create a second document, which
  // the API rejects.
  if (creating) return creating;
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Runs the Harper grammar engine in one shared WebAssembly worker.',
    })
    .finally(() => { creating = undefined; });
  return creating;
}

/** Ports from content scripts, keyed by an id the offscreen document echoes back. */
const ports = new Map<number, chrome.runtime.Port>();
let nextPortId = 1;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  const id = nextPortId++;
  ports.set(id, port);

  port.onMessage.addListener(async (message: { type?: string }) => {
    await ensureOffscreen();
    // Stamp the port id as the engine `source`, so the worker tracks this tab's
    // cancellation generation separately from every other tab's.
    const payload = message.type === 'lint' ? { ...message, source: String(id) } : message;
    chrome.runtime.sendMessage({ channel: 'lucid-to-engine', portId: id, payload }).catch(() => undefined);
  });

  port.onDisconnect.addListener(() => {
    ports.delete(id);
    chrome.runtime.sendMessage({ channel: 'lucid-release', portId: id }).catch(() => undefined);
  });

  void ensureOffscreen();
});

// Replies from the offscreen document, addressed back to the tab that asked.
chrome.runtime.onMessage.addListener((message: { channel?: string; portId?: number; payload?: unknown }) => {
  if (message.channel !== 'lucid-from-engine' || message.portId === undefined) return;
  const port = ports.get(message.portId);
  // The tab may have navigated away while a lint was in flight.
  try { port?.postMessage(message.payload); } catch { ports.delete(message.portId); }
});
