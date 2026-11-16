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

test('a worker failure is surfaced in stats, not just logged', async () => {
  const { engine, worker, states } = makeEngine();
  engine.setText('Some text to check.');
  await settle();
  assert.equal(states.at(-1)!.stats.error, undefined);

  worker.onmessage?.({
    data: { type: 'error', message: 'failed to compile WebAssembly module' },
  } as MessageEvent<FromWorker>);
  await settle();

  assert.match(states.at(-1)!.stats.error ?? '', /WebAssembly/);
  engine.dispose();
});

test('tier 0 keeps working after the worker fails', async () => {
  const { engine, worker, states } = makeEngine();
  worker.autoReply = false;
  worker.onmessage?.({ data: { type: 'error', message: 'boom' } } as MessageEvent<FromWorker>);
  engine.setText('In order to ship, we utilize it.');
  await settle();

  const state = states.at(-1)!;
  assert.ok(state.issues.length > 0, 'rule issues should still arrive');
  assert.ok(state.issues.every((issue) => issue.tier === 'rules'));
  assert.equal(state.stats.error, 'boom');
  engine.dispose();
});

test('a later ready clears a previous error', async () => {
  const { engine, worker, states } = makeEngine();
  engine.setText('Some text.');
  await settle();
  worker.onmessage?.({ data: { type: 'error', message: 'boom' } } as MessageEvent<FromWorker>);
  await settle();
  assert.equal(states.at(-1)!.stats.error, 'boom');

  worker.onmessage?.({ data: { type: 'ready', rules: 936, setupMs: 500 } } as MessageEvent<FromWorker>);
  await settle();
  assert.equal(states.at(-1)!.stats.error, undefined, 'a successful retry should clear it');
  assert.equal(states.at(-1)!.stats.ready, true);
  engine.dispose();
});

test('the dictionary can be read back, added to and taken from', async () => {
  const { engine, worker } = makeEngine();
  engine.setText('Some text.');
  await settle();

  engine.addToDictionary('Lucid');
  engine.addToDictionary('Harper');
  engine.addToDictionary('Lucid'); // A duplicate must not appear twice.
  await settle();
  assert.deepEqual(engine.getDictionary(), ['Harper', 'Lucid']);

  engine.removeFromDictionary('Harper');
  await settle();
  assert.deepEqual(engine.getDictionary(), ['Lucid']);

  // Removal has to replace the dictionary, since Harper's import only adds.
  const last = worker.sent.filter((m) => m.type === 'setWords').at(-1) as { words: string[] };
  assert.deepEqual(last.words, ['Lucid']);
  engine.dispose();
});

test('adding a word re-lints the document against it', async () => {
  const { engine, worker } = makeEngine();
  engine.setText(['Alpha block.', 'Beta block.'].join('\n\n'));
  await settle();
  worker.linted.length = 0;

  engine.addToDictionary('Nonce');
  await settle();
  assert.equal(worker.linted.length, 2, 'every block should be checked again');
  engine.dispose();
});

test('an empty or blank word is ignored', async () => {
  const { engine } = makeEngine();
  engine.setText('Some text.');
  await settle();
  engine.addToDictionary('   ');
  engine.addToDictionary('');
  await settle();
  assert.deepEqual(engine.getDictionary(), []);
  engine.dispose();
});

test('a disabled rule matches both separators used in rule names', async () => {
  const { engine, states } = makeEngine();
  // clarity:wordy/... uses a slash, clarity:sentence-long uses a hyphen, and a
  // toggle has to reach both or it silently does nothing.
  engine.setText(`In order to ship, we utilize it. ${Array(34).fill('word').join(' ')}.`);
  await settle();
  assert.ok(states.at(-1)!.issues.some((issue) => issue.rule.startsWith('clarity:wordy/')));
  assert.ok(states.at(-1)!.issues.some((issue) => issue.rule === 'clarity:sentence-long'));

  engine.setRuleConfig({
    categories: { correctness: true, clarity: true, engagement: true, delivery: true },
    disabledRules: ['clarity:wordy', 'clarity:sentence'],
  });
  await settle();
  const shown = states.at(-1)!.issues.map((issue) => issue.rule);
  assert.ok(!shown.some((rule) => rule.startsWith('clarity:wordy')), `got [${shown.join(', ')}]`);
  assert.ok(!shown.some((rule) => rule.startsWith('clarity:sentence')), `got [${shown.join(', ')}]`);
  engine.dispose();
});

