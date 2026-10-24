// Runs Donut over real receipts and measures what the app would do with each one.
//
//   npm test                both test sets: WildReceipt (472, never seen) and CORD (100)
//   SET=wild-tune npm test  the 150 WildReceipt training receipts the checks were tuned on
//
// For each receipt: are the line prices right (compared as a multiset with the annotators'
// prices), is the total right, and what does the arithmetic check say? The number that
// matters most is the last column: when the app shows a green "adds up", how often is every
// line actually right?
import * as tf from '@huggingface/transformers';
import { readFileSync, existsSync } from 'node:fs';
import { receipts, readAll, CACHE } from '../scripts/data.mjs';
import { reader } from '../src/reader.js';
import { ocr } from '../src/ocr.js';
import { toJSON, toReceipt } from '../src/donut.js';
import { check, payable, pick } from '../src/check.js';
import { toReceiptFromRows } from '../src/rows.js';
import { parseMoney, unify } from '../src/money.js';

const SETS = (process.env.SET || 'wild,cord').split(',');
// READS=browser scores what Chrome read (scripts/browser.mjs) instead of Node, on the receipts it read.
const READS = process.env.READS || 'node';
// READER=both (what ships: Donut, and Florence-2's OCR when Donut's read does not add up; the
// read that adds up wins) | donut | ocr.
const READER = process.env.READER || 'both';
const jsonl = (f) => new Map(existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const j = JSON.parse(l); return [j.id, j]; }) : []);
const NAMES = { wild: 'WildReceipt test (472, mostly US, never seen by the model)', cord: 'CORD test (100, Indonesian, same kind the model was trained on)', 'wild-tune': 'WildReceipt tuning (150 training receipts)' };

// Major units, rounded to the cent, so "13.99" read as 1399 cents and "$13.99" compare equal.
// Lines of 0 (free extras, "no onions") change nobody's share, so they are left out on both sides.
const major = (v, cents) => (v == null ? null : Math.round((cents ? v / 100 : v) * 100) / 100);

function truthOf(t) {
  const prices = t.prices.map(parseMoney);
  const fields = ['subtotal', 'tax', 'tip', 'total'].map((k) => parseMoney(t[k]));
  const all = [...prices, ...fields];
  const cents = all.some((a) => a?.cents);
  const u = unify(all);
  return {
    prices: u.slice(0, prices.length).filter((v) => v != null && v !== 0).map((v) => major(v, cents)),
    unreadable: prices.filter((p) => p == null).length,
    total: major(u[prices.length + 3], cents),
  };
}

/** How many predicted amounts match a true one, each true one used once. */
function matches(pred, truth) {
  const left = new Map();
  for (const v of truth) left.set(v, (left.get(v) || 0) + 1);
  let m = 0;
  for (const v of pred) if (left.get(v) > 0) { left.set(v, left.get(v) - 1); m++; }
  return m;
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : '-');
let lazy = null;
const results = {};

