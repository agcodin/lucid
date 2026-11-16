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

export class Sidebar {
  /** False on a browser without the CSS Custom Highlight API, so the list is all there is. */
  highlightsSupported = true;
  private readonly root: HTMLElement;
  private readonly handlers: SidebarHandlers;
  private filter: Category | 'all' = 'all';
  private activeId: string | undefined;
  private state: EngineState | undefined;
  private text = '';

  constructor(root: HTMLElement, handlers: SidebarHandlers) {
    this.root = root;
    this.handlers = handlers;
  }

  setActive(id: string | undefined): void {
    if (this.activeId === id) return;
    this.activeId = id;
    this.renderActiveOnly();
  }

  render(state: EngineState, text: string): void {
    this.state = state;
    this.text = text;
    const { report, stats } = state;
    const visible = this.visibleIssues(state.issues);

    this.root.innerHTML = `
      <div class="panel score-panel">
        ${scoreRing(report.score)}
        <div class="score-meta">
          <div class="score-label">Writing score</div>
          <div class="score-sub">${report.readability.words} words &middot; ${formatSeconds(report.readability.readingSeconds)} read</div>
        </div>
      </div>

      <div class="tabs" role="tablist" aria-label="Filter suggestions by category">
        ${tab('all', 'All', state.issues.length, this.filter)}
        ${(Object.keys(CATEGORY_LABELS) as Category[])
          .map((category) => tab(category, CATEGORY_LABELS[category], report.counts[category], this.filter))
          .join('')}
      </div>

      <p class="sr-only" role="status" aria-live="polite">
        ${visible.length} ${visible.length === 1 ? 'suggestion' : 'suggestions'}${this.filter === 'all' ? '' : ` in ${CATEGORY_LABELS[this.filter as Category]}`}
      </p>

      <div class="issues" role="list">
        ${visible.length === 0 ? this.emptyState() : visible.map((issue) => this.card(issue)).join('')}
      </div>

      <div class="panel">
        <h3>Tone</h3>
        <div class="chips">
          ${report.tone.labels.map((entry) => `<span class="chip tone-chip">${entry.label}</span>`).join('')}
        </div>
        ${meter('Formality', report.tone.formality, 'Casual', 'Formal')}
        ${meter('Confidence', report.tone.confidence, 'Hedged', 'Assertive')}
      </div>

      <div class="panel">
        <h3>Readability</h3>
        <dl class="metrics">
          ${metric('Reading ease', report.readability.flesch.toFixed(0), fleschBand(report.readability.flesch))}
          ${metric('Grade level', report.readability.grade.toFixed(1), 'US school grade')}
          ${metric('Avg sentence', `${report.readability.avgSentenceLength}`, 'words')}
          ${metric('Passive voice', `${Math.round(report.readability.passiveRatio * 100)}%`, 'of sentences')}
          ${metric('Complex words', `${Math.round(report.readability.complexWordRatio * 100)}%`, '3+ syllables')}
        </dl>
      </div>

      <div class="panel legend">
        <h3>Underlines</h3>
        ${(Object.keys(CATEGORY_LABELS) as Category[])
          .map((category) => `<div class="legend-row">
            <span class="legend-mark ${category}">abc</span>
            <span class="legend-text"><strong>${CATEGORY_LABELS[category]}</strong>${CATEGORY_BLURB[category]}</span>
          </div>`)
          .join('')}
      </div>

      <div class="panel perf">
        <h3>Engine</h3>
        <dl class="metrics">
          ${metric('Rules tier', `${stats.rulesMs.toFixed(2)}ms`, 'per keystroke, main thread')}
          ${metric('Harper tier', `${stats.harperMs.toFixed(1)}ms`, 'per edit, in a worker')}
          ${metric('Blocks', `${stats.dirtyBlocks} / ${stats.blocks}`, 'relinted / total')}
          ${metric('Cache', `${stats.harperBlocksCached}`, 'blocks reused last run')}
          ${metric('Rules loaded', `${(stats.phraseRules + stats.harperRules).toLocaleString()}`, `${stats.harperRules} Harper + ${stats.phraseRules} phrase`)}
        </dl>
        <div class="engine-status ${engineStatusClass(stats)}">
          ${engineStatusText(stats)}
        </div>
        ${this.highlightsSupported ? '' : `<div class="engine-status warn">
          This browser cannot paint underlines. Suggestions are listed here instead.
        </div>`}
      </div>
    `;

    this.bind();
  }

  private visibleIssues(issues: Issue[]): Issue[] {
    return this.filter === 'all' ? issues : issues.filter((issue) => issue.category === this.filter);
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
        ${issue.id === this.activeId && issue.replacements.length > 0
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
   * Move the active outline without rebuilding the list, so clicks feel
   * instant. The shortcut hint belongs to the active card, so it moves too.
   */
  private renderActiveOnly(): void {
    if (!this.state) return;
    const active = this.root.querySelector('.card.active');
    const next = this.root.querySelector(`.card[data-id="${CSS.escape(this.activeId ?? '')}"]`);
    // Rebuilding is only needed when the hint has to move between cards.
    if (active !== next) {
      this.render(this.state, this.text);
      return;
    }
    for (const card of this.root.querySelectorAll<HTMLElement>('.card')) {
      card.classList.toggle('active', card.dataset.id === this.activeId);
    }
  }

  private bind(): void {
    for (const button of this.root.querySelectorAll<HTMLElement>('.tab')) {
      button.addEventListener('click', () => {
        this.filter = (button.dataset.filter ?? 'all') as Category | 'all';
        this.handlers.onFilter(this.filter);
        if (this.state) this.render(this.state, this.text);
      });
    }

    for (const card of this.root.querySelectorAll<HTMLElement>('.card')) {
      const issue = this.state?.issues.find((candidate) => candidate.id === card.dataset.id);
      if (!issue) continue;

      card.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        this.handlers.onSelect(issue);
      });

      // The card is focusable, so Enter and Space have to do what a click does.
      card.addEventListener('keydown', (event) => {
        if (event.target !== card) return; // Let the nested buttons handle their own keys.
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        this.handlers.onSelect(issue);
      });

      card.querySelectorAll<HTMLElement>('.apply').forEach((button) => {
        button.addEventListener('click', () => {
          const index = Number(button.dataset.i);
          const replacement = issue.replacements[index];
          if (replacement) this.handlers.onApply(issue, replacement.text);
        });
      });

      card.querySelector('.dismiss')?.addEventListener('click', () => this.handlers.onDismiss(issue));
      card.querySelector('.dict')?.addEventListener('click', () =>
        this.handlers.onAddToDictionary(this.text.slice(issue.start, issue.end)),
      );
    }
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