test('a disabled rule does not silence an unrelated rule sharing its prefix', async () => {
  const { engine, states } = makeEngine();
  engine.setText('There is a problem with the build.');
  await settle();
  assert.ok(states.at(-1)!.issues.some((issue) => issue.rule.startsWith('clarity:expletive')));

  // "clarity:e" is not a rule family; it must not match clarity:expletive/there.
  engine.setRuleConfig({
    categories: { correctness: true, clarity: true, engagement: true, delivery: true },
    disabledRules: ['clarity:e'],
  });
  await settle();
  assert.ok(states.at(-1)!.issues.some((issue) => issue.rule.startsWith('clarity:expletive')));
  engine.dispose();
});

test('a disposed engine ignores replies that arrive late', async () => {
  const { engine, worker, states } = makeEngine();
  worker.autoReply = false;
  engine.setText('Alpha block here.');
  await settle();
  const count = states.length;

  engine.dispose();
  // A worker reply in flight when the caller tore its UI down must not land,
  // or a destroyed view keeps rendering over a live one.
  worker.reply(1, 'any-hash', 0);
  worker.onmessage?.({ data: { type: 'ready', rules: 936, setupMs: 1 } } as MessageEvent<FromWorker>);
  await settle();

  assert.equal(states.length, count, 'no update should follow dispose');
});

test('a disposed engine stops responding to setText', async () => {
  const { engine, worker, states } = makeEngine();
  engine.setText('Alpha.');
  await settle();
  const count = states.length;
  const linted = worker.linted.length;

  engine.dispose();
  engine.setText('Completely different text in order to ship.');
  await settle();

  assert.equal(states.length, count);
  assert.equal(worker.linted.length, linted, 'no further linting should be requested');
});

test('a shared client releases itself instead of disposing the worker', async () => {
  const worker = new FakeWorker();
  const engine = new Lucid({
    worker: worker as unknown as Worker,
    debounceMs: 20,
    source: '7',
    onUpdate: () => undefined,
  });
  engine.setText('Alpha.');
  await settle();

  engine.dispose();
  const last = worker.sent.at(-1)!;
  // Sending the global teardown would dispose the linter and clear the block
  // cache for every other tab sharing this worker.
  assert.equal(last.type, 'release', `sent ${last.type}`);
  assert.equal((last as { source: string }).source, '7');
});

test('a client with its own worker still disposes it', async () => {
  const { engine, worker } = makeEngine();
  engine.setText('Alpha.');
  await settle();
  engine.dispose();
  assert.equal(worker.sent.at(-1)!.type, 'dispose');
});

test('one mistake found by both tiers is shown once', async () => {
  const { engine, worker, states } = makeEngine();
  worker.autoReply = false;
  engine.setText('They is ready.');
  await settle();

  // The rule tier flags "They is"; Harper flags "is". Both are the same
  // mistake, so only one card should reach the UI.
  const rulesIssue = states.at(-1)!.issues.find((issue) => issue.rule === 'confusion:be-agreement')!;
  assert.ok(rulesIssue, 'expected the agreement rule to fire');

  worker.onmessage?.({
    data: {
      type: 'blockLints', gen: 1, blockHash: 'x', ms: 1,
      issues: [{
        id: 'h:1', category: 'correctness', tier: 'harper', rule: 'harper:Agreement',
        start: rulesIssue.start + 5, end: rulesIssue.end,
        title: 'overlapping', replacements: [{ text: 'are' }],
      }],
    },
  } as MessageEvent<FromWorker>);
  await settle();

  const correctness = states.at(-1)!.issues.filter((issue) => issue.category === 'correctness');
  assert.equal(correctness.length, 1, correctness.map((i) => i.rule).join(', '));
});

test('overlapping clarity issues are both kept', async () => {
  const { engine, states } = makeEngine();
  // A wordy phrase inside a sentence that is also too long: two different
  // observations about the same words, and both are worth showing.
  engine.setText(`In order to ship it, ${Array(34).fill('word').join(' ')}.`);
  await settle();
  const rules = states.at(-1)!.issues.map((issue) => issue.rule);
  assert.ok(rules.some((rule) => rule.startsWith('clarity:wordy/')), rules.join(', '));
  assert.ok(rules.includes('clarity:sentence-long'), rules.join(', '));
  engine.dispose();
});
