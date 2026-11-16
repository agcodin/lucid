/**
 * Builds a false-positive corpus from Wikipedia article text.
 *
 * Wikipedia is a good yardstick here because it is heavily copy-edited modern
 * expository English, and its own style guide discourages the wordiness and
 * hedging the rules look for. A rule that fires often on this text is firing on
 * writing that a careful editor already passed.
 *
 * Saved under corpus/, which is gitignored: the text is CC BY-SA and only ever
 * used locally to count how often rules misfire.
 */
import { writeFile, mkdir, access } from 'node:fs/promises';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TITLES = [
  'Photosynthesis', 'Plate tectonics', 'Byzantine Empire', 'Jane Austen',
  'Supply and demand', 'Immune system', 'Printing press', 'Antarctica',
  'Jazz', 'Vaccine', 'Monetary policy', 'Eiffel Tower',
  'Quicksort', 'Shipping container', 'Public transport', 'Coral reef',
  'Industrial Revolution', 'Chess', 'Lighthouse', 'Penicillin',
];

const endpoint = 'https://en.wikipedia.org/w/api.php';
await mkdir('corpus/text', { recursive: true });

let words = 0;
for (const title of TITLES) {
  const file = `corpus/text/${title.replace(/[^\w]+/g, '-').toLowerCase()}.txt`;
  // Resume rather than refetch: the API rate-limits a long run.
  try { await access(file); console.log(`       cached  ${file}`); continue; } catch { /* not fetched yet */ }
  await sleep(6000);

  const url = `${endpoint}?action=query&format=json&prop=extracts&explaintext=1&titles=${encodeURIComponent(title)}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'lucid-dev/0.1 (local rule evaluation)' } });
  if (!response.ok) { console.warn(`${response.status} on ${title}, stopping`); break; }
  const body = await response.text();
  if (!body.startsWith('{')) { console.warn(`rate limited on ${title}, stopping — rerun to resume`); break; }
  const data = JSON.parse(body);
  const page = Object.values(data.query.pages)[0];
  if (!page?.extract) { console.warn(`no extract for ${title}`); continue; }

  // Drop section headings and reference-only tails, which are not prose.
  const prose = page.extract
    .split('\n')
    .filter((line) => !/^=+ .* =+$/.test(line.trim()))
    .join('\n')
    .split(/\n==\s*(?:References|Further reading|External links|See also|Notes|Bibliography)/i)[0];

  await writeFile(file, prose, 'utf8');
  const count = prose.split(/\s+/).filter(Boolean).length;
  words += count;
  console.log(`${String(count).padStart(6)} words  ${file}`);
}
console.log(`\n${words.toLocaleString()} words across ${TITLES.length} articles`);
