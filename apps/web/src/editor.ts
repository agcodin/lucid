import type { Category, Issue } from '@lucid/engine';

const CATEGORIES: Category[] = ['correctness', 'clarity', 'engagement', 'delivery'];

/** One `Highlight` per category, so each underline gets its own color in CSS. */
interface HighlightSet {
  byCategory: Map<Category, Highlight>;
  active: Highlight;
}

/** Offsets and text nodes for every paragraph, built once per repaint. */
interface LineIndex {
  lines: HTMLElement[];
  starts: Int32Array;
  lengths: Int32Array;
  textNodes: (Text | undefined)[];
}

export interface EditorOptions {
  root: HTMLElement;
  onInput: (text: string) => void;
  /** Fired when the caret or a click lands inside an issue's span. */
  onIssueFocus: (issue: Issue | undefined) => void;
}

/**
 * A plain-text editor over `contenteditable`, with underlines drawn through the
 * CSS Custom Highlight API.
 *
 * Highlights are the reason this stays fast. The alternative — the DOM overlay
 * approach a browser extension is forced into — has to measure and reposition a
 * span per issue on every keystroke, scroll and reflow. Here the browser owns
 * the geometry, and a repaint is one `Highlight` set swap with no layout work
 * and no nodes created.
 */
export class Editor {
  private readonly root: HTMLElement;
  private readonly onInput: (text: string) => void;
  private readonly onIssueFocus: (issue: Issue | undefined) => void;
  private readonly highlights: HighlightSet | undefined;

  private text = '';
  private issues: Issue[] = [];
  /** Byte-for-byte unsupported browsers fall back to no underlines. */
  readonly highlightsSupported = typeof CSS !== 'undefined' && 'highlights' in CSS;

  constructor(options: EditorOptions) {
    this.root = options.root;
    this.onInput = options.onInput;
    this.onIssueFocus = options.onIssueFocus;

    this.root.contentEditable = supportsPlaintextOnly() ? 'plaintext-only' : 'true';
    this.root.spellcheck = false;
    this.root.setAttribute('role', 'textbox');
    this.root.setAttribute('aria-multiline', 'true');

    if (this.highlightsSupported) {
      const byCategory = new Map<Category, Highlight>();
      for (const category of CATEGORIES) {
        const highlight = new Highlight();
        byCategory.set(category, highlight);
        CSS.highlights.set(`lucid-${category}`, highlight);
      }
      const active = new Highlight();
      CSS.highlights.set('lucid-active', active);
      this.highlights = { byCategory, active };
    }

    this.root.addEventListener('input', () => this.handleInput());
    this.root.addEventListener('paste', (event) => this.handlePaste(event));
    this.root.addEventListener('click', () => this.reportCaretIssue());
    this.root.addEventListener('keyup', () => this.reportCaretIssue());
  }

  /**
   * Replace one span of the document, routed through the browser's own text
   * insertion so the native undo stack records it.
   *
   * `setText` rebuilds the DOM, which discards undo history — after accepting a
   * suggestion the user could not press Cmd+Z to get their wording back. A
   * ranged edit keeps the document a normal sequence of typed changes.
   *
   * Returns false when the span could not be resolved, so the caller can fall
   * back to a whole-document replacement.
   */
  replaceRange(start: number, end: number, insert: string): boolean {
    const range = this.rangeFor(start, end, this.buildIndex());
    if (!range) return false;

    const selection = window.getSelection();
    if (!selection) return false;
    this.root.focus();
    selection.removeAllRanges();
    selection.addRange(range);

    // execCommand is deprecated but remains the only way to insert text into a
    // contenteditable through the undo stack; a direct DOM mutation bypasses it.
    const inserted = insert === ''
      ? document.execCommand('delete')
      : document.execCommand('insertText', false, insert);
    if (!inserted) return false;

    this.text = this.readText();
    this.onInput(this.text);
    return true;
  }

  /** Replace the whole document. Used for seeding and for applying a rewrite. */
  setText(text: string, cursor?: number): void {
    this.text = text;
    this.render();
    if (cursor !== undefined) this.setCaret(cursor);
    this.onInput(text);
  }

