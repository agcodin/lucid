import { Lucid, applyReplacement } from '@lucid/engine';
import type { Category, EngineState, Issue } from '@lucid/engine';
import { PORT_NAME } from './messages.js';
import { buildTextIndex, rangeFor, type TextIndex } from './textindex.js';

const CATEGORIES: Category[] = ['correctness', 'clarity', 'engagement', 'delivery'];

/**
 * A `Worker`-shaped adapter over the port to the service worker, so the engine
 * is identical here and in the web app — the only difference is that the WASM
 * lives in one shared offscreen document rather than in this tab.
 */
function portWorker(): Worker {
  const port = chrome.runtime.connect({ name: PORT_NAME });
  const shim = {
    postMessage: (message: unknown) => {
      try { port.postMessage(message); } catch { /* Service worker restarting. */ }
    },
    onmessage: null as ((event: MessageEvent) => void) | null,
    terminate: () => port.disconnect(),
  };
  port.onMessage.addListener((message) => shim.onmessage?.({ data: message } as MessageEvent));
  return shim as unknown as Worker;
}

type Field = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

function isEditable(node: EventTarget | null): node is Field {
  if (!(node instanceof HTMLElement)) return false;
  if (node instanceof HTMLTextAreaElement) return !node.readOnly && !node.disabled;
  if (node instanceof HTMLInputElement) {
    return ['text', 'search', 'email', 'url', ''].includes(node.type) && !node.readOnly && !node.disabled;
  }
  return node.isContentEditable;
}

/** Underlines inside `<textarea>` need OpaqueRange, which only Chromium has. */
const OPAQUE_RANGE: (new (node: Node, start: number, end: number) => AbstractRange) | undefined =
  (window as unknown as { OpaqueRange?: new (node: Node, start: number, end: number) => AbstractRange }).OpaqueRange;

const HIGHLIGHTS_SUPPORTED = typeof CSS !== 'undefined' && 'highlights' in CSS;

class Attachment {
  private readonly field: Field;
  private readonly engine: Lucid;
  private readonly panel: Panel;
  private readonly isTextarea: boolean;
  private index: TextIndex | undefined;
  private issues: Issue[] = [];

  constructor(field: Field, panel: Panel) {
    this.field = field;
    this.panel = panel;
    this.isTextarea = field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement;

    this.engine = new Lucid({
      worker: portWorker(),
      onUpdate: (state) => this.onUpdate(state),
    });

    field.addEventListener('input', this.onInput, { passive: true });
    this.onInput();
  }

  private readonly onInput = (): void => {
    this.engine.setText(this.readText());
  };

  private readText(): string {
    if (this.field instanceof HTMLTextAreaElement || this.field instanceof HTMLInputElement) {
      return this.field.value;
    }
    this.index = buildTextIndex(this.field);
    return this.index.text;
  }

  private onUpdate(state: EngineState): void {
    this.issues = state.issues;
    this.paint();
    this.panel.render(state, this);
  }

  /** Repaint underlines. One `Highlight` swap, no DOM nodes, no measurement. */
  private paint(): void {
    if (!HIGHLIGHTS_SUPPORTED) return;

    for (const category of CATEGORIES) {
      const highlight = CSS.highlights.get(`lucid-${category}`) ?? new Highlight();
      highlight.clear();
      CSS.highlights.set(`lucid-${category}`, highlight);
    }

    if (this.isTextarea) {
      if (!OPAQUE_RANGE) return; // No underlines here; the panel still lists everything.
      for (const issue of this.issues) {
        const range = new OPAQUE_RANGE(this.field, issue.start, issue.end);
        CSS.highlights.get(`lucid-${issue.category}`)?.add(range as unknown as Range);
      }
      return;
    }

    const index = this.index ?? buildTextIndex(this.field as HTMLElement);
    for (const issue of this.issues) {
      const range = rangeFor(index, issue.start, issue.end);
      if (range) CSS.highlights.get(`lucid-${issue.category}`)?.add(range);
    }
  }

  /** Apply a suggestion back into the host field, preserving the caret. */
  apply(issue: Issue, replacement: string): void {
    const current = this.readText();
    const next = applyReplacement(current, issue, replacement);

    if (this.field instanceof HTMLTextAreaElement || this.field instanceof HTMLInputElement) {
      // Go through the native setter so frameworks that wrap the field (React
      // and friends) see the change and keep their own state in step.
      const prototype = this.field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(this.field, next.text);
      this.field.setSelectionRange(next.cursor, next.cursor);
    } else {
      // Replace through the selection so the page's own undo stack records it.
      const index = buildTextIndex(this.field as HTMLElement);
      const range = rangeFor(index, issue.start, issue.end);
      if (!range) return;
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand('insertText', false, replacement);
    }

    this.field.dispatchEvent(new Event('input', { bubbles: true }));
    this.onInput();
  }

  dismiss(issue: Issue): void {
    this.engine.dismiss(issue);
  }

  destroy(): void {
    this.field.removeEventListener('input', this.onInput);
    this.engine.dispose();
    if (HIGHLIGHTS_SUPPORTED) {
      for (const category of CATEGORIES) CSS.highlights.delete(`lucid-${category}`);
    }
  }
}