for (const set of SETS) {
  let list = await receipts(set);
  let outs;
  if (READS === 'browser') {
    const b = jsonl(`${CACHE}browser-${set}.jsonl`);
    list = list.filter((r) => b.has(r.id));
    outs = list.map((r) => b.get(r.id));
    const n = jsonl(`${CACHE}donut-${set}.jsonl`);
    const same = list.filter((r) => n.has(r.id) && n.get(r.id).seq === b.get(r.id).seq).length;
    const sameCheck = list.filter((r) => n.has(r.id) && JSON.stringify(check(toReceipt(toJSON(n.get(r.id).seq)))) === JSON.stringify(check(toReceipt(toJSON(b.get(r.id).seq))))).length;
    console.log(`\nChrome's reads of ${list.length} receipts: word for word the same as Node's on ${same}, same lines and verdict on ${sameCheck}`);
  } else {
    // SAME_AS_BROWSER=1: only the receipts Chrome has read, to compare like with like.
    if (process.env.SAME_AS_BROWSER) { const b = jsonl(`${CACHE}browser-${set}.jsonl`); list = list.filter((r) => b.has(r.id)); }
    const cached = await readAll(set, list, null, tf).catch(() => null);
    outs = cached ?? (await readAll(set, list, await reader(tf), tf));
  }

  // Florence-2 reads the receipts whose Donut read does not add up (all of them for READER=ocr).
  if (READER !== 'donut' && READS === 'node') {
    const need = list.filter((r, i) => READER === 'ocr' || check(toReceipt(toJSON(outs[i].seq))).status !== 'adds-up');
    const have = jsonl(`${CACHE}ocr-${set}.jsonl`);
    const missing = need.filter((r) => !have.has(r.id));
    if (missing.length) await readAll(set, missing, await ocr(tf), tf, 'ocr');
  }
  const ocrs = READER === 'donut' ? null : READS === 'browser'
    ? new Map(outs.filter((j) => j.ocr).map((j) => [j.id, j.ocr]))
    : jsonl(`${CACHE}ocr-${set}.jsonl`);
  if (ocrs) {
    // Every receipt needs an OCR read, except (for both) those whose Donut read adds up.
    const need = (i) => READER === 'ocr' || check(toReceipt(toJSON(outs[i].seq))).status !== 'adds-up';
    const keep = list.map((r, i) => i).filter((i) => ocrs.has(list[i].id) || !need(i));
    if (keep.length < list.length) console.log(`\n(only the ${keep.length} receipts with every read they need so far)`);
    outs = keep.map((i) => outs[i]);
    list = keep.map((i) => list[i]);
  }
  const rows = list.map((r, i) => {
    const seq = outs[i].seq;
    const rec = toReceipt(toJSON(seq));
    const o = ocrs?.get(r.id);
    const cd = check(rec), co = o ? check(toReceiptFromRows(o)) : null;
    // As the app does it: Florence-2 only gets a look when Donut's read does not add up.
    const second = READER === 'both' && cd.status !== 'adds-up';
    const c = READER === 'ocr' ? co : second ? pick(cd, co) : cd;
    if (!c) return null;
    const truth = truthOf(r.truth);
    // Raw: every line Donut read, at face value (a line whose price is not an amount is wrong).
    const rawAll = unify(rec.items.flatMap((it) => [parseMoney(it.price), ...it.subs.filter((s) => s.price != null).map((s) => parseMoney(s.price))]));
    const rawCents = rec.items.some((it) => parseMoney(it.price)?.cents) || [rec.total, rec.subtotal, rec.tax].some((x) => parseMoney(x)?.cents);
    const raw = rawAll.filter((v) => v !== 0).map((v) => (v == null ? NaN : major(v, rawCents)));
    const shipped = c.lines.filter((l) => !l.dropped && l.amount !== 0).map((l) => major(l.amount, c.cents));
    return { r, c, truth, raw, shipped, ms: READER === 'ocr' ? o.ms : outs[i].ms + (second ? o.ms : 0), total: major(payable(c), c.cents), printed: major(c.total, c.cents) };
  }).filter(Boolean);

  const scored = rows.filter((x) => x.truth.prices.length && !x.truth.unreadable);
  const agg = (key) => {
    let m = 0, p = 0, t = 0, exact = 0;
    for (const x of scored) {
      const k = matches(x[key], x.truth.prices);
      m += k; p += x[key].length; t += x.truth.prices.length;
      if (k === x.truth.prices.length && x[key].length === k) exact++;
    }
    return { precision: m / p, recall: m / t, exact, n: scored.length };
  };
  const raw = agg('raw'), shipped = agg('shipped');
  const withTotal = rows.filter((x) => x.truth.total != null);
  const totalRight = withTotal.filter((x) => x.total === x.truth.total).length;
  const printedRight = withTotal.filter((x) => x.printed === x.truth.total).length;
  const exactOf = (x) => { const k = matches(x.shipped, x.truth.prices); return k === x.truth.prices.length && x.shipped.length === k; };
  const by = (s) => scored.filter((x) => x.c.status === s);
  const ok = [...by('adds-up'), ...by('fixed')];
  const ms = rows.map((x) => x.ms).sort((a, b) => a - b);

  console.log(`\n${NAMES[set]}${READS === 'browser' ? ', as read in Chrome' : ''}`);
  console.log(`  ${rows.length} receipts; ${scored.length} with every line price annotated and readable, ${withTotal.length} with a total`);
  console.log(`  Donut, as read:   ${pct(raw.precision * 1000, 1000)} of lines it reads are right, finds ${pct(raw.recall * 1000, 1000)} of the real lines; every line right on ${pct(raw.exact, raw.n)} of receipts`);
  console.log(`  after the check:  ${pct(shipped.precision * 1000, 1000)} of lines it shows are right, finds ${pct(shipped.recall * 1000, 1000)} of the real lines; every line right on ${pct(shipped.exact, shipped.n)} of receipts`);
  console.log(`  total to pay right: ${pct(totalRight, withTotal.length)} (${totalRight}/${withTotal.length}); the printed total as read: ${pct(printedRight, withTotal.length)}`);
  console.log(`  "adds up" as read ${by('adds-up').length}, "fixed" ${by('fixed').length}, "doesn't add up" ${by('off').length}  (of ${scored.length})`);
  console.log(`  when it says it adds up (or fixed it), every line is right: ${pct(ok.filter(exactOf).length, ok.length)} (${ok.filter(exactOf).length}/${ok.length})`);
  console.log(`     ...as read: ${pct(by('adds-up').filter(exactOf).length, by('adds-up').length)}, after a fix: ${pct(by('fixed').filter(exactOf).length, by('fixed').length)}; when it says it doesn't: ${pct(by('off').filter(exactOf).length, by('off').length)}`);
  console.log(`  reading time on this laptop's CPU: median ${(ms[ms.length >> 1] / 1000).toFixed(1)} s`);
  results[set] = { raw, shipped, totalRight, printedRight, withTotal: withTotal.length, ok: ok.length, okExact: ok.filter(exactOf).length, scored: scored.length, rows };
  if (set === 'wild') lazy = scored;
}

