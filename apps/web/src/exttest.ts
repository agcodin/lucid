/**
 * Drives the extension's real content script in a host page.
 *
 * The content script is the part of the extension that cannot be checked by
 * the routing tests: whether it attaches to the right fields, ignores the
 * wrong ones, paints underlines over a host page's own markup, and applies a
 * suggestion back into a field the page owns.
 *
 * `chrome.runtime.connect` is stubbed onto a real Harper worker, so this
 * exercises the whole stack apart from the service worker hop.
 */
import HarperWorker from '@lucid/engine/worker?worker';

type Listener = (message: unknown) => void;

/** Stand in for the service worker, wired straight to a real Harper worker. */
function installChromeStub(): void {
  const worker = new HarperWorker();
  const listeners: Listener[] = [];
  worker.onmessage = (event: MessageEvent) => {
    for (const fn of listeners) fn(event.data);
  };
  (window as unknown as Record<string, unknown>).chrome = {
    runtime: {
      connect: () => ({
        postMessage: (message: unknown) => worker.postMessage(message),
        disconnect: () => undefined,
        onMessage: { addListener: (fn: Listener) => { listeners.push(fn); } },
        onDisconnect: { addListener: () => undefined },
      }),
    },
  };
}

installChromeStub();
await import('../../extension/src/content.js');

const out = document.querySelector<HTMLElement>('#out')!;

// The run steals focus between fields, so it only starts when asked. Without
// the flag the page is a plain host page to poke at by hand.
if (!new URLSearchParams(location.search).has('run')) {
  out.textContent = 'Idle. Add ?run=1 to run the checks.';
  throw new Error('idle');
}
const results: string[] = [];
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  results.push(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
  out.textContent = results.join('\n');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Total ranges registered across the four category highlights. */
function highlightCount(): number {
  if (!('highlights' in CSS)) return -1;
  let total = 0;
  for (const category of ['correctness', 'clarity', 'engagement', 'delivery']) {
    total += CSS.highlights.get(`lucid-${category}`)?.size ?? 0;
  }
  return total;
}

function badgeCount(): number {
  const host = document.querySelector('#lucid-root');
  const text = host?.shadowRoot?.querySelector('.n')?.textContent ?? '0';
  return Number(text);
}

function panelVisible(): boolean {
  const wrap = document.querySelector('#lucid-root')?.shadowRoot?.querySelector<HTMLElement>('.wrap');
  return wrap !== null && wrap !== undefined && !wrap.hidden;
}

/**
 * Focus a field and let the content script react.
 *
 * `element.focus()` only fires focusin when the document itself has focus, and
 * it does not when this page runs in a background or hidden pane, so the event
 * is dispatched directly as well.
 */
async function focusAndSettle(element: HTMLElement, ms = 1600): Promise<void> {
  element.focus();
  element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  element.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(ms);
}

/** Tell the content script focus has left, the way a real blur would. */
async function blurAndSettle(element: HTMLElement, ms = 600): Promise<void> {
  element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  element.blur();
  await sleep(ms);
}

// --- The run --------------------------------------------------------------

check('panel is injected into a shadow root', document.querySelector('#lucid-root')?.shadowRoot != null);
check('panel is hidden before any field is focused', !panelVisible());

// A textarea attaches and finds issues, even where it cannot underline them.
const textarea = document.querySelector<HTMLTextAreaElement>('#ta')!;
const textareaStart = textarea.value;
await focusAndSettle(textarea, 3000);
check('attaches to a textarea', badgeCount() > 0, `badge shows ${badgeCount()}`);
check('panel appears once a field is focused', panelVisible());

const canUnderlineFields = typeof (textarea as unknown as { createValueRange?: unknown }).createValueRange === 'function';
check(
  canUnderlineFields ? 'underlines a textarea through createValueRange' : 'skips textarea underlines where unsupported',
  canUnderlineFields ? highlightCount() > 0 : true,
  canUnderlineFields ? `${highlightCount()} ranges` : 'suggestions are still listed in the panel',
);

// A password field must never be touched.
await blurAndSettle(textarea);
const password = document.querySelector<HTMLInputElement>('#pw')!;
await focusAndSettle(password, 600);
check('ignores a password field', badgeCount() === 0 || !panelVisible(), `badge ${badgeCount()}, panel ${panelVisible()}`);

// A readonly field must never be touched.
const readonly = document.querySelector<HTMLTextAreaElement>('#ro')!;
await focusAndSettle(readonly, 600);
check('ignores a readonly textarea', !panelVisible() || badgeCount() === 0);

// A plain div must never be touched.
const plain = document.querySelector<HTMLElement>('#plain')!;
plain.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
await sleep(400);
check('ignores a non-editable element', !panelVisible() || badgeCount() === 0);

// contenteditable with nested markup is the case that matters most.
const editable = document.querySelector<HTMLElement>('#ce')!;
await focusAndSettle(editable, 3000);
const count = badgeCount();
check('attaches to contenteditable with nested markup', count > 0, `badge shows ${count}`);
check('underlines contenteditable', highlightCount() > 0, `${highlightCount()} ranges`);

// Every range must cover exactly the text the engine flagged.
let mismatched = 0;
for (const category of ['correctness', 'clarity', 'engagement', 'delivery']) {
  for (const range of CSS.highlights.get(`lucid-${category}`) ?? []) {
    const text = (range as Range).toString();
    if (text.trim().length === 0) mismatched++;
  }
}
check('no empty or collapsed ranges', mismatched === 0, `${mismatched} empty`);

// Applying a suggestion has to change the host page's own text.
const panelRoot = document.querySelector('#lucid-root')!.shadowRoot!;
panelRoot.querySelector<HTMLElement>('.badge')!.click();
await sleep(300);
check('panel lists a suggestion with a fix', panelRoot.querySelector('.r button') != null);

{
  // Re-query at click time. The panel rebuilds its list on every engine
  // update, so a reference held across an await can be a detached node.
  await sleep(900);
  const firstFix = panelRoot.querySelector<HTMLElement>('.r button');
  const before = editable.innerText;
  const diagnostics = {
    rows: [...panelRoot.querySelectorAll('.row .t')].map((t) => t.textContent?.trim()).slice(0, 3),
    label: firstFix?.textContent,
    connected: firstFix?.isConnected,
    active: (document.activeElement as HTMLElement | null)?.id ?? document.activeElement?.tagName,
    badge: badgeCount(),
    textareaChanged: textarea.value !== textareaStart,
  };
  firstFix?.click();
  await sleep(1200);
  check('applying a suggestion edits the host page', editable.innerText !== before,
    `${JSON.stringify(before.slice(0, 40))} -> ${JSON.stringify(editable.innerText.slice(0, 40))}\n        ${JSON.stringify(diagnostics)}`);
  check('nested markup survives the edit', editable.querySelector('b') != null && editable.querySelector('li') != null);
}

// Leaving the field tears the attachment down.
await blurAndSettle(editable, 800);
check('hides the panel when focus leaves', !panelVisible());
check('clears underlines on detach', highlightCount() <= 0, `${highlightCount()} ranges left`);

results.push('', failures === 0 ? `PASS — ${results.length} checks` : `FAIL — ${failures} of ${results.length} checks`);
out.textContent = results.join('\n');
(window as unknown as Record<string, unknown>).__exttest = { failures, results };
