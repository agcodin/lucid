import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lucid } from '../src/scheduler.js';
import type { EngineState } from '../src/scheduler.js';
import type { FromWorker, ToWorker } from '../src/worker/protocol.js';

/**
 * A stand-in for the Harper worker. It records what the scheduler asked for,
 * so the tests can assert on which blocks were sent rather than on lint output.
 */
class FakeWorker {
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  readonly sent: ToWorker[] = [];
  /** Blocks the scheduler asked to lint, flattened across all requests. */
  readonly linted: string[] = [];

  /** When false, requests are recorded but never answered. */
  autoReply = true;

  postMessage(message: ToWorker): void {
    this.sent.push(message);
    if (message.type !== 'lint') return;
    for (const block of message.blocks) this.linted.push(block.text);
    if (!this.autoReply) return;
    // Answer asynchronously, as the real worker does, so the scheduler's
    // generation check runs the way it would in the browser.
    queueMicrotask(() => {
      for (const block of message.blocks) this.reply(message.gen, block.hash, block.start);
    });
  }

  /** Reply as the real worker would, with one issue per block. */
  reply(gen: number, blockHash: string, start: number): void {
    this.onmessage?.({
      data: {
        type: 'blockLints',
        gen,
        blockHash,
        ms: 1,
        issues: [{
          id: `h:${blockHash}`, category: 'correctness', tier: 'harper',
          rule: 'harper:Spelling', start, end: start + 4,
          title: 'fake', replacements: [], dismissHash: `d:${blockHash}`,
        }],
      },
    } as MessageEvent<FromWorker>);
  }

  terminate(): void {}
}

/** Wait past the scheduler's debounce and its coalesced emit. */
const settle = (ms = 220): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function makeEngine(): { engine: Lucid; worker: FakeWorker; states: EngineState[] } {
  const worker = new FakeWorker();
  const states: EngineState[] = [];
  const engine = new Lucid({
    worker: worker as unknown as Worker,
    debounceMs: 20,
    onUpdate: (state) => states.push(state),
  });
  return { engine, worker, states };
}

test('setText reports rule issues without needing the worker', async () => {
  const { engine, worker, states } = makeEngine();
  worker.autoReply = false; // Tier 0 must stand on its own.
  engine.setText('In order to ship, we utilize it.');
  await settle();
  const last = states.at(-1)!;
  assert.ok(last.issues.length > 0);
  assert.ok(last.issues.every((issue) => issue.tier === 'rules'));
  engine.dispose();
});

test('an unchanged document does nothing at all', async () => {
  const { engine, worker, states } = makeEngine();
  engine.setText('Hello there.');
  await settle();
  const count = states.length;
  engine.setText('Hello there.');
  await settle();
  assert.equal(states.length, count, 'identical text should not re-emit');
  engine.dispose();
});

test('editing one paragraph re-lints only that paragraph', async () => {
  const { engine, worker } = makeEngine();
  const a = 'First paragraph here.';
  const b = 'Second paragraph here.';
  const c = 'Third paragraph here.';

  engine.setText([a, b, c].join('\n\n'));
  await settle();
  assert.deepEqual(worker.linted, [a, b, c], 'first pass lints everything');

  worker.linted.length = 0;
  engine.setText([a, 'Second paragraph here, edited.', c].join('\n\n'));
  await settle();
  assert.deepEqual(worker.linted, ['Second paragraph here, edited.'],
    'only the edited block should be sent');
  engine.dispose();
});

test('a paragraph that moves keeps its issues and is not re-linted', async () => {
  const { engine, worker } = makeEngine();
  const a = 'Alpha paragraph.';
  const b = 'Beta paragraph.';

  engine.setText([a, b].join('\n\n'));
  await settle();
  worker.linted.length = 0;

  // Insert a new paragraph above, shifting both existing ones down.
  engine.setText(['New opener.', a, b].join('\n\n'));
  await settle();
  assert.deepEqual(worker.linted, ['New opener.'], 'shifted blocks should reuse their lints');
  engine.dispose();
});

