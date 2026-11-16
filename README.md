# Lucid

A writing checker that does what Grammarly does, without the lag that makes the
browser extension painful to leave installed.

Everything runs on your own machine, so spelling, grammar, clarity, wordiness,
tone and readability never touch the network. Full-sentence rewrites are the one
exception, and they only run when you ask for one.

## Why the usual approach is slow

Three things make a browser writing checker expensive, and all three are
avoidable now in a way they were not a few years ago.

The first is that it re-checks the whole document. Harper lints 20,000
characters in about 53ms, and doing that on every keystroke is a dropped frame
every time you type. Lucid splits the document into paragraph blocks, hashes
each one, and re-lints only the block you actually edited. Editing the last
paragraph of a 116,000 character document costs the same as editing a short
note.

The second is how the underlines are painted. An overlay of positioned spans has
to be re-measured against the text on every keystroke, every scroll and every
reflow, which is why typing in Gmail or a Slate-based editor gets sticky. The
CSS Custom Highlight API reached Baseline in March 2026, and it hands that job
back to the browser. Lucid registers Ranges and the browser paints them, so no
wrapper nodes exist and nothing needs measuring.

The third is that the checker is loaded into every tab. Harper's WebAssembly
binary runs to about 20MB, and the extension pays for it once for the whole
browser, in a single offscreen document, rather than once per tab.

## Measured

Timings are taken in the browser on an 11,800 word document carrying 2,800 live
suggestions, which is well past anything you would write in one sitting. The
figure that matters is the last row, because it is everything one keystroke
costs on the main thread.

| | before | now |
|---|---|---|
| Grammar pass per edit, 116k chars | 313ms | **1.5ms** |
| Underline repaint, thousands of issues | 65ms | **0.8ms** |
| Suggestion list rebuild | 170ms | **6ms** |
| Selecting a suggestion | 170ms | **0ms** |
| Whole keystroke, editing the last paragraph | 172ms | **1ms** |
| Whole keystroke, editing the first paragraph | 172ms | **6ms** (15.4ms p95) |

Every figure in the before column is what this same code did at some point,
measured the same way. The grammar pass improved with the block cache, the
repaint with the offset index, and the list with windowing and event
delegation.

One frame at 60Hz is 16.7ms, so the whole per-keystroke path fits inside a
single frame even in the worst case. The grammar pass runs in a worker and
never touches the main thread. The first edit after a cold load is slower while
the JIT warms up, and settles within a second of typing.

Measuring components separately is how the 170ms suggestion list went unnoticed
for a while. The bench numbers covered the engine and the underlines and never
touched the sidebar, which was rebuilding a card for every one of 2,800 issues
on every update. The last two rows exist so that cannot happen again.

## How accurate is it

A checker that cries wolf is worse than no checker, so every rule has a measured
firing rate. `npm run corpus` fetches 192,000 words across two genres and
reports how often each rule fires on writing an editor has already passed.

The genres are there to keep one register from setting the tuning. Encyclopedic
prose uses passive voice and long sentences far more than technical
documentation does, and MDN is the sharper of the two because its style guide
asks for active voice and plain wording, which is what the clarity rules claim
to look for.

Correctness rules claim an outright mistake, so on text like this they should
stay quiet. They find zero flags across all 192,381 words of both genres.
Clarity and engagement rules are advisory and will fire on any real text, so the
signal there is a rule firing far harder in one genre than the other, or far
harder than its peers.

Silence is only half the question, because a checker that finds nothing scores
perfectly on it. `npm run recall` answers the other half. It takes clean
sentences from the same corpus, puts a known mistake into one at a known
position, and asks whether anything fires over that span and whether the
suggested fix puts the original back. Twenty kinds of mistake, 636 of them.

| | |
|---|---|
| Errors caught | **100%** |
| Caught with the right fix | **96%** |
| False positives on 192,381 words of edited prose | **0** |

The fix is applied through the same code the editor uses, so the figure is what
a user would get from clicking the suggestion rather than a raw splice. An
earlier version of the harness compared against a splice and scored correct
fixes at 70%, because deleting `very` from `is very useful` left a double space
that the real path tidies up.

Four gaps came out of it. `your writing a regular expression` was missed because
the rule only knew a fixed list of words after `your`, where the tell is a
gerund with an object after it. `you loose many advantages` was missed because
the rule looked only at what followed `loose`, not at the subject before it.
`its often useful` was missed because adverbs had been stripped from the `its`
rule along with the adjectives, although an adverb cannot follow a possessive at
all. And Harper misses `they is` about one time in seven, and when it does catch
it, it usually suggests changing the pronoun rather than the verb, so pronoun
agreement is a rule here now.

That last one introduced a duplicate: `They is` drew a card from both tiers for
the same mistake. Overlapping correctness findings are deduplicated, which the
other categories are deliberately spared, since a wordy phrase inside an
over-long sentence is two useful observations rather than one repeated.

That harness found five real bugs that reading the code had not.

- The sentence splitter kept one set of abbreviations, and that set contained
  ordinary English words. `The cat sat. The dog ran.` became a single sentence,
  and so did anything after `us`, `no`, `wed` or `sun`. Every sentence-level
  rule downstream was working from merged sentences.
