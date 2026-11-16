import type { Category, EngineState, EngineStats, Issue } from '@lucid/engine';

/** Shown in shortcut hints. Mac uses the command key, everything else Ctrl. */
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  ? '\u2318'
  : 'Ctrl';

export const CATEGORY_LABELS: Record<Category, string> = {
  correctness: 'Correctness',
  clarity: 'Clarity',
  engagement: 'Engagement',
  delivery: 'Delivery',
};

const CATEGORY_BLURB: Record<Category, string> = {
  correctness: 'Spelling, grammar and punctuation',
  clarity: 'Wordiness, passive voice, sentence length',
  engagement: 'Word choice, filler, variety',
  delivery: 'Tone, confidence, how it lands',
};

export interface SidebarHandlers {
  onSelect: (issue: Issue) => void;
  onApply: (issue: Issue, replacement: string) => void;
  onDismiss: (issue: Issue) => void;
  onAddToDictionary: (word: string) => void;
  onFilter: (category: Category | 'all') => void;
}

/**
 * How many cards to put in the DOM at once.
 *
 * A long document can carry thousands of suggestions, and rendering a card for
 * each one cost 170ms per update on an 11,800-word draft, which lands on the
 * typing path. Nobody reads past the first screenful, so the list is a window
 * onto the issues rather than all of them.
 */
const MAX_CARDS = 60;

export class Sidebar {
  /** False on a browser without the CSS Custom Highlight API, so the list is all there is. */
  highlightsSupported = true;
  private readonly root: HTMLElement;
  /**
   * The live region lives outside the re-rendered markup. A screen reader
   * watches a node that is already in the accessibility tree, so replacing the
   * element on every render would stop it announcing anything.
   */
  private readonly live: HTMLElement;
  private readonly slots = new Map<string, HTMLElement>();
  private readonly lastHtml = new Map<string, string>();
  private readonly handlers: SidebarHandlers;
  private filter: Category | 'all' = 'all';
  private activeId: string | undefined;
  private state: EngineState | undefined;
  private text = '';

  constructor(root: HTMLElement, handlers: SidebarHandlers) {
    this.root = root;
    this.handlers = handlers;

    this.live = document.createElement('p');
    this.live.className = 'sr-only';
    this.live.setAttribute('role', 'status');
    this.live.setAttribute('aria-live', 'polite');
    root.before(this.live);

    // The shell is built once. Replacing the whole sidebar on every update
    // rebuilt 60 cards and rebound their listeners on the typing path, so each
    // section is written separately and only when its own markup changes.
    root.innerHTML = `
      <div class="panel score-panel" data-slot="score"></div>
      <div class="tabs" role="tablist" aria-label="Filter suggestions by category" data-slot="tabs"></div>
      <div class="issues" role="list" data-slot="issues"></div>
      <div data-slot="more"></div>
      <div class="panel" data-slot="tone"></div>
      <div class="panel" data-slot="readability"></div>
      <div class="panel legend" data-slot="legend"></div>
      <div class="panel perf" data-slot="engine"></div>
    `;
    for (const node of root.querySelectorAll<HTMLElement>('[data-slot]')) {
      this.slots.set(node.dataset.slot!, node);
    }
    this.bindDelegates();
  }

  /**
   * Write `html` into a section only when it differs from what is there, so an
   * unchanged list of cards keeps its DOM nodes and its event listeners.
   * Returns true when the section was rewritten.
   */
  private put(slot: string, html: string): boolean {
    const node = this.slots.get(slot)!;
    if (this.lastHtml.get(slot) === html) return false;
    this.lastHtml.set(slot, html);
    node.innerHTML = html;
    return true;
  }

  setActive(id: string | undefined): void {
    if (this.activeId === id) return;
    this.activeId = id;
    this.applyActive();
  }