test('issues from a superseded generation are ignored', async () => {
  const { engine, worker, states } = makeEngine();
  engine.setText('Alpha text here.');
  await settle();
  const staleGen = (worker.sent.find((m) => m.type === 'lint') as { gen: number }).gen;

  engine.setText('Alpha text here, now longer.');
  await settle();

  const before = states.at(-1)!.issues.length;
  worker.reply(staleGen, 'nonexistent', 0);
  await settle();
  assert.equal(states.at(-1)!.issues.length, before, 'a stale reply must not land');
  engine.dispose();
});

test('issues come back in document order', async () => {
  const { engine, states } = makeEngine();
  engine.setText('In order to ship it, we utilize a very large number of tools.\n\nDue to the fact that it broke, we really stopped.');
  await settle();
  const starts = states.at(-1)!.issues.map((issue) => issue.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  engine.dispose();
});

test('dismissing hides an issue and every later copy of it', async () => {
  const { engine, states } = makeEngine();
  engine.setText('We utilize it.\n\nThey utilize it too.');
  await settle();

  const target = states.at(-1)!.issues.find((issue) => issue.rule.includes('utilize'));
  assert.ok(target, 'expected a utilize flag');
  const before = states.at(-1)!.issues.length;

  engine.dismiss(target);
  await settle();
  const after = states.at(-1)!.issues;
  assert.ok(after.length < before);
  assert.ok(!after.some((issue) => issue.dismissHash === target.dismissHash),
    'both copies should be gone, since dismissal is by content');
  engine.dispose();
});

test('stats report how much work the last edit actually caused', async () => {
  const { engine, states } = makeEngine();
  engine.setText(['One here.', 'Two here.', 'Three here.'].join('\n\n'));
  await settle();
  assert.equal(states.at(-1)!.stats.blocks, 3);
  assert.equal(states.at(-1)!.stats.dirtyBlocks, 3);

  engine.setText(['One here.', 'Two here, edited.', 'Three here.'].join('\n\n'));
  await settle();
  assert.equal(states.at(-1)!.stats.blocks, 3);
  assert.equal(states.at(-1)!.stats.dirtyBlocks, 1, 'only one block changed');
  engine.dispose();
});

test('updates are coalesced rather than emitted once per change', async () => {
  const { engine, states } = makeEngine();
  for (let i = 0; i < 25; i++) engine.setText(`Draft ${i} in order to ship.`);
  await settle();
  assert.ok(states.length < 25, `expected coalescing, got ${states.length} emits for 25 edits`);
  engine.dispose();
});

test('switching a category off hides its issues without re-linting', async () => {
  const { engine, worker, states } = makeEngine();
  engine.setText('In order to ship, we utilize it. I think that maybe it works.');
  await settle();

  const all = states.at(-1)!.issues;
  assert.ok(all.some((issue) => issue.category === 'clarity'));
  assert.ok(all.some((issue) => issue.category === 'delivery'));

  const linted = worker.linted.length;
  engine.setRuleConfig({
    categories: { correctness: true, clarity: false, engagement: true, delivery: true },
    disabledRules: [],
  });
  await settle();

  const shown = states.at(-1)!.issues;
  assert.ok(!shown.some((issue) => issue.category === 'clarity'), 'clarity should be hidden');
  assert.ok(shown.some((issue) => issue.category === 'delivery'), 'delivery should remain');
  assert.equal(worker.linted.length, linted, 'a toggle must not cause any re-linting');
  engine.dispose();
});

test('a disabled rule prefix silences its whole table', async () => {
  const { engine, states } = makeEngine();
  engine.setText('In order to ship, we utilize a very large number of tools.');
  await settle();
  assert.ok(states.at(-1)!.issues.some((issue) => issue.rule.startsWith('clarity:wordy/')));

  engine.setRuleConfig({
    categories: { correctness: true, clarity: true, engagement: true, delivery: true },
    disabledRules: ['clarity:wordy'],
  });
  await settle();
  assert.ok(!states.at(-1)!.issues.some((issue) => issue.rule.startsWith('clarity:wordy/')));
  engine.dispose();
});

test('category counts follow what is shown', async () => {
  const { engine, states } = makeEngine();
  engine.setText('In order to ship, we utilize it.');
  await settle();
  assert.ok(states.at(-1)!.report.counts.clarity > 0);

  engine.setRuleConfig({
    categories: { correctness: true, clarity: false, engagement: true, delivery: true },
    disabledRules: [],
  });
  await settle();
  assert.equal(states.at(-1)!.report.counts.clarity, 0);
  engine.dispose();
});
