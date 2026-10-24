// Fills the reading caches for one or more sets:  node scripts/read.mjs wild-tune cord wild
// READER=ocr for Florence-2's OCR instead of Donut (only where Donut's read does not add up,
// unless ALL=1); THREADS=3 to leave the rest of the CPU free.
import * as tf from '@huggingface/transformers';
import { readFileSync, existsSync } from 'node:fs';
import { receipts, readAll, CACHE } from './data.mjs';
import { toJSON, toReceipt } from '../src/donut.js';
import { check } from '../src/check.js';
import { reader } from '../src/reader.js';
import { ocr } from '../src/ocr.js';

const kind = process.env.READER === 'ocr' ? 'ocr' : 'donut';
const opts = { threads: Number(process.env.THREADS) || undefined };
const read = kind === 'ocr' ? await ocr(tf, opts) : await reader(tf, opts);
for (const set of process.argv.slice(2)) {
  let list = await receipts(set);
  // Like the app, Florence-2 only reads receipts whose Donut read did not add up (ALL=1 for every one).
  const donut = `${CACHE}donut-${set}.jsonl`;
  if (kind === 'ocr' && process.env.ALL !== '1' && existsSync(donut)) {
    const fine = new Set(readFileSync(donut, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((j) => check(toReceipt(toJSON(j.seq))).status === 'adds-up').map((j) => j.id));
    list = list.filter((r) => !fine.has(r.id));
  }
  await readAll(set, list, read, tf, kind);
}
