import { DEFAULT_RULE_CONFIG } from '@lucid/engine';
import type { Category, RuleConfig } from '@lucid/engine';

/**
 * Preferences, kept in `chrome.storage.sync` so they follow the user between
 * devices rather than living in one page's storage.
 *
 * Reads fall back to the defaults when storage is unavailable, which happens
 * in a page the extension was injected into before the service worker woke up.
 */
export interface Prefs {
  rules: RuleConfig;
  dictionary: string[];
}

const KEY = 'lucid.prefs';

export const DEFAULT_PREFS: Prefs = {
  rules: DEFAULT_RULE_CONFIG,
  dictionary: [],
};

export async function loadPrefs(): Promise<Prefs> {
  try {
    const stored = await chrome.storage.sync.get(KEY);
    const value = stored[KEY] as Partial<Prefs> | undefined;
    if (!value) return DEFAULT_PREFS;
    return {
      rules: {
        categories: { ...DEFAULT_RULE_CONFIG.categories, ...value.rules?.categories },
        disabledRules: Array.isArray(value.rules?.disabledRules) ? value.rules.disabledRules : [],
      },
      dictionary: Array.isArray(value.dictionary) ? value.dictionary.filter((w): w is string => typeof w === 'string') : [],
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  try {
    await chrome.storage.sync.set({ [KEY]: prefs });
  } catch {
    // Quota or an unavailable service worker. The prefs still apply here.
  }
}

/** Fires when another tab changes the prefs, so every tab stays in step. */
export function onPrefsChanged(fn: (prefs: Prefs) => void): void {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes[KEY]) return;
      const value = changes[KEY].newValue as Prefs | undefined;
      if (value) fn(value);
    });
  } catch {
    // No storage events available; prefs simply do not sync live.
  }
}

export const CATEGORY_LABELS: Record<Category, string> = {
  correctness: 'Correctness',
  clarity: 'Clarity',
  engagement: 'Engagement',
  delivery: 'Delivery',
};
