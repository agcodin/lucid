import { DEFAULT_RULE_CONFIG } from '@lucid/engine';
import type { Category, RuleConfig } from '@lucid/engine';
import { CATEGORY_LABELS } from './sidebar.js';

const STORAGE = 'lucid.rules';
const DICTIONARY_STORAGE = 'lucid.dictionary';

/** Rule groups worth switching off on their own, as opposed to whole categories. */
const GROUPS: { id: string; label: string; note: string; category: Category }[] = [
  { id: 'clarity:passive', label: 'Passive voice', note: 'Common in scientific and formal writing', category: 'clarity' },
  { id: 'clarity:sentence', label: 'Long sentences', note: 'Over 30 words', category: 'clarity' },
  { id: 'clarity:wordy', label: 'Wordy phrases', note: '"in order to", "due to the fact that"', category: 'clarity' },
  { id: 'clarity:nominalization', label: 'Nouns built from verbs', note: '"the implementation of"', category: 'clarity' },
  { id: 'engagement:filler', label: 'Filler words', note: '"very", "really", "just"', category: 'engagement' },
  { id: 'engagement:cliche', label: 'Clichés', note: '"move the needle", "low hanging fruit"', category: 'engagement' },
  { id: 'delivery:hedge', label: 'Hedging', note: '"I think", "sorry to bother you"', category: 'delivery' },
];

export function loadRuleConfig(): RuleConfig {
  try {
    const stored = localStorage.getItem(STORAGE);
    if (!stored) return DEFAULT_RULE_CONFIG;
    const parsed = JSON.parse(stored) as Partial<RuleConfig>;
    return {
      categories: { ...DEFAULT_RULE_CONFIG.categories, ...parsed.categories },
      disabledRules: Array.isArray(parsed.disabledRules) ? parsed.disabledRules : [],
    };
  } catch {
    // Unreadable or blocked storage falls back to showing everything.
    return DEFAULT_RULE_CONFIG;
  }
}

function save(config: RuleConfig): void {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(config));
  } catch {
    // Not persisting is survivable; the config still applies this session.
  }
}

export function loadDictionary(): string[] {
  try {
    const stored = localStorage.getItem(DICTIONARY_STORAGE);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.filter((word): word is string => typeof word === 'string') : [];
  } catch {
    return [];
  }
}

function saveDictionary(words: string[]): void {
  try {
    localStorage.setItem(DICTIONARY_STORAGE, JSON.stringify(words));
  } catch {
    // Not persisting is survivable; the words still apply this session.
  }
}

export class SettingsPanel {
  private readonly root: HTMLElement;
  private readonly onChange: (config: RuleConfig) => void;
  private readonly onDictionaryChange: (words: string[]) => void;
  private config: RuleConfig;
  private dictionary: string[];

  constructor(
    root: HTMLElement,
    config: RuleConfig,
    dictionary: string[],
    onChange: (config: RuleConfig) => void,
    onDictionaryChange: (words: string[]) => void,
  ) {
    this.root = root;
    this.config = config;
    this.dictionary = dictionary;
    this.onChange = onChange;
    this.onDictionaryChange = onDictionaryChange;
    this.render();
  }

  /** Keep the listed words in step when one is added from a suggestion card. */
  setDictionary(words: string[]): void {
    this.dictionary = words;
    saveDictionary(words);
    this.render();
  }

  private update(next: RuleConfig): void {
    this.config = next;
    save(next);
    this.onChange(next);
    this.render();
  }

  private render(): void {
    const categories = Object.keys(CATEGORY_LABELS) as Category[];
    this.root.innerHTML = `
      <h3>Categories</h3>
      ${categories.map((category) => toggle(category, CATEGORY_LABELS[category], '', this.config.categories[category])).join('')}

      <h3 class="spaced">Individual rules</h3>
      ${GROUPS.map((group) => {
        const categoryOff = !this.config.categories[group.category];
        const on = !this.config.disabledRules.includes(group.id);
        return toggle(group.id, group.label, group.note, on && !categoryOff, categoryOff);
      }).join('')}

      <h3 class="spaced">Your dictionary</h3>
      <div class="dictionary">
        ${this.dictionary.length === 0
          ? '<p class="dictionary-empty">Words you add from a spelling suggestion appear here, and you can take them back out.</p>'
          : this.dictionary
              .map((word) => `<span class="word">${escapeHtml(word)}<button data-word="${escapeHtml(word)}" aria-label="Remove ${escapeHtml(word)}">&times;</button></span>`)
              .join('')}
      </div>
    `;

    for (const button of this.root.querySelectorAll<HTMLElement>('.word button')) {
      button.addEventListener('click', () => {
        const next = this.dictionary.filter((word) => word !== button.dataset.word);
        this.dictionary = next;
        saveDictionary(next);
        this.onDictionaryChange(next);
        this.render();
      });
    }

    for (const input of this.root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
      input.addEventListener('change', () => {
        const id = input.dataset.id!;
        if (categories.includes(id as Category)) {
          this.update({
            ...this.config,
            categories: { ...this.config.categories, [id]: input.checked },
          });
          return;
        }
        const disabled = new Set(this.config.disabledRules);
        if (input.checked) disabled.delete(id);
        else disabled.add(id);
        this.update({ ...this.config, disabledRules: [...disabled] });
      });
    }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}

function toggle(id: string, label: string, note: string, on: boolean, disabled = false): string {
  return `<label class="toggle ${disabled ? 'off' : ''}">
    <input type="checkbox" data-id="${id}" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
    <span class="toggle-text">
      <strong>${label}</strong>
      ${note ? `<span>${note}</span>` : ''}
    </span>
  </label>`;
}
