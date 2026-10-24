// The two test sets and a cache of what Donut read from each photo, so the slow part of the
// tests runs once and everything after it (parsing, checking, splitting) is instant.
//
//   CORD v2 (CC BY 4.0): 1,000 receipts from Indonesian shops and cafes. Donut was fine-tuned
//     on its training split; the 100 test receipts are the in-distribution check.
//   WildReceipt (Apache-2.0): 1,740 receipts photographed in the wild, mostly from the US,
//     annotated box by box. Donut never saw any of them. 150 training receipts are used to
//     tune the checks; the 472 test receipts are the real test.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CACHE = fileURLToPath(new URL('../tests/.cache/', import.meta.url));
const WILD = `${CACHE}wild/wildreceipt/`;
const CORD = `${CACHE}cord-test.parquet`;

const SOURCES = {
  cord: 'https://huggingface.co/datasets/naver-clova-ix/cord-v2/resolve/main/data/test-00000-of-00001-9c204eb3f4e11791.parquet',
  wild: 'https://download.openmmlab.com/mmocr/data/wildreceipt.tar',
};

function ensure() {
  mkdirSync(CACHE, { recursive: true });
  if (!existsSync(CORD)) {
    console.log('downloading CORD v2 test split (234 MB)');
    execSync(`curl -sL --retry 5 -o "${CORD}" "${SOURCES.cord}"`, { stdio: 'inherit' });
  }
  if (!existsSync(`${WILD}test.txt`)) {
    console.log('downloading WildReceipt (185 MB)');
    execSync(`curl -sL --retry 5 -o "${CACHE}wildreceipt.tar" "${SOURCES.wild}" && mkdir -p "${CACHE}wild" && tar -xf "${CACHE}wildreceipt.tar" -C "${CACHE}wild" && rm "${CACHE}wildreceipt.tar"`, { stdio: 'inherit' });
  }
}

// WildReceipt labels every text box. These are the ones that matter for splitting a bill.
const WL = { item: 11, qty: 13, price: 15, subtotal: 17, tax: 19, tips: 21, total: 23 };

/**
 * Every receipt as { set, id, image: () => Promise<Buffer|path>, truth }, where truth is
 *   { prices: [text...], subtotal, tax, tip, total } as the annotators typed them.
 */
export async function receipts(set) {
  ensure();
  if (set === 'cord') {
    const { asyncBufferFromFile, parquetReadObjects } = await import('hyparquet');
    const file = await asyncBufferFromFile(CORD);
    const rows = await parquetReadObjects({ file, utf8: false });
    return rows.map((r, i) => {
      const gt = JSON.parse(typeof r.ground_truth === "string" ? r.ground_truth : new TextDecoder().decode(r.ground_truth)).gt_parse;
      const menu = gt.menu == null ? [] : Array.isArray(gt.menu) ? gt.menu : [gt.menu];
      const one = (x) => (Array.isArray(x) ? x[0] : x) ?? null;
      const st = gt.sub_total ?? {}, t = gt.total ?? {};
      return {
        set, id: `cord-${i}`, bytes: r.image.bytes,
        truth: {
          prices: menu.flatMap((m) => [one(m.price), ...(m.sub == null ? [] : [].concat(m.sub)).map((x) => one(x.price))]).filter((p) => p != null),
          subtotal: one(st.subtotal_price), tax: one(st.tax_price), tip: null, total: one(t.total_price),
        },
      };
    });
  }
  const [split, n] = set === 'wild-tune' ? ['train', 150] : ['test', Infinity];
  const rows = readFileSync(`${WILD}${split}.txt`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // The tuning receipts are every 8th training receipt, so they span the whole set.
  const picked = split === 'train' ? rows.filter((_, i) => i % 8 === 0).slice(0, n) : rows;
  return picked.map((r) => {
    const by = (label) => r.annotations.filter((a) => a.label === label).sort((a, b) => a.box[1] - b.box[1]).map((a) => a.text);
    const pick = (label) => by(label).at(-1) ?? null; // the last one printed, if a receipt repeats it
    return {
      set, id: r.file_name, path: WILD + r.file_name,
      truth: { prices: by(WL.price), subtotal: pick(WL.subtotal), tax: pick(WL.tax), tip: pick(WL.tips), total: pick(WL.total) },
    };
  });
}

/**
 * Runs a reader (Donut, or Florence-2's OCR) on every receipt of a set once; afterwards, reads
 * the answers from the cache.
 */
export async function readAll(set, list, read, tf, kind = 'donut') {
  const file = `${CACHE}${kind}-${set}.jsonl`;
  const done = new Map();
  if (existsSync(file)) for (const l of readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)) { const j = JSON.parse(l); done.set(j.id, j); }
  const todo = list.filter((r) => !done.has(r.id));
  if (todo.length) {
    if (!read) throw new Error(`no reader to fill ${todo.length} receipts`);
    const t0 = Date.now();
    for (const [k, r] of todo.entries()) {
      const image = r.path ? await tf.RawImage.read(r.path) : await tf.RawImage.fromBlob(new Blob([r.bytes]));
      const t = Date.now();
      const out = await read(image);
      const j = { id: r.id, ms: Date.now() - t, ...(typeof out === 'string' ? { seq: out } : out) };
      appendFileSync(file, JSON.stringify(j) + '\n');
      done.set(r.id, j);
      process.stdout.write(`\r  reading ${set} (${kind}): ${k + 1}/${todo.length} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
    }
    process.stdout.write('\n');
  }
  return list.map((r) => done.get(r.id));
}
