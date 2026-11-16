import { Lucid, applyReplacement } from '@lucid/engine';
import type { Category, EngineState, Issue } from '@lucid/engine';
import { PORT_NAME } from './messages.js';
import { buildTextIndex, rangeFor, type TextIndex } from './textindex.js';
import { CATEGORY_LABELS, DEFAULT_PREFS, loadPrefs, onPrefsChanged, savePrefs, type Prefs } from './prefs.js';

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

/**
 * Underlines inside a `<textarea>` or `<input>` need an OpaqueRange, which
 * Chromium creates through `createValueRange` on the field itself.
 *
 * `OpaqueRange` is on `window` but is not constructible: `new OpaqueRange(...)`
 * throws "Illegal constructor". Detecting the global and then constructing it
 * threw on every paint, and because the throw escaped the engine's update
 * callback it killed the whole attachment rather than just the underlines.
 */
type ValueRangeField = { createValueRange(start: number, end: number): AbstractRange };

function supportsValueRange(field: Field): field is Field & ValueRangeField {
  return typeof (field as Partial<ValueRangeField>).createValueRange === 'function';
}

const HIGHLIGHTS_SUPPORTED = typeof CSS !== 'undefined' && 'highlights' in CSS;

/**
 * Preferences apply to whichever field is attached, so they live here rather
 * than on an attachment that is thrown away the moment focus moves.
 */
let prefs: Prefs = DEFAULT_PREFS;
let live: Attachment | undefined;