/** The floating card. Lives in a shadow root so page CSS cannot reach it. */
class Panel {
  private readonly shadow: ShadowRoot;
  private readonly body: HTMLElement;
  private open = false;

  constructor() {
    const host = document.createElement('div');
    host.id = 'lucid-root';
    // `max-content` keeps the host from intercepting clicks across the page.
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;';
    document.documentElement.appendChild(host);

    this.shadow = host.attachShadow({ mode: 'open' });
    this.shadow.innerHTML = `<style>${PANEL_CSS}</style>
      <div class="wrap" hidden>
        <button class="badge" type="button"><span class="n">0</span><span class="lbl">suggestions</span></button>
        <div class="card" hidden><div class="list"></div></div>
      </div>`;
    this.body = this.shadow.querySelector('.wrap')!;

    this.shadow.querySelector('.badge')!.addEventListener('click', () => {
      this.open = !this.open;
      (this.shadow.querySelector('.card') as HTMLElement).hidden = !this.open;
    });
  }

  hide(): void {
    this.body.hidden = true;
    this.open = false;
    (this.shadow.querySelector('.card') as HTMLElement).hidden = true;
  }

  render(state: EngineState, attachment: Attachment): void {
    this.body.hidden = false;
    const count = state.issues.length;
    this.shadow.querySelector('.n')!.textContent = String(count);
    this.shadow.querySelector('.lbl')!.textContent = count === 1 ? 'suggestion' : 'suggestions';

    const list = this.shadow.querySelector('.list')!;
    if (!this.open) return;

    list.innerHTML = state.issues
      .slice(0, 40)
      .map(
        (issue, i) => `<div class="row ${issue.category}" data-i="${i}">
          <div class="t">${escapeHtml(issue.title)}</div>
          ${issue.replacements.length > 0
            ? `<div class="r">${issue.replacements
                .slice(0, 3)
                .map((rep, j) => `<button data-i="${i}" data-j="${j}">${escapeHtml(rep.label ?? rep.text)}</button>`)
                .join('')}</div>`
            : ''}
        </div>`,
      )
      .join('');

    list.querySelectorAll<HTMLElement>('button[data-j]').forEach((button) => {
      button.addEventListener('click', () => {
        const issue = state.issues[Number(button.dataset.i)];
        const replacement = issue?.replacements[Number(button.dataset.j)];
        if (issue && replacement) attachment.apply(issue, replacement.text);
      });
    });
  }
}

const PANEL_CSS = `
:host { all: initial; }
.wrap { font: 13px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif; color: #1c1b19; }
.badge {
  font: inherit; display: flex; align-items: center; gap: 6px; cursor: pointer;
  padding: 7px 12px; border-radius: 999px; border: 1px solid #e0dcd5;
  background: #fff; box-shadow: 0 2px 14px rgb(0 0 0 / 14%);
}
.badge .n { font-weight: 700; font-variant-numeric: tabular-nums; }
.badge .lbl { color: #6f6a62; }
.card {
  margin-top: 8px; width: 320px; max-height: 50vh; overflow: auto;
  background: #fff; border: 1px solid #e0dcd5; border-radius: 10px;
  box-shadow: 0 6px 28px rgb(0 0 0 / 16%); padding: 8px;
}
.row { border-left: 3px solid #ccc; padding: 7px 9px; border-radius: 6px; margin-bottom: 5px; background: #fbfaf8; }
.row.correctness { border-left-color: #d2443c; }
.row.clarity { border-left-color: #2f6f9e; }
.row.engagement { border-left-color: #a8700f; }
.row.delivery { border-left-color: #7a4fa3; }
.t { font-size: 12.5px; }
.r { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 5px; }
.r button {
  font: inherit; font-size: 12px; cursor: pointer; padding: 3px 8px;
  border-radius: 5px; border: 1px solid #2f6f5e; background: transparent; color: #2f6f5e;
}
.r button:hover { background: #2f6f5e; color: #fff; }
@media (prefers-color-scheme: dark) {
  .wrap { color: #e9e7e3; }
  .badge, .card { background: #1b1d23; border-color: #2d3038; }
  .badge .lbl { color: #9a958d; }
  .row { background: #14151a; }
}
`;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

// --- Attachment lifecycle -------------------------------------------------
//
// Nothing runs until a field is focused. There is no MutationObserver over the
// page and no scan of every input at load — the engine attaches to the one
// field being typed in and detaches when focus leaves it, so a tab with the
// extension installed but unused costs nothing beyond this script.

const panel = new Panel();
let attachment: Attachment | undefined;
let attachedTo: Field | undefined;

document.addEventListener('focusin', (event) => {
  const target = event.target;
  if (!isEditable(target) || target === attachedTo) return;
  attachment?.destroy();
  attachedTo = target;
  attachment = new Attachment(target, panel);
}, true);

document.addEventListener('focusout', (event) => {
  if (event.target !== attachedTo) return;
  // A click on the panel moves focus out of the field; keep the attachment so
  // the suggestion the user is reaching for still applies.
  setTimeout(() => {
    if (document.activeElement === attachedTo) return;
    attachment?.destroy();
    attachment = undefined;
    attachedTo = undefined;
    panel.hide();
  }, 150);
}, true);