// The lazy payoff: what you would otherwise type into a bill-splitting app, line by line.
if (lazy) {
  const lines = lazy.reduce((s, x) => s + x.truth.prices.length, 0);
  const typed = lazy.reduce((s, x) => s + x.r.truth.prices.join('').length, 0);
  console.log(`\nOn the ${lazy.length} WildReceipt receipts: ${(lines / lazy.length).toFixed(1)} lines each on average; typing just the prices is ${(typed / lazy.length).toFixed(0)} keystrokes a receipt, before any names.`);
}

if (process.env.LIST) {
  const exactRow = (x) => { const k = matches(x.shipped, x.truth.prices); return k === x.truth.prices.length && x.shipped.length === k; };
  for (const x of results[SETS[0]].rows.filter((y) => y.c.status === process.env.LIST && y.truth.prices.length && !(process.env.WRONG && exactRow(y))).slice(0, Number(process.env.N || 10))) {
    console.log('\n' + x.r.id, x.c.status, x.c.rule, 'off', x.c.off);
    console.log('  pred', x.shipped.join(' '), '| total', x.total);
    console.log('  true', x.truth.prices.join(' '), '| total', x.truth.total);
    console.log('  dropped', x.c.lines.filter((l) => l.dropped).map((l) => `${l.name}=${l.amount} (${l.dropped})`).join('; '));
  }
}

// The claims the post makes, with the bars set from the tuning receipts before the test set was
// read; fail loudly if a change breaks them.
const w = results.wild;
if (w && READS === 'node' && READER === 'both') {
  const fails = [];
  if (!(w.shipped.precision > w.raw.precision)) fails.push('the lines shown should be more accurate than Donut as read');
  if (!(w.shipped.recall > w.raw.recall)) fails.push('two readers should find more of the real lines than Donut alone');
  if (!(w.okExact / w.ok >= 0.8)) fails.push('"adds up" should mean every line is right at least 80% of the time');
  if (fails.length) { console.log('\nFAIL:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('\nPASS: the shown lines beat Donut as read, two readers find more lines, and "adds up" means every line is right at least 80% of the time');
}
