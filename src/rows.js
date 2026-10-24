// Turns OCR pieces (text and where it is) into the same shape src/donut.js produces, so the
// same check can judge both readers. A receipt is a table: each row is a name on the left and
// an amount on the right, and the rows near the bottom are labelled (subtotal, tax, total).
import { parseMoney } from './money.js';

const LABELS = [
  ['subtotal', /sub\s*-?\s*tot|subtotaal|zwischensumme|sous[\s-]?total|net\s+total|food\s+total/i],
  ['tax', /\btax|\btx\b|\bgst\b|\bhst\b|\bpst\b|\bvat\b|\biva\b|\bmwst|\bpb1\b|\bppn\b|\bigst|\bcgst|\bsgst/i],
  ['service', /\btips?\b|gratuity|service|\bsvc\b|\bsrv\b/i],
  ['discount', /\bdisc|coupon|saving|promo|\boff\b|rabatt|sconto/i],
  ['payment', /cash|change|tend|visa|master|amex|\bcard\b|credit|debit|\bpaid\b|payment|resto|contante|cambio|tunai|kembali|auth|approv/i],
  ['total', /total|\btotl?\b|\bttl\b|\bdue\b|grand|summe|totaal|jumlah|\bsum\b|\bnet\b|amount|balance/i],
];

// An amount as receipts print them: digits with a decimal part, maybe a currency sign, maybe a
// trailing tax flag ("3.99 B") or minus ("1.49-"). Bare integers only for receipts without cents.
const MONEY = /^[-(]?\s*(?:[$€£₹]|rp\.?|rs\.?)?\s*\d{1,7}(?:[.,]\d{3})*(?:[.,]\d{1,2})?\s*[-)]?\s*[a-z*]{0,2}$/i;

function pieces(o) {
  return o.text.map((t, i) => {
    const q = o.quads[i];
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    return { t, x0: Math.min(...xs), x1: Math.max(...xs), y0, y1, yc: (y0 + y1) / 2, h: Math.max(1, y1 - y0) };
  }).filter((p) => p.t);
}

/** Groups pieces into rows: pieces whose vertical centres are within half a line of each other. */
export function rowsOf(o) {
  const ps = pieces(o).sort((a, b) => a.yc - b.yc);
  const hs = ps.map((p) => p.h).sort((a, b) => a - b);
  const lineH = hs[hs.length >> 1] || 10;
  const rows = [];
  for (const p of ps) {
    const r = rows.at(-1);
    if (r && Math.abs(p.yc - r.yc) < lineH * 0.55) { r.ps.push(p); r.yc = (r.yc * (r.ps.length - 1) + p.yc) / r.ps.length; }
    else rows.push({ yc: p.yc, ps: [p] });
  }
  for (const r of rows) r.ps.sort((a, b) => a.x0 - b.x0);
  return rows;
}

// OCR sometimes puts a space inside a number ("20. 00").
const squeeze = (t) => t.trim().replace(/(\d)\s*([.,])\s*(\d)/g, '$1$2$3');
const isAmount = (t) => MONEY.test(squeeze(t)) && parseMoney(squeeze(t).replace(/\s*[a-z*]{1,2}$/i, '')) != null;
const amountText = (t) => squeeze(t).replace(/\s*[a-z*]{1,2}$/i, '').trim();

/** Same shape as toReceipt() in src/donut.js. */
export function toReceiptFromRows(o) {
  const rows = rowsOf(o);
  const out = { items: [], subtotal: null, tax: null, service: null, other: null, discount: null, total: null };
  const right = o.width * 0.45;
  let discount = 0, sawDiscount = false, closed = false;
  for (const r of rows) {
    // The amount is the rightmost amount-looking piece in the right half of the receipt.
    const amounts = r.ps.filter((p) => isAmount(p.t));
    const last = amounts.at(-1);
    if (!last || last.x1 < right) continue;
    const words = r.ps.filter((p) => !isAmount(p.t)).map((p) => p.t).join(' ').trim();
    const kind = LABELS.find(([, re]) => re.test(words))?.[0];
    const text = amountText(last.t);
    if (kind === 'payment') { closed = true; continue; }
    if (kind === 'discount' || (kind == null && /-\s*$|^\s*-/.test(last.t))) {
      if (!closed) { const v = parseMoney(text); if (v) { discount += Math.abs(v.cents ? v.v : v.v * 100); sawDiscount = true; } }
      continue;
    }
    if (kind === 'subtotal') { out.subtotal ??= text; closed = true; continue; }
    if (kind === 'tax') { out.tax = out.tax == null ? text : out.tax; closed = true; continue; }
    if (kind === 'service') { out.service ??= text; closed = true; continue; }
    if (kind === 'total') { if (!/item|qty|count|saving|disc/i.test(words)) out.total ??= text; closed = true; continue; }
    if (closed || !words || /^[\d\W]+$/.test(words)) continue;
    // A small whole number at the start is a quantity; a second amount to the left is the unit price.
    // "(2 @ 3.50)" or "(2) (1.95)" after a name is a quantity and a unit price, not part of the name.
    const paren = words.match(/\s*\((\d{1,2})\)?\s*(?:@|x)?\s*\(?\s*\d*[.,]?\d+\s*\)?\s*$/i);
    let name = paren ? words.slice(0, paren.index) : words;
    const lead = name.match(/^(\d{1,2})\s*[xX@]?\s+(?=\D)/);
    if (lead) name = name.slice(lead[0].length);
    const qty = lead?.[1] ?? paren?.[1] ?? null;
    const unit = amounts.length > 1 ? amountText(amounts.at(-2).t) : null;
    out.items.push({ name: name.trim() || words, qty, price: text, unit, subs: [] });
  }
  if (sawDiscount) out.discount = (discount / 100).toFixed(2);
  return out;
}