  render(state: EngineState, text: string): void {
    this.state = state;
    this.text = text;
    const { report, stats } = state;
    const visible = this.visibleIssues(state.issues);
    const shown = this.window(visible);

    this.put('score', `
      ${scoreRing(report.score)}
      <div class="score-meta">
        <div class="score-label">Writing score</div>
        <div class="score-sub">${report.readability.words} words &middot; ${formatSeconds(report.readability.readingSeconds)} read</div>
      </div>`);

    this.put('tabs', [
      tab('all', 'All', state.issues.length, this.filter),
      ...(Object.keys(CATEGORY_LABELS) as Category[])
        .map((category) => tab(category, CATEGORY_LABELS[category], report.counts[category], this.filter)),
    ].join(''));

    const cards = visible.length === 0
      ? this.emptyState()
      : shown.map((issue) => this.card(issue)).join('');
    this.put('issues', cards);

    this.put('more', visible.length > shown.length
      ? `<p class="more">Showing ${shown.length} of ${visible.length}. Fix some, or filter by category.</p>`
      : '');

    this.put('tone', `
      <h3>Tone</h3>
      <div class="chips">
        ${report.tone.labels.map((entry) => `<span class="chip tone-chip">${entry.label}</span>`).join('')}
      </div>
      ${meter('Formality', report.tone.formality, 'Casual', 'Formal')}
      ${meter('Confidence', report.tone.confidence, 'Hedged', 'Assertive')}`);

    this.put('readability', `
      <h3>Readability</h3>
      <dl class="metrics">
        ${metric('Reading ease', report.readability.flesch.toFixed(0), fleschBand(report.readability.flesch))}
        ${metric('Grade level', report.readability.grade.toFixed(1), 'US school grade')}
        ${metric('Avg sentence', `${report.readability.avgSentenceLength}`, 'words')}
        ${metric('Passive voice', `${Math.round(report.readability.passiveRatio * 100)}%`, 'of sentences')}
        ${metric('Complex words', `${Math.round(report.readability.complexWordRatio * 100)}%`, '3+ syllables')}
      </dl>`);

    this.put('legend', `
      <h3>Underlines</h3>
      ${(Object.keys(CATEGORY_LABELS) as Category[])
        .map((category) => `<div class="legend-row">
          <span class="legend-mark ${category}">abc</span>
          <span class="legend-text"><strong>${CATEGORY_LABELS[category]}</strong>${CATEGORY_BLURB[category]}</span>
        </div>`)
        .join('')}`);

    this.put('engine', `
      <h3>Engine</h3>
      <dl class="metrics">
        ${metric('Rules tier', `${stats.rulesMs.toFixed(2)}ms`, 'per keystroke, main thread')}
        ${metric('Harper tier', `${stats.harperMs.toFixed(1)}ms`, 'per edit, in a worker')}
        ${metric('Blocks', `${stats.dirtyBlocks} / ${stats.blocks}`, 'relinted / total')}
        ${metric('Cache', `${stats.harperBlocksCached}`, 'blocks reused last run')}
        ${metric('Rules loaded', `${(stats.phraseRules + stats.harperRules).toLocaleString()}`, `${stats.harperRules} Harper + ${stats.phraseRules} phrase`)}
      </dl>
      <div class="engine-status ${engineStatusClass(stats)}">${engineStatusText(stats)}</div>
      ${this.highlightsSupported ? '' : `<div class="engine-status warn">
        This browser cannot paint underlines. Suggestions are listed here instead.
      </div>`}`);

    this.live.textContent =
      `${visible.length} ${visible.length === 1 ? 'suggestion' : 'suggestions'}`
      + (this.filter === 'all' ? '' : ` in ${CATEGORY_LABELS[this.filter as Category]}`);

    this.applyActive();
  }

  private visibleIssues(issues: Issue[]): Issue[] {
    return this.filter === 'all' ? issues : issues.filter((issue) => issue.category === this.filter);
  }

