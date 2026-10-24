// Runs the page's reading steps inside Chrome on a set of receipts (Donut, then Florence-2 when
// Donut's read does not add up), with the same code and files the page uses, and caches what it
// read in tests/.cache/browser-<set>.jsonl. Then
//   READS=browser SET=<set> npm test
// scores the browser's reads instead of Node's, and says how often the two agree.
//   CHROME=/path/to/chrome node scripts/browser.mjs wild 100 [wasm|webgpu]
// Needs puppeteer-core (npm i --no-save puppeteer-core) and a Chrome; serves this folder itself,
// with the cross-origin isolation headers that give WASM its threads.
import { createServer } from 'node:http';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { receipts, CACHE } from './data.mjs';

const [set = 'wild', n = '100', device = 'wasm'] = process.argv.slice(2);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png' };

const list = (await receipts(set)).slice(0, Number(n));
const out = `${CACHE}browser-${set}${device === 'wasm' ? '' : '-' + device}.jsonl`;
const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : []);
const todo = list.filter((r) => !done.has(r.id));
// CORD images live inside a parquet file; write them out so the browser can load them by URL.
for (const r of todo) if (!r.path) { r.path = `${CACHE}img-${r.id}.jpg`; if (!existsSync(r.path)) await writeFile(r.path, r.bytes); }
await writeFile(`${CACHE}browser-list.json`, JSON.stringify(todo.map((r) => ({ id: r.id, url: '/' + r.path.slice(ROOT.length) }))));

const server = createServer(async (req, res) => {
  const p = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try {
    const body = await readFile(p);
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const port = server.address().port;

const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', protocolTimeout: 0,
  args: device === 'webgpu' ? ['--enable-unsafe-webgpu'] : ['--disable-gpu'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('page error:', e.message));
await page.goto(`http://localhost:${port}/tests/browser.html?device=${device}&list=/${CACHE.slice(ROOT.length)}browser-list.json`);
console.log(`reading ${todo.length} receipts in Chrome (${device}), cross-origin isolated: ${await page.evaluate(() => self.crossOriginIsolated)}`);
let saved = 0;
const t0 = Date.now();
while (saved < todo.length) {
  await new Promise((r) => setTimeout(r, 3000));
  const fresh = await page.evaluate((k) => (window.results || []).slice(k), saved);
  for (const r of fresh) await appendFile(out, JSON.stringify(r) + '\n');
  saved += fresh.length;
  process.stdout.write(`\r  ${saved}/${todo.length} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
  if (await page.evaluate(() => window.done === true) && saved >= todo.length) break;
}
console.log();
await browser.close();
server.close();