- `clarity:nominalization` fired 2,036 times, once every 36 words, on plain
  nouns like `thickness` and `precipitation`. It matched suffixes and kept an
  allowlist of exceptions, which can never cover the noun vocabulary of English.
  It now uses an explicit list gated on the weak `the <noun> of` construction,
  and fires 112 times, all of them genuine.
- `delivery:all-caps` flagged acronym runs and roman numerals, with spans
  stretching across whole sentences. It now needs an unbroken run of three
  capitalized words, and finds nothing in the corpus.
- `confusion:its` flagged `its true significance`, which is a correct
  possessive. Adjectives are gone from the follower list, because an adjective
  cannot tell a possessive from a contraction without knowing what comes next.
- `at the end of the day` sat in two phrase tables, so whichever was indexed
  second could never fire.

Two more came out of the test suite. `syllables('beautiful')` returned 5 because
vowel runs were capped at two characters, and `analyzeTone` labelled any
four-word sentence `direct` by reading tone off its length alone.

A review pass over the whole change found three more. The suggestion list had no
cap, which is the 170ms above. Two of the seven rule toggles were inert, because
the filter accepted `clarity:wordy/in-order-to` as a match for `clarity:wordy`
but not `clarity:sentence-long` for `clarity:sentence`, and the separator
differs between rule families. The screen-reader live region was rebuilt on
every render instead of having its text updated, which stops most readers
announcing it.

Adding the second genre immediately found another. The contraction table was a
plain object, so looking up `constructor` returned `Object.prototype.constructor`
rather than nothing. Every use of that word was flagged, with
`function Object() { [native code] }` offered as the fix, and accepting it would
have pasted that string into the document. Wikipedia never says `constructor`,
so one genre on its own could never have caught it, and the lookup tables are
Maps now.

Running the content script in a real page found four more. `new OpaqueRange(...)`
throws, because the global exists but is not constructible, and since the throw
escaped the engine's update callback it killed the whole attachment rather than
just the underlines. Opening the panel showed an empty card. Applying a fix in a
contenteditable did nothing, because `execCommand` only acts on the focused
editable and clicking the panel moves focus into its shadow root. And `dispose`
sent a global teardown to a worker the extension shares across every tab, which
would have disposed the linter and cleared the block cache for all of them, so
every blur would have cost every other tab a 20MB reload.

## What it checks

The four categories match the ones Grammarly users already know, and each can be
switched off, along with seven individual rule groups.

| Category | What it covers | Where it comes from |
|---|---|---|
| Correctness | Spelling, grammar, agreement, punctuation, capitalization | Harper (936 rules) plus a confusion pack |
| Clarity | Wordiness, passive voice, nominalizations, long sentences, double negatives | 259 phrase rules plus pattern rules |
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
well was deep` stay untouched.

## How it is put together

Four tiers, ordered by how much they cost and how soon you need them.

```
Tier 0  rules       ~0.5ms   every keystroke, main thread, on the edited block
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
  scheduler.ts        incremental scheduling, caching, cancellation, filtering
  tiers/              phrase tables, pattern rules, confusions, tone, readability
  worker/             Harper in a worker, serving several clients at once
  providers/claude.ts optional rewrites
  test/               76 assertions
apps/web/             standalone editor
  exttest.html        the extension's content script, in a host page
apps/extension/       MV3 extension, one shared engine per browser
  test/               8 assertions over the message routing
corpus/               false-positive harness, two genres
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
Your draft autosaves, so a reload keeps it.

Cmd+Enter accepts the suggestion you are on, Cmd+. walks to the next one, and
Cmd+Z undoes an accepted suggestion the way it undoes your own typing.

```bash
npm run build:ext
```

That writes an unpacked extension to `apps/extension/dist`. Load it through
`chrome://extensions` with developer mode on and `Load unpacked`. It attaches
to whichever field you are typing in, and the gear in its panel holds the same
category toggles and dictionary the editor has, stored in `chrome.storage.sync`
so they follow you between devices.

```bash
npm test
npm run bench
npm run corpus
npm run recall
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
- Underlines inside a `<textarea>` need `createValueRange`, which today is
  Chromium only. Everywhere else the extension still lists suggestions in its
  panel for those fields, it just cannot underline them. Contenteditable
  fields, which is where most real writing happens, work everywhere the Custom
  Highlight API does.
- The extension has still never been loaded unpacked in a real Chrome, which is
  the one gap left. Its routing is covered against a stub of the Chrome APIs,
  and the content script itself runs in a real host page against a real Harper
  worker, over a textarea, an input, a password field, a readonly field, a
  non-editable div and a contenteditable with nested markup. That harness is
  `npm run dev` then `/exttest.html?run=1`.
- Both corpus genres are written for a reader who does not know the writer.
  Neither is email, which is most of what people put through a checker, so the
  passive and sentence-length rates are an upper bound rather than a typical
  reading. Tuning those two rules harder against this corpus would make the
  checker worse for the writing people actually bring to it.
- Plagiarism detection is not here and will not be. It needs a licensed index of
  the web, which is not something a local checker can do.
- Tone detection is a lexicon-and-feature model rather than a neural one. It is
  good at formality and hedging and weaker at sarcasm or intent.