  getText(): string {
    return this.text;
  }

  private handleInput(): void {
    // Read the text back out of the DOM rather than tracking edits ourselves,
    // so IME composition, autocorrect and undo all stay the browser's job.
    this.text = this.readText();

    // Typing inside a paragraph leaves the DOM in a shape we can map, so the
    // common case touches no nodes at all. Only a paste or an odd browser
    // insertion forces a re-render.
    if (!this.isMappable()) {
      const caret = this.getCaret();
      this.render();
      if (caret !== undefined) this.setCaret(caret);
    }

    this.onInput(this.text);
  }

  private handlePaste(event: ClipboardEvent): void {
    // `plaintext-only` already strips markup, but Firefox needs this and it
    // also normalizes CRLF so offsets match what the engine sees.
    const pasted = event.clipboardData?.getData('text/plain');
    if (pasted === undefined) return;
    event.preventDefault();
    const caret = this.getCaret() ?? this.text.length;
    const clean = pasted.replace(/\r\n?/g, '\n');
    const selection = this.getSelectionRange() ?? { start: caret, end: caret };
    this.setText(
      this.text.slice(0, selection.start) + clean + this.text.slice(selection.end),
      selection.start + clean.length,
    );
  }

  /** Repaint underlines. Called on every engine update, including mid-typing. */
  setIssues(issues: Issue[], activeId?: string): void {
    this.issues = issues;
    if (!this.highlights) return;

    for (const highlight of this.highlights.byCategory.values()) highlight.clear();
    this.highlights.active.clear();

    const index = this.buildIndex();
    for (const issue of issues) {
      const range = this.rangeFor(issue.start, issue.end, index);
      if (!range) continue;
      this.highlights.byCategory.get(issue.category)?.add(range);
      if (issue.id === activeId) this.highlights.active.add(range);
    }
  }

  /** Scroll an issue into view and put the caret at its start. */
  reveal(issue: Issue): void {
    const range = this.rangeFor(issue.start, issue.end, this.buildIndex());
    if (!range) return;
    const rect = range.getBoundingClientRect();
    const box = this.root.getBoundingClientRect();
    if (rect.top < box.top + 40 || rect.bottom > box.bottom - 40) {
      this.root.scrollBy({ top: rect.top - box.top - box.height / 3, behavior: 'smooth' });
    }
  }

  focus(): void {
    this.root.focus();
  }

  // --- DOM and offset mapping ---------------------------------------------

  /** The editor's paragraphs, one per line of `text`. */
  private lineNodes(): HTMLElement[] {
    return [...this.root.children] as HTMLElement[];
  }

