import type { RemoteProvider, TransformKind, TransformVariant } from '@lucid/engine';

interface Action {
  kind: TransformKind;
  label: string;
  tone?: string;
}

const ACTIONS: Action[] = [
  { kind: 'rewrite', label: 'Rewrite' },
  { kind: 'shorten', label: 'Shorten' },
  { kind: 'simplify', label: 'Simplify' },
  { kind: 'paraphrase', label: 'Rephrase' },
  { kind: 'tone', label: 'Formal', tone: 'formal and professional' },
  { kind: 'tone', label: 'Friendly', tone: 'warm and friendly' },
  { kind: 'tone', label: 'Direct', tone: 'direct and confident' },
];

export interface RewriteBarOptions {
  root: HTMLElement;
  getProvider: () => RemoteProvider | undefined;
  onReplace: (start: number, end: number, text: string) => void;
}

/**
 * The remote tier's surface. It appears only on a selection and only fires on a
 * click, so a network round-trip never lands in the typing path.
 */
export class RewriteBar {
  private readonly root: HTMLElement;
  private readonly getProvider: () => RemoteProvider | undefined;
  private readonly onReplace: (start: number, end: number, text: string) => void;

  private selection: { start: number; end: number; text: string; context: string } | undefined;
  private inFlight: AbortController | undefined;

  constructor(options: RewriteBarOptions) {
    this.root = options.root;
    this.getProvider = options.getProvider;
    this.onReplace = options.onReplace;

    document.addEventListener('selectionchange', () => this.onSelectionChange());
    this.refresh();
  }

  refresh(): void {
    this.render();
  }

  /** Run an action on the current selection, for the keyboard shortcut. */
  trigger(kind: TransformKind): void {
    const action = ACTIONS.find((candidate) => candidate.kind === kind);
    if (action) void this.run(action);
  }

  private onSelectionChange(): void {
    const selection = window.getSelection();
    const editor = document.querySelector<HTMLElement>('#editor');
    if (!selection || selection.isCollapsed || !editor || selection.rangeCount === 0) {
      if (this.selection) { this.selection = undefined; this.render(); }
      return;
    }
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;

    const text = selection.toString();
    if (text.trim().length < 3) return;

    const full = [...editor.children].map((line) => line.textContent ?? '').join('\n');
    const start = full.indexOf(text);
    if (start < 0) return;

    this.selection = { start, end: start + text.length, text, context: paragraphAround(full, start) };
    this.render();
  }

  private async run(action: Action): Promise<void> {
    const provider = this.getProvider();
    const selected = this.selection;
    if (!provider || !selected) return;

    this.inFlight?.abort();
    this.inFlight = new AbortController();
    this.renderLoading(action.label);

    try {
      const variants = await provider.transform(
        { kind: action.kind, text: selected.text, context: selected.context, tone: action.tone },
        this.inFlight.signal,
      );
      this.renderVariants(action.label, variants, selected);
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      this.renderError(error instanceof Error ? error.message : String(error));
    }
  }

  private render(): void {
    const provider = this.getProvider();
    if (!this.selection) {
      this.root.innerHTML = '';
      return;
    }
    if (!provider?.isConfigured()) {
      this.root.innerHTML = `<div class="rewrite"><span class="rewrite-hint">
        Add an Anthropic API key under &ldquo;Claude rewrites&rdquo; to rewrite a selection.
      </span></div>`;
      return;
    }
    this.root.innerHTML = `<div class="rewrite">
      <span class="rewrite-label">${this.selection.text.trim().split(/\s+/).length} words selected</span>
      <div class="rewrite-actions">
        ${ACTIONS.map((action, i) => `<button class="btn small" data-i="${i}">${action.label}</button>`).join('')}
      </div>
    </div>`;

    this.root.querySelectorAll<HTMLElement>('button[data-i]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = ACTIONS[Number(button.dataset.i)];
        if (action) void this.run(action);
      });
    });
  }

  private renderLoading(label: string): void {
    this.root.innerHTML = `<div class="rewrite"><span class="rewrite-label">${label}&hellip;</span>
      <div class="spinner"></div></div>`;
  }

  private renderError(message: string): void {
    this.root.innerHTML = `<div class="rewrite error"><span>${escapeHtml(message)}</span>
      <button class="btn small ghost" id="rewrite-back">Back</button></div>`;
    this.root.querySelector('#rewrite-back')?.addEventListener('click', () => this.render());
  }

  private renderVariants(
    label: string,
    variants: TransformVariant[],
    selected: { start: number; end: number },
  ): void {
    if (variants.length === 0) {
      this.renderError('Claude returned no rewrite for this selection.');
      return;
    }
    this.root.innerHTML = `<div class="rewrite variants">
      <span class="rewrite-label">${label}</span>
      ${variants
        .map(
          (variant, i) => `<button class="variant" data-i="${i}">
            <span class="variant-text">${escapeHtml(variant.text)}</span>
            <span class="variant-note">${escapeHtml(variant.note)}</span>
          </button>`,
        )
        .join('')}
      <button class="btn small ghost" id="rewrite-cancel">Keep original</button>
    </div>`;

    this.root.querySelectorAll<HTMLElement>('.variant').forEach((button) => {
      button.addEventListener('click', () => {
        const variant = variants[Number(button.dataset.i)];
        if (!variant) return;
        this.onReplace(selected.start, selected.end, variant.text);
        this.selection = undefined;
        this.render();
      });
    });
    this.root.querySelector('#rewrite-cancel')?.addEventListener('click', () => this.render());
  }
}

/** The paragraph containing `offset`, passed to the model as context only. */
function paragraphAround(text: string, offset: number): string {
  const before = text.lastIndexOf('\n\n', offset);
  const after = text.indexOf('\n\n', offset);
  return text.slice(before === -1 ? 0 : before + 2, after === -1 ? text.length : after).trim();
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}
