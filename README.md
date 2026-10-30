# Lucid

A writing checker that does what Grammarly does, without the lag that makes the
browser extension painful to leave installed.

Everything runs on your machine. Spelling, grammar, clarity, wordiness, tone and
readability never touch the network. Full-sentence rewrites are the one
exception, and they only run when you ask for one.

## Why the usual approach is slow

Three things make a browser writing checker expensive, and all three are
avoidable now in a way they were not a few years ago.

**It re-checks the whole document.** Harper lints 20,000 characters in about
53ms. Doing that on every keystroke is a dropped frame every time you type.
Lucid splits the document into paragraph blocks, hashes each one, and re-lints
only the block you actually edited. Editing the last paragraph of a 116,000
character document costs the same as editing a short note.

**It paints underlines with DOM elements.** An overlay of positioned spans has
to be re-measured against the text on every keystroke, every scroll and every
reflow, which is why typing in Gmail or a Slate-based editor gets sticky. The
CSS Custom Highlight API reached Baseline in March 2026, and it hands that job
back to the browser. Lucid registers Ranges and the browser paints them, so no
wrapper nodes exist and nothing needs measuring.

**It loads a copy of itself into every tab.** Harper's WebAssembly binary is
about 20MB. The extension pays for it once for the whole browser, in a single
offscreen document, rather than once per tab.

## Measured

Taken on this machine with `npm run bench` and in-browser timings. The document
is 11,800 words with 3,200 live suggestions, which is well past anything you
would actually write in one sitting.

| | naive | Lucid |
|---|---|---|
| Grammar pass per edit, 116k chars | 313ms | **1.5ms** |
| Underline repaint, 3,200 issues | 65ms | **1.1ms** |
| Rules tier per keystroke | — | **0.3ms** |
| Total main-thread work per keystroke (p95) | — | **2.4ms** |

The 313ms and 65ms columns are not strawmen. They are what this same code did
before the block cache and the offset index went in, measured the same way.

One frame at 60Hz is 16.7ms, so the whole per-keystroke path fits inside a
single frame with room to spare. The grammar pass runs in a worker and never
touches the main thread at all.

## What it checks

The four categories match the ones Grammarly users already know.

| Category | What it covers | Where it comes from |
|---|---|---|
| Correctness | Spelling, grammar, agreement, punctuation, capitalization | Harper (936 rules) plus a confusion pack |
| Clarity | Wordiness, passive voice, nominalizations, long sentences, double negatives | 260 phrase rules plus pattern rules |
| Engagement | Filler, weak intensifiers, clichés, adverb pileups, repeated sentence openers | Phrase and pattern rules |
| Delivery | Hedging, apologetic openers, shouting, exclamation pileups | Phrase and pattern rules |

Alongside those it reports a writing score, Flesch reading ease, Flesch-Kincaid
grade level, average sentence length, passive voice ratio, estimated reading
time, and a tone read with formality and confidence meters.

The confusion pack exists because Harper's dictionary accepts several very
common errors as real words. It leaves `wont`, `cant`, `thats` and `Its not`
alone, since each is a word in its own right. Those are among the mistakes
people make most, so Lucid adds context-gated rules for them. Each one fires on
the construction rather than the word, so `the dog wagged its tail` and `the
well was deep` stay untouched. `npm test` checks that.

## How it is put together

Four tiers, ordered by how much they cost and how soon you need them.

```
Tier 0  rules       ~0.3ms   every keystroke, main thread, on the edited block
Tier 1  Harper      ~1.5ms   debounced 120ms, in a worker, edited block only
Tier 2  analysis    ~3ms     on idle, whole document
Tier 3  Claude      ~1s      only when you click a rewrite
```

Tier 1 runs behind a generation counter. When you keep typing, the run already
in flight abandons itself rather than finishing work whose results are stale, so
a fast typist never queues up behind themselves.

```
packages/engine/      the whole checker, shared by both apps
  segment.ts          paragraph blocks and sentence splitting, with offsets
  scheduler.ts        incremental scheduling, caching, cancellation
  tiers/              phrase tables, pattern rules, confusions, tone, readability
  worker/             Harper in a worker, multi-client
  providers/claude.ts optional rewrites
apps/web/             standalone editor
apps/extension/       MV3 extension, one shared engine per browser
```

## Running it

```bash
npm install
```

```bash
npm run dev
```

That serves the editor on http://localhost:5181. Harper's WebAssembly loads in
the background in about a second, and the rules tier works before it arrives.

```bash
npm run build:ext
```

That writes an unpacked extension to `apps/extension/dist`. Load it through
`chrome://extensions` with developer mode on and `Load unpacked`.

```bash
npm test
npm run bench
```

## Rewrites

The rewrite bar appears when you select text, and it covers rewrite, shorten,
simplify, rephrase, and three tone shifts. It calls Claude Opus 5.5 at low
effort with structured output, and it is the only part of Lucid that uses the
network.

Add a key under "Claude rewrites" in the top bar. The key sits in this browser's
localStorage and goes only to api.anthropic.com. The Anthropic SDK is a separate
348KB chunk that is downloaded only once a key exists, so leaving rewrites off
costs nothing.

For anything deployed rather than run locally, point `baseURL` at a proxy that
holds the key server-side instead of shipping it to the page.

## Honest limits

- Harper is English only, so Lucid is too.
- Underlines inside `<textarea>` need the OpaqueRange API, which today is
  Chromium 152 and up. Everywhere else the extension still lists suggestions in
  its panel for textareas, it just cannot underline them. Contenteditable
  fields, which is where most real writing happens, work everywhere the Custom
  Highlight API does.
- The extension's message plumbing has not been exercised in a real browser
  yet. The engine, the offset mapping over nested contenteditable markup, and
  the build output are all verified. Loading it unpacked is the next step.
- Plagiarism detection is not here and will not be. It needs a licensed index of
  the web, which is not something a local checker can do.
- Tone detection is a lexicon-and-feature model rather than a neural one. It is
  good at formality and hedging and weaker at sarcasm or intent.