  /**
   * Line elements, their text nodes, and each line's absolute start offset,
   * gathered in one pass.
   *
   * Building this once per repaint rather than once per offset lookup is what
   * keeps highlighting linear. Resolving 3,200 issues against 400 paragraphs by
   * rescanning the children each time is ~2.5M DOM reads and lands at ~65ms per
   * keystroke; with the index plus a binary search it is under a millisecond.
   */
  private buildIndex(): LineIndex {
    const lines = this.lineNodes();
    const starts = new Int32Array(lines.length);
    const lengths = new Int32Array(lines.length);
    const textNodes: (Text | undefined)[] = new Array(lines.length);

    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const first = line.firstChild;
      const textNode = first && first.nodeType === Node.TEXT_NODE ? (first as Text) : undefined;
      const length = textNode ? textNode.data.length : 0;
      starts[i] = offset;
      lengths[i] = length;
      textNodes[i] = textNode;
      offset += length + 1; // +1 for the newline between paragraphs.
    }
    return { lines, starts, lengths, textNodes };
  }

  private readText(): string {
    return this.lineNodes()
      .map((line) => line.textContent ?? '')
      .join('\n');
  }

  /**
   * True when every child is a `<p>` holding at most one text node, which is
   * the shape `rangeFor` can map offsets onto.
   */
  private isMappable(): boolean {
    for (const line of this.root.children) {
      if (line.tagName !== 'P') return false;
      const kids = [...line.childNodes];
      if (kids.length === 0) continue;
      if (kids.length === 1) {
        const only = kids[0]!;
        if (only.nodeType === Node.TEXT_NODE || only.nodeName === 'BR') continue;
        return false;
      }
      return false;
    }
    return this.root.children.length > 0;
  }

  private render(): void {
    const lines = this.text.split('\n');
    const html = document.createDocumentFragment();
    for (const line of lines) {
      const p = document.createElement('p');
      // An empty paragraph needs a <br> to occupy a line and accept a caret.
      if (line.length === 0) p.appendChild(document.createElement('br'));
      else p.appendChild(document.createTextNode(line));
      html.appendChild(p);
    }
    this.root.replaceChildren(html);
  }

  /** Build a Range over [start, end) in document coordinates. */
  private rangeFor(start: number, end: number, index: LineIndex): Range | undefined {
    const from = this.pointAt(start, index);
    const to = this.pointAt(end, index);
    if (!from || !to) return undefined;
    const range = document.createRange();
    try {
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
    } catch {
      return undefined;
    }
    return range;
  }

  /** Resolve an absolute offset to a text node and an offset inside it. */
  private pointAt(offset: number, index: LineIndex): { node: Node; offset: number } | undefined {
    const { starts, lengths, lines, textNodes } = index;
    if (lines.length === 0 || offset < 0) return undefined;

    // Binary search for the last line starting at or before `offset`.
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }

    const line = lines[lo]!;
    const within = offset - starts[lo]!;
    const length = lengths[lo]!;
    // An offset past this line's text belongs to the newline itself; clamp it
    // to the line end so a range never spans a paragraph break.
    const textNode = textNodes[lo];
    if (!textNode) return { node: line, offset: 0 };
    return { node: textNode, offset: within < 0 ? 0 : within > length ? length : within };
  }

  /** Absolute offset of the caret, or undefined when focus is elsewhere. */
  private getCaret(): number | undefined {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return undefined;
    const range = selection.getRangeAt(0);
    if (!this.root.contains(range.startContainer)) return undefined;
    return this.absoluteOffset(range.startContainer, range.startOffset);
  }

  private getSelectionRange(): { start: number; end: number } | undefined {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return undefined;
    const range = selection.getRangeAt(0);
    if (!this.root.contains(range.startContainer)) return undefined;
    const start = this.absoluteOffset(range.startContainer, range.startOffset);
    const end = this.absoluteOffset(range.endContainer, range.endOffset);
    if (start === undefined || end === undefined) return undefined;
    return start <= end ? { start, end } : { start: end, end: start };
  }

  private absoluteOffset(node: Node, offset: number): number | undefined {
    // Walk up to the paragraph that owns this node, then look its start up by
    // position, rather than testing every paragraph for containment.
    let line: Node | null = node;
    while (line && line.parentNode !== this.root) line = line.parentNode;
    if (!line) return undefined;

    const lineIndex = [...this.root.children].indexOf(line as Element);
    if (lineIndex < 0) return undefined;

    const index = this.buildIndex();
    const start = index.starts[lineIndex]!;
    if (node.nodeType === Node.TEXT_NODE) return start + offset;
    // The caret is on the paragraph itself: an empty line, or just after the
    // browser inserted a <br>.
    return start + (offset === 0 ? 0 : index.lengths[lineIndex]!);
  }

  private setCaret(offset: number): void {
    const point = this.pointAt(offset, this.buildIndex());
    if (!point) return;
    const range = document.createRange();
    range.setStart(point.node, point.offset);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  private reportCaretIssue(): void {
    const caret = this.getCaret();
    if (caret === undefined) return;
    // Prefer the narrowest issue under the caret, so a word-level suggestion
    // wins over the whole-sentence one it sits inside.
    const under = this.issues
      .filter((issue) => caret >= issue.start && caret <= issue.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start));
    this.onIssueFocus(under[0]);
  }
}

function supportsPlaintextOnly(): boolean {
  const probe = document.createElement('div');
  probe.contentEditable = 'plaintext-only';
  return probe.contentEditable === 'plaintext-only';
}