  /**
   * The slice of issues to put in the DOM, kept around the active one so
   * selecting an issue further down the document still shows its card.
   */
  private window(visible: Issue[]): Issue[] {
    if (visible.length <= MAX_CARDS) return visible;
    const active = visible.findIndex((issue) => issue.id === this.activeId);
    if (active < MAX_CARDS) return visible.slice(0, MAX_CARDS);
    const start = Math.min(active - Math.floor(MAX_CARDS / 2), visible.length - MAX_CARDS);
    return visible.slice(start, start + MAX_CARDS);
  }

  private emptyState(): string {
    if (!this.state) return '';
    const total = this.state.issues.length;
    if (total === 0 && this.state.report.readability.words > 0) {
      return `<div class="empty"><strong>Nothing to flag.</strong><span>This reads clean.</span></div>`;
    }
    if (total === 0) {
      return `<div class="empty"><strong>Start writing.</strong><span>Suggestions appear as you type.</span></div>`;
    }
    return `<div class="empty"><strong>Nothing in ${CATEGORY_LABELS[this.filter as Category]}.</strong><span>${CATEGORY_BLURB[this.filter as Category]}</span></div>`;
  }

  private card(issue: Issue): string {
    const span = this.text.slice(issue.start, issue.end);
    const isSpelling = issue.rule === 'harper:Spelling';
    return `
      <article class="card ${issue.category} ${issue.id === this.activeId ? 'active' : ''}"
        data-id="${escapeAttr(issue.id)}"
        tabindex="0"
        role="group"
        aria-label="${escapeAttr(`${CATEGORY_LABELS[issue.category]}: ${issue.title}`)}"
        ${issue.id === this.activeId ? 'aria-current="true"' : ''}>
        <header>
          <span class="dot"></span>
          <span class="card-title">${escapeHtml(issue.title)}</span>
        </header>
        <div class="card-span">${escapeHtml(truncate(span, 90))}</div>
        ${issue.replacements.length > 0
          ? `<div class="chips">${issue.replacements
              .slice(0, 4)
              .map(
                (replacement, i) =>
                  `<button class="chip apply" data-i="${i}">${escapeHtml(replacement.label ?? replacement.text)}</button>`,
              )
              .join('')}</div>`
          : ''}
        ${issue.detail ? `<p class="card-detail">${escapeHtml(stripTags(issue.detail))}</p>` : ''}
        ${issue.replacements.length > 0
          ? `<div class="shortcut"><kbd>${MOD}</kbd><kbd>&crarr;</kbd> accept &middot; <kbd>${MOD}</kbd><kbd>.</kbd> next</div>`
          : ''}
        <footer>
          <span class="rule">${escapeHtml(issue.rule)}</span>
          <span class="actions">
            ${isSpelling ? `<button class="link dict">Add to dictionary</button>` : ''}
            <button class="link dismiss">Dismiss</button>
          </span>
        </footer>
      </article>
    `;
  }

  /**
   * Move the active outline by toggling classes. The shortcut hint sits in
   * every card and is revealed by CSS, so selecting an issue never rebuilds
   * the list — which on a long document would mean thousands of cards.
   */
  private applyActive(): void {
    let found = false;
    for (const card of this.root.querySelectorAll<HTMLElement>('.card')) {
      const isActive = card.dataset.id === this.activeId;
      if (isActive) found = true;
      card.classList.toggle('active', isActive);
      if (isActive) card.setAttribute('aria-current', 'true');
      else card.removeAttribute('aria-current');
    }
    // The selected issue can sit outside the rendered window on a long
    // document, and then the list does have to move to it.
    if (!found && this.activeId !== undefined && this.state) {
      const visible = this.visibleIssues(this.state.issues);
      const cards = this.window(visible).map((issue) => this.card(issue)).join('');
      if (this.put('issues', cards)) this.applyActive();
    }
  }

