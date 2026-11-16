/**
 * A stand-in for the Chrome extension APIs, enough to run the real background
 * and offscreen modules in Node.
 *
 * The routing between content script, service worker and offscreen document is
 * the part of the extension that typechecking cannot verify and that is easy to
 * get wrong: a reply delivered to the wrong tab, or one tab's edit cancelling
 * another tab's in-flight lint. This models it closely enough to catch both.
 */

type Listener = (message: never) => void;

export interface StubPort {
  name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (message: never) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

/** Which extension context a listener belongs to. sendMessage skips its own. */
export type Context = 'background' | 'offscreen';

export class ChromeStub {
  /** URLs passed to offscreen.createDocument, to assert there is only one. */
  readonly offscreenCreated: string[] = [];

  private readonly connectListeners: ((port: StubPort) => void)[] = [];
  private readonly messageListeners: { context: Context; fn: Listener }[] = [];
  private registering: Context = 'background';
  private sending: Context = 'background';

  /** Listeners registered after this call belong to `context`. */
  as(context: Context): void {
    this.registering = context;
    this.sending = context;
  }

  /** Open a port the way a content script does; returns the content-script end. */
  connect(name = 'lucid'): StubPort {
    const toBackground: Listener[] = [];
    const toContent: Listener[] = [];
    const onDisconnect: (() => void)[] = [];

    const contentEnd: StubPort = {
      name,
      postMessage: (message) => { for (const fn of toBackground) fn(message as never); },
      disconnect: () => { for (const fn of onDisconnect) fn(); },
      onMessage: { addListener: (fn) => { toContent.push(fn as Listener); } },
      onDisconnect: { addListener: () => undefined },
    };
    const backgroundEnd: StubPort = {
      name,
      postMessage: (message) => { for (const fn of toContent) fn(message as never); },
      disconnect: () => { for (const fn of onDisconnect) fn(); },
      onMessage: { addListener: (fn) => { toBackground.push(fn as Listener); } },
      onDisconnect: { addListener: (fn) => { onDisconnect.push(fn); } },
    };

    // onConnect fires asynchronously, as it does in the browser.
    queueMicrotask(() => { for (const fn of this.connectListeners) fn(backgroundEnd); });
    return contentEnd;
  }

  install(): void {
    const stub = this;
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        connect: (options: { name: string }) => stub.connect(options.name),
        onConnect: { addListener: (fn: (port: StubPort) => void) => { stub.connectListeners.push(fn); } },
        onMessage: {
          addListener: (fn: Listener) => { stub.messageListeners.push({ context: stub.registering, fn }); },
        },
        sendMessage: async (message: unknown) => {
          const from = stub.sending;
          // Chrome does not deliver a context its own sendMessage.
          for (const entry of [...stub.messageListeners]) {
            if (entry.context !== from) entry.fn(message as never);
          }
        },
        getContexts: async () =>
          stub.offscreenCreated.map((url) => ({ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: url })),
        getURL: (path: string) => `chrome-extension://stub/${path}`,
        ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      },
      offscreen: {
        Reason: { WORKERS: 'WORKERS' },
        createDocument: async (options: { url: string }) => { stub.offscreenCreated.push(options.url); },
      },
    };
  }
}

/** Stand-in for the Harper worker, recording what the offscreen document sends. */
export class StubWorker {
  static latest: StubWorker | undefined;

  onmessage: ((event: { data: unknown }) => void) | null = null;
  /** Every lint request the worker received, in order. */
  readonly requests: { gen: number; source?: string; blocks: { text: string; hash: string; start: number }[] }[] = [];

  constructor() {
    StubWorker.latest = this;
  }

  postMessage(message: { type: string; gen?: number; source?: string; blocks?: { text: string; hash: string; start: number }[] }): void {
    if (message.type !== 'lint') return;
    this.requests.push({ gen: message.gen!, source: message.source, blocks: message.blocks! });
  }

  /** Reply as the real worker would, stamped with the source that asked. */
  replyTo(request: { gen: number; source?: string; blocks: { hash: string; start: number }[] }): void {
    for (const block of request.blocks) {
      this.onmessage?.({
        data: {
          type: 'blockLints',
          gen: request.gen,
          source: request.source,
          blockHash: block.hash,
          ms: 1,
          issues: [{
            id: `h:${block.hash}`, category: 'correctness', tier: 'harper',
            rule: 'harper:Spelling', start: block.start, end: block.start + 3,
            title: `lint for ${request.source}`, replacements: [],
          }],
        },
      });
    }
  }

  /** A status message with no source, which should reach every attached tab. */
  broadcastReady(): void {
    this.onmessage?.({ data: { type: 'ready', rules: 936, setupMs: 100 } });
  }

  terminate(): void {}
}
