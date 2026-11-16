import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { ChromeStub, StubWorker } from './chrome-stub.js';

const stub = new ChromeStub();

/** Give the microtask-based port handshake and message fan-out time to land. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

before(async () => {
  stub.install();
  (globalThis as Record<string, unknown>).Worker = StubWorker;

  // Import the real modules, each registering its listeners as its own context.
  stub.as('background');
  await import('../src/background.js');
  stub.as('offscreen');
  await import('../src/offscreen.js');
  stub.as('background');
});

/** Attach a tab and collect everything the background sends back to it. */
interface Reply {
  type: string;
  source?: string;
  issues?: { title: string }[];
}

function attachTab(): { send: (message: unknown) => void; received: Reply[]; close: () => void } {
  const received: Reply[] = [];
  const port = stub.connect('lucid');
  port.onMessage.addListener((message) => { received.push(message as unknown as Reply); });
  return {
    send: (message) => port.postMessage(message),
    received,
    close: () => port.disconnect(),
  };
}

function lint(gen: number, text: string): unknown {
  return { type: 'lint', gen, blocks: [{ start: 0, text, hash: `h-${text}` }] };
}

test('the offscreen document is created once, however many tabs attach', async () => {
  const a = attachTab();
  const b = attachTab();
  await settle();
  a.send(lint(1, 'alpha'));
  b.send(lint(1, 'beta'));
  await settle();

  assert.equal(stub.offscreenCreated.length, 1, 'one WASM instance for the whole browser');
  assert.equal(stub.offscreenCreated[0], 'offscreen.html');
  a.close();
  b.close();
});

test('each tab gets its own engine source, so generations cannot collide', async () => {
  const a = attachTab();
  const b = attachTab();
  await settle();

  // Both tabs legitimately use generation 1: the counter is per tab.
  a.send(lint(1, 'alpha text'));
  b.send(lint(1, 'beta text'));
  await settle();

  const worker = StubWorker.latest!;
  const recent = worker.requests.slice(-2);
  assert.equal(recent.length, 2);
  assert.notEqual(recent[0]!.source, recent[1]!.source, 'two tabs must not share a source');
  assert.ok(recent.every((request) => request.source !== undefined), 'every lint must carry a source');

  a.close();
  b.close();
});

test('a reply reaches only the tab that asked for it', async () => {
  const a = attachTab();
  const b = attachTab();
  await settle();

  a.send(lint(1, 'alpha only'));
  b.send(lint(1, 'beta only'));
  await settle();

  const worker = StubWorker.latest!;
  const forA = worker.requests.find((request) => request.blocks[0]!.text === 'alpha only')!;
  stub.as('offscreen');
  worker.replyTo(forA);
  await settle();
  stub.as('background');

  assert.equal(a.received.length, 1, 'the asking tab should get exactly one reply');
  assert.equal(b.received.length, 0, 'the other tab should get nothing');
  assert.equal(a.received[0]!.type, 'blockLints');
  assert.equal(a.received[0]!.source, forA.source, 'the reply should carry the asking tab as its source');
  assert.equal(a.received[0]!.issues?.[0]?.title, `lint for ${forA.source}`);

  a.close();
  b.close();
});

test('status messages with no source reach every attached tab', async () => {
  const a = attachTab();
  const b = attachTab();
  await settle();
  a.send(lint(1, 'a')); // Attaching is enough; a message registers the port.
  b.send(lint(1, 'b'));
  await settle();
  a.received.length = 0;
  b.received.length = 0;

  stub.as('offscreen');
  StubWorker.latest!.broadcastReady();
  await settle();
  stub.as('background');

  assert.equal(a.received.filter((m) => m.type === 'ready').length, 1);
  assert.equal(b.received.filter((m) => m.type === 'ready').length, 1);

  a.close();
  b.close();
});

test('a closed tab stops receiving, and its replies are dropped quietly', async () => {
  const a = attachTab();
  await settle();
  a.send(lint(1, 'closing soon'));
  await settle();

  const request = StubWorker.latest!.requests.at(-1)!;
  a.close();
  await settle();
  a.received.length = 0;

  stub.as('offscreen');
  // A reply arriving after the tab navigated away must not throw.
  assert.doesNotThrow(() => StubWorker.latest!.replyTo(request));
  await settle();
  stub.as('background');

  assert.equal(a.received.length, 0, 'a closed port should receive nothing');
});