function applyPrefs(next: Prefs): void {
  prefs = next;
  live?.usePrefs(next);
}

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
    this.usePrefs(prefs);

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
    // Underlines are the optional half. A browser quirk while building ranges
    // must not stop the panel from listing the suggestions, and must not throw
    // back into the engine's update callback, which would end the attachment.
    try {
      this.paint();
    } catch (error) {
      console.warn('[lucid] could not paint underlines:', error);
    }
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
      // No underlines without createValueRange; the panel still lists everything.
      if (!supportsValueRange(this.field)) return;
      const length = (this.field as HTMLTextAreaElement).value.length;
      for (const issue of this.issues) {
        // Offsets can lag the field's value, because linting is debounced, and
        // createValueRange throws when they run past the end.
        const start = Math.min(issue.start, length);
        const end = Math.min(issue.end, length);
        if (end <= start) continue;
        const range = this.field.createValueRange(start, end);
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
      const host = this.field as HTMLElement;
      const index = buildTextIndex(host);
      const range = rangeFor(index, issue.start, issue.end);
      if (!range) {
        // The span could not be resolved against the host's current DOM,
        // usually because the page changed under us between linting and the
        // click. Saying so beats the fix silently doing nothing.
        console.warn('[lucid] could not locate the text to replace', {
          rule: issue.rule, start: issue.start, end: issue.end, textLength: index.text.length,
        });
        return;
      }

      // Replace through the selection so the page's own undo stack records it.
      // execCommand only acts on the focused editable, and clicking the panel
      // moves focus into its shadow root, so focus has to come back first.
      host.focus();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      const inserted = replacement === ''
        ? document.execCommand('delete')
        : document.execCommand('insertText', false, replacement);

      if (!inserted) {
        // Some hosts block execCommand. Editing the range directly loses the
        // page's undo entry, which is worse than keeping it but far better
        // than the fix silently doing nothing.
        range.deleteContents();
        if (replacement !== '') range.insertNode(document.createTextNode(replacement));
      }
    }

    this.field.dispatchEvent(new Event('input', { bubbles: true }));
    this.onInput();
  }

  dismiss(issue: Issue): void {
    this.engine.dismiss(issue);
  }

  /** Point the engine at the current preferences. */
  usePrefs(next: Prefs): void {
    this.engine.setRuleConfig(next.rules);
    this.engine.setDictionary(next.dictionary);
  }

  /** The host text an issue covers. */
  textOf(issue: Issue): string {
    return this.readText().slice(issue.start, issue.end);
  }

  addWord(word: string): void {
    const clean = word.trim();
    if (clean.length === 0 || prefs.dictionary.includes(clean)) return;
    const next = { ...prefs, dictionary: [...prefs.dictionary, clean] };
    applyPrefs(next);
    void savePrefs(next);
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
  private settingsOpen = false;
  private lastSettingsHtml = '';
  /** The last update, so opening the panel can fill the list straight away. */
  private last: { state: EngineState; attachment: Attachment } | undefined;

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
        <div class="card" hidden>
          <div class="head">
            <span class="title">Suggestions</span>
            <button class="gear" type="button" aria-label="Settings">&#9881;</button>
          </div>
          <div class="list"></div>
          <div class="settings" hidden></div>
        </div>
      </div>`;
    this.body = this.shadow.querySelector('.wrap')!;

    this.shadow.querySelector('.badge')!.addEventListener('click', () => {
      this.open = !this.open;
      (this.shadow.querySelector('.card') as HTMLElement).hidden = !this.open;
      // The list is only built while the panel is open, so opening it has to
      // fill it now rather than wait for the next edit.
      if (this.open && this.last) this.render(this.last.state, this.last.attachment);
    });

    this.shadow.querySelector('.gear')!.addEventListener('click', () => {
      this.settingsOpen = !this.settingsOpen;
      if (this.last) this.render(this.last.state, this.last.attachment);
    });

    // One delegated handler, so a rebuilt list never loses its wiring.
    this.shadow.querySelector('.card')!.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const attachment = this.last?.attachment;
      const issues = this.last?.state.issues;
      if (!attachment || !issues) return;

      const fix = target.closest<HTMLElement>('button[data-j]');
      if (fix) {
        const issue = issues[Number(fix.dataset.i)];
        const replacement = issue?.replacements[Number(fix.dataset.j)];
        if (issue && replacement) attachment.apply(issue, replacement.text);
        return;
      }
      const dismiss = target.closest<HTMLElement>('button[data-dismiss]');
      if (dismiss) {
        const issue = issues[Number(dismiss.dataset.dismiss)];
        if (issue) attachment.dismiss(issue);
        return;
      }
      const learn = target.closest<HTMLElement>('button[data-learn]');
      if (learn) {
        attachment.addWord(learn.dataset.learn!);
        return;
      }
      const category = target.closest<HTMLInputElement>('input[data-category]');
      if (category) {
        const next: Prefs = {
          ...prefs,
          rules: {
            ...prefs.rules,
            categories: { ...prefs.rules.categories, [category.dataset.category!]: category.checked },
          },
        };
        applyPrefs(next);
        void savePrefs(next);
        return;
      }
      const forget = target.closest<HTMLElement>('button[data-forget]');
      if (forget) {
        const next: Prefs = {
          ...prefs,
          dictionary: prefs.dictionary.filter((word) => word !== forget.dataset.forget),
        };
        applyPrefs(next);
        void savePrefs(next);
      }
    });
  }

  hide(): void {
    this.body.hidden = true;
    this.open = false;
    this.last = undefined;
    (this.shadow.querySelector('.card') as HTMLElement).hidden = true;
  }

  render(state: EngineState, attachment: Attachment): void {
    this.last = { state, attachment };
    this.body.hidden = false;
    const count = state.issues.length;
    this.shadow.querySelector('.n')!.textContent = String(count);
    this.shadow.querySelector('.lbl')!.textContent = count === 1 ? 'suggestion' : 'suggestions';

    const list = this.shadow.querySelector('.list') as HTMLElement;
    const settings = this.shadow.querySelector('.settings') as HTMLElement;
    if (!this.open) return;

    settings.hidden = !this.settingsOpen;
    list.hidden = this.settingsOpen;

    if (this.settingsOpen) {
      const html = `
        <p class="sec">Categories</p>
        ${(Object.keys(CATEGORY_LABELS) as Category[]).map((category) => `
          <label class="opt">
            <input type="checkbox" data-category="${category}" ${prefs.rules.categories[category] ? 'checked' : ''} />
            ${CATEGORY_LABELS[category]}
          </label>`).join('')}
        <p class="sec">Your dictionary</p>
        ${prefs.dictionary.length === 0
          ? '<p class="hint">Words you teach it from a spelling suggestion appear here.</p>'
          : `<div class="words">${prefs.dictionary
              .map((word) => `<span class="w">${escapeHtml(word)}<button data-forget="${escapeHtml(word)}" aria-label="Remove ${escapeHtml(word)}">&times;</button></span>`)
              .join('')}</div>`}`;
      // Only write when it actually differs. The engine emits on every edit,
      // and rebuilding this view would replace the checkbox the user is
      // clicking, losing focus mid-interaction.
      if (this.lastSettingsHtml !== html) {
        this.lastSettingsHtml = html;
        settings.innerHTML = html;
      }
      return;
    }

    if (state.issues.length === 0) {
      list.innerHTML = '<p class="hint">Nothing to flag here.</p>';
      return;
    }

    list.innerHTML = state.issues
      .slice(0, 40)
      .map((issue, i) => `<div class="row ${issue.category}" data-i="${i}">
          <div class="t">${escapeHtml(issue.title)}</div>
          <div class="r">
            ${issue.replacements.slice(0, 3)
              .map((rep, j) => `<button data-i="${i}" data-j="${j}">${escapeHtml(rep.label ?? rep.text)}</button>`)
              .join('')}
            ${issue.rule === 'harper:Spelling'
              ? `<button class="ghost" data-learn="${escapeHtml(this.spanOf(issue))}">Learn word</button>`
              : ''}
            <button class="ghost" data-dismiss="${i}">Dismiss</button>
          </div>
        </div>`)
      .join('');
  }

  /** The text an issue covers, for the "learn word" action. */
  private spanOf(issue: Issue): string {
    return this.last?.attachment.textOf(issue) ?? '';
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
.r button.ghost { border-color: #e0dcd5; color: #6f6a62; }
.r button.ghost:hover { background: #e0dcd5; color: #1c1b19; }
.head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 8px; }
.title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #9a948b; }
.gear { font: inherit; font-size: 14px; line-height: 1; cursor: pointer; border: none; background: none; color: #6f6a62; padding: 2px 4px; }
.gear:hover { color: #1c1b19; }
.sec { margin: 6px 4px 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #9a948b; }
.opt { display: flex; align-items: center; gap: 7px; padding: 4px 6px; font-size: 12.5px; cursor: pointer; }
.opt input { accent-color: #2f6f5e; }
.hint { margin: 4px 6px; font-size: 11.5px; color: #9a948b; line-height: 1.5; }
.words { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 4px; }
.w { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 8px; border-radius: 6px; border: 1px solid #e0dcd5; font-size: 12px; }
.w button { font: inherit; cursor: pointer; border: none; background: none; color: #9a948b; padding: 0 2px; }
.w button:hover { color: #d2443c; }
@media (prefers-color-scheme: dark) {
  .wrap { color: #e9e7e3; }
  .badge, .card { background: #1b1d23; border-color: #2d3038; }
  .badge .lbl { color: #9a958d; }
  .row { background: #14151a; }
  .r button.ghost { border-color: #2d3038; color: #9a958d; }
  .r button.ghost:hover { background: #2d3038; color: #e9e7e3; }
  .w { border-color: #2d3038; }
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

void loadPrefs().then(applyPrefs);
onPrefsChanged(applyPrefs);

document.addEventListener('focusin', (event) => {
  const target = event.target;
  if (!isEditable(target) || target === attachedTo) return;
  attachment?.destroy();
  attachedTo = target;
  attachment = new Attachment(target, panel);
  live = attachment;
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
    live = undefined;
    panel.hide();
  }, 150);
}, true);