  /**
   * One delegated listener per container, attached once.
   *
   * Binding four listeners to each of 60 cards on every render was most of the
   * sidebar's cost, and it had to be redone every time the list changed. The
   * card carries its issue id, so the container can find the issue itself.
   */
  private bindDelegates(): void {
    const issues = this.slots.get('issues')!;

    issues.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const card = target.closest<HTMLElement>('.card');
      const issue = this.issueFor(card);
      if (!issue) return;

      const apply = target.closest<HTMLElement>('.apply');
      if (apply) {
        const replacement = issue.replacements[Number(apply.dataset.i)];
        if (replacement) this.handlers.onApply(issue, replacement.text);
        return;
      }
      if (target.closest('.dismiss')) {
        this.handlers.onDismiss(issue);
        return;
      }
      if (target.closest('.dict')) {
        this.handlers.onAddToDictionary(this.text.slice(issue.start, issue.end));
        return;
      }
      this.handlers.onSelect(issue);
    });

    issues.addEventListener('keydown', (event) => {
      // Only the card itself; the nested buttons handle their own keys.
      const card = event.target as HTMLElement;
      if (!card.classList?.contains('card')) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const issue = this.issueFor(card);
      if (!issue) return;
      event.preventDefault();
      this.handlers.onSelect(issue);
    });

    this.slots.get('tabs')!.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('.tab');
      if (!button) return;
      this.filter = (button.dataset.filter ?? 'all') as Category | 'all';
      this.handlers.onFilter(this.filter);
      if (this.state) this.render(this.state, this.text);
    });
  }

  private issueFor(card: HTMLElement | null): Issue | undefined {
    if (!card || !this.state) return undefined;
    return this.state.issues.find((issue) => issue.id === card.dataset.id);
  }
}


/** What the engine panel says about tier 1, including when it has failed. */
function engineStatusText(stats: EngineStats): string {
  if (stats.error) {
    return `Grammar checking is unavailable: ${escapeHtml(stats.error)}. Clarity, engagement and delivery still work. Keep typing to retry.`;
  }
  if (stats.ready) return `Harper ready, loaded in ${stats.harperSetupMs}ms`;
  return 'Loading Harper WASM&hellip;';
}

function engineStatusClass(stats: EngineStats): string {
  if (stats.error) return 'warn';
  return stats.ready ? 'ok' : '';
}

function tab(id: string, label: string, count: number, active: string): string {
  const on = id === active;
  return `<button class="tab ${on ? 'on' : ''}" data-filter="${id}" role="tab"
    aria-selected="${on}"
    aria-label="${label}, ${count} ${count === 1 ? 'suggestion' : 'suggestions'}">
    ${label}<span class="count" aria-hidden="true">${count}</span>
  </button>`;
}

function scoreRing(score: number): string {
  const circumference = 2 * Math.PI * 26;
  const filled = (score / 100) * circumference;
  return `<svg class="ring" viewBox="0 0 60 60" aria-label="Writing score ${score} out of 100">
    <circle cx="30" cy="30" r="26" class="ring-track" />
    <circle cx="30" cy="30" r="26" class="ring-fill" stroke-dasharray="${filled} ${circumference}" />
    <text x="30" y="30" class="ring-text">${score}</text>
  </svg>`;
}

function meter(label: string, value: number, low: string, high: string): string {
  return `<div class="meter">
    <div class="meter-head"><span>${label}</span></div>
    <div class="meter-track"><div class="meter-dot" style="left:${(value * 100).toFixed(0)}%"></div></div>
    <div class="meter-ends"><span>${low}</span><span>${high}</span></div>
  </div>`;
}

function metric(label: string, value: string, note: string): string {
  return `<div class="metric"><dt>${label}</dt><dd><strong>${value}</strong><span>${note}</span></dd></div>`;
}

function fleschBand(flesch: number): string {
  if (flesch >= 80) return 'very easy';
  if (flesch >= 60) return 'plain English';
  if (flesch >= 50) return 'fairly hard';
  if (flesch >= 30) return 'difficult';
  return 'very difficult';
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}

function escapeAttr(text: string): string {
  return escapeHtml(text);
}
