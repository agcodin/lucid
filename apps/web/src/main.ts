import { Lucid, applyReplacement } from '@lucid/engine';
import type { Category, EngineState, Issue, RemoteProvider, TransformKind } from '@lucid/engine';
import HarperWorker from '@lucid/engine/worker?worker';
import { Editor } from './editor.js';
import { Sidebar } from './sidebar.js';
import { RewriteBar } from './rewrite.js';

const SAMPLE = `In order to facilitate the utilization of our new onboarding system, we have made a decision to implement a change that will have an impact on the way in which the team operates on a daily basis.

The specification was written by the platform committee prior to the architecture review. There is a very real possibility that, due to the fact that the requirements were not communicated in a timely manner, the implementation of the proposed solution will be delayed until such time as the dependencies are resolved.

I think that maybe we should probably circle back on this at the end of the day. Their going to send alot of thigs over and it wont be ready. Its not clear whether or not the team has the ability to ship.

Thanks so much!! Really appreciate it. Let me know if you have any questions at all.`;

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand">
      <span class="mark"></span>
      <span class="name">Lucid</span>
      <span class="tagline">local-first writing checker</span>
    </div>
    <div class="topbar-actions">
      <button id="fix-all" class="btn">Fix all spelling &amp; grammar</button>
      <button id="settings-toggle" class="btn ghost">Claude rewrites</button>
    </div>
  </header>

  <div id="settings" class="settings" hidden>
    <label for="api-key">Anthropic API key</label>
    <input id="api-key" type="password" placeholder="sk-ant-..." autocomplete="off" spellcheck="false" />
    <p class="settings-note">
      Stored in this browser's localStorage and sent only to api.anthropic.com. Everything else in Lucid runs
      on your machine &mdash; spelling, grammar, clarity, tone and readability never leave the page.
    </p>
  </div>

  <main class="layout">
    <section class="editor-pane">
      <div id="editor" class="editor"></div>
      <div id="rewrite-bar"></div>
    </section>
    <aside id="sidebar" class="sidebar"></aside>
  </main>
`;

let activeId: string | undefined;
let latest: EngineState | undefined;
/** Declared before RewriteBar, which reads it during its first render. */
let provider: RemoteProvider | undefined;

const editor = new Editor({
  root: document.querySelector<HTMLElement>('#editor')!,
  onInput: (text) => engine.setText(text),
  onIssueFocus: (issue) => setActive(issue?.id),
});

const sidebar = new Sidebar(document.querySelector<HTMLElement>('#sidebar')!, {
  onSelect: (issue) => {
    setActive(issue.id);
    editor.reveal(issue);
  },
  onApply: (issue, replacement) => apply(issue, replacement),
  onDismiss: (issue) => {
    engine.dismiss(issue);
    if (activeId === issue.id) setActive(undefined);
  },
  onAddToDictionary: (word) => engine.addToDictionary(word.trim()),
  onFilter: (_category: Category | 'all') => undefined,
});

const engine = new Lucid({
  worker: new HarperWorker(),
  onUpdate: (state) => {
    latest = state;
    // The underlines repaint on every engine message, including the partial
    // ones that arrive per block, so suggestions appear as they are found.
    editor.setIssues(state.issues, activeId);
    sidebar.render(state, editor.getText());
  },
});

const rewriteBar = new RewriteBar({
  root: document.querySelector<HTMLElement>('#rewrite-bar')!,
  getProvider: () => provider,
  onReplace: (start, end, text) => {
    const current = editor.getText();
    editor.setText(current.slice(0, start) + text + current.slice(end), start + text.length);
  },
});

function setActive(id: string | undefined): void {
  activeId = id;
  sidebar.setActive(id);
  if (latest) editor.setIssues(latest.issues, activeId);
}

function apply(issue: Issue, replacement: string): void {
  const next = applyReplacement(editor.getText(), issue, replacement);
  setActive(undefined);
  editor.setText(next.text, next.cursor);
  editor.focus();
}

/**
 * Apply every unambiguous correctness fix at once. Walking from the end of the
 * document backwards keeps earlier offsets valid as each edit lands.
 */
document.querySelector('#fix-all')!.addEventListener('click', () => {
  if (!latest) return;
  const fixes = latest.issues
    .filter((issue) => issue.category === 'correctness' && issue.replacements.length === 1)
    .sort((a, b) => b.start - a.start);

  let text = editor.getText();
  let applied = 0;
  let lastEnd = Number.POSITIVE_INFINITY;
  for (const issue of fixes) {
    if (issue.end > lastEnd) continue; // Skip anything overlapping a fix already applied.
    text = applyReplacement(text, issue, issue.replacements[0]!.text).text;
    lastEnd = issue.start;
    applied++;
  }
  if (applied > 0) editor.setText(text, 0);
});

// --- Claude rewrites (opt-in) ---------------------------------------------

const KEY_STORAGE = 'lucid.anthropicKey';

/**
 * The Anthropic SDK is ~350KB and the remote tier is opt-in, so it is loaded
 * only once a key exists. A user who never turns on rewrites never downloads it.
 */
async function buildProvider(apiKey: string): Promise<void> {
  if (!apiKey) {
    provider = undefined;
    rewriteBar.refresh();
    return;
  }
  const { ClaudeProvider } = await import('@lucid/engine/claude');
  provider = new ClaudeProvider({ apiKey, allowBrowser: true, effort: 'low' });
  rewriteBar.refresh();
}

const keyInput = document.querySelector<HTMLInputElement>('#api-key')!;
const settings = document.querySelector<HTMLElement>('#settings')!;

document.querySelector('#settings-toggle')!.addEventListener('click', () => {
  settings.hidden = !settings.hidden;
  if (!settings.hidden) keyInput.focus();
});

keyInput.addEventListener('change', () => {
  const value = keyInput.value.trim();
  if (value) localStorage.setItem(KEY_STORAGE, value);
  else localStorage.removeItem(KEY_STORAGE);
  void buildProvider(value);
});

try {
  const stored = localStorage.getItem(KEY_STORAGE) ?? '';
  keyInput.value = stored;
  void buildProvider(stored);
} catch {
  // Private browsing with site data blocked. Rewrites simply stay unavailable.
}

editor.setText(SAMPLE);
editor.focus();

// Expose the transform kinds the rewrite bar offers, for the keyboard shortcut.
window.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.key !== 'j') return;
  event.preventDefault();
  rewriteBar.trigger('rewrite' satisfies TransformKind);
});

// Dev-only handle, for measuring the engine from the console. Stripped from a
// production build, where `import.meta.env.DEV` is statically false.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__lucid = { engine, editor, sidebar, get state() { return latest; } };
}
