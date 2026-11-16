/**
 * A second corpus, in a different register from the Wikipedia one.
 *
 * MDN is modern technical prose written to a style guide that asks for active
 * voice and plain wording, so it is a sharper test than encyclopedic writing.
 * A clarity rule that fires heavily here is firing on prose that was edited to
 * avoid exactly what the rule claims to find.
 *
 * Content is CC-BY-SA, fetched once and used locally to count rule hits.
 */
import { writeFile, mkdir, access } from 'node:fs/promises';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'https://raw.githubusercontent.com/mdn/content/main/files/en-us/';

const PAGES = [
  'web/api/fetch_api/using_fetch/index.md',
  'web/javascript/guide/functions/index.md',
  'web/javascript/guide/regular_expressions/index.md',
  'web/css/css_flexible_box_layout/basic_concepts_of_flexbox/index.md',
  'web/css/css_grid_layout/basic_concepts_of_grid_layout/index.md',
  'web/accessibility/aria/guides/techniques/index.md',
  'web/performance/guides/lazy_loading/index.md',
  'web/security/practical_implementation_guides/csp/index.md',
  'web/http/guides/caching/index.md',
  'web/api/web_workers_api/using_web_workers/index.md',
  'web/api/service_worker_api/using_service_workers/index.md',
  'web/javascript/guide/modules/index.md',
  'learn_web_development/core/scripting/debugging_javascript/index.md',
  'web/api/websockets_api/writing_websocket_client_applications/index.md',
  'web/media/guides/formats/video_concepts/index.md',
];

/** Strip the parts of a Markdown page that are not prose. */
function toProse(markdown) {
  return markdown
    .replace(/^---[\s\S]*?\n---\n/, '')          // front matter
    .replace(/```[\s\S]*?```/g, '')               // fenced code
    .replace(/\{\{[^}]*\}\}/g, '')                // MDN macros
    .replace(/^\s*[|>].*$/gm, '')                 // tables and quotes
    .replace(/^#{1,6} .*$/gm, '')                 // headings
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')    // links and images
    .replace(/`[^`]*`/g, 'code')                  // inline code
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1') // emphasis
    .replace(/^\s*[-*+]\s+/gm, '')                // list bullets
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

await mkdir('corpus/mdn', { recursive: true });
let words = 0;

for (const page of PAGES) {
  const name = page.replace(/\/index\.md$/, '').replace(/[^\w]+/g, '-');
  const file = `corpus/mdn/${name}.txt`;
  try { await access(file); console.log(`       cached  ${file}`); continue; } catch { /* not fetched */ }
  await sleep(400);

  const response = await fetch(BASE + page);
  if (!response.ok) { console.warn(`${response.status} on ${page}`); continue; }
  const prose = toProse(await response.text());
  await writeFile(file, prose, 'utf8');
  const count = prose.split(/\s+/).filter(Boolean).length;
  words += count;
  console.log(`${String(count).padStart(6)} words  ${file}`);
}
console.log(`\n${words.toLocaleString()} new words`);
