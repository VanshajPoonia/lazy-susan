// Amounts as printed on receipts, read into whole minor units (cents, or rupiah).
//
// "13.99", "$13.99", "4,75" (decimal comma), "60.000" and "60,000" (thousands, Indonesia),
// "1,450.00", "1.450,00", "-60.000", "Rs1,971.00". Two digits after the last separator is a
// decimal part; three is a thousands group. That one rule covers every format in both test sets.

/** Parses an amount, or returns null if the text is not one ("19:19", "TRN#1000727", "Gst 2"). */
export function parseMoney(text) {
  if (text == null) return null;
  let s = String(text).trim();
  if (!s) return null;
  if (/\d[:/]\d/.test(s)) return null;                    // a time or a date
  if (/[a-z]{3,}/i.test(s.replace(/\b(?:rp|rs|idr|usd|eur|gbp|inr|aud|cad|sgd|myr|aed)\b\.?/gi, ''))) return null; // words, not an amount
  const neg = /^\(.*\)$/.test(s) || /^-|-$|\bcr\b/i.test(s);
  s = s.replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return null;
  if (s.replace(/[.,]/g, '').length > 9) return null;     // a card or reference number
  const last = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  let whole, frac = '';
  if (last === -1) whole = s;
  else {
    const after = s.slice(last + 1);
    if (after.length === 2 || after.length === 1) { whole = s.slice(0, last); frac = after.padEnd(2, '0'); }
    else if (after.length === 3) { whole = s.slice(0, last) + after; }
    else return null;
  }
  whole = whole.replace(/[.,]/g, '');
  if (!/^\d+$/.test(whole || '0')) return null;
  const minor = Number(whole || '0') * (frac ? 100 : 1) + (frac ? Number(frac) : 0);
  // Keep track of whether the receipt prints cents: needed to compare "60.000" with "60000".
  return { v: neg ? -minor : minor, cents: !!frac };
}

/** Puts amounts from one receipt on one scale: if any has cents, all are in cents. */
export function unify(amounts) {
  const cents = amounts.some((a) => a?.cents);
  return amounts.map((a) => (a == null ? null : cents && !a.cents ? a.v * 100 : a.v));
}

/** Formats minor units for display, in the receipt's own style. */
export function formatMoney(v, cents) {
  const neg = v < 0;
  const a = Math.abs(v);
  const s = cents
    ? `${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`
    : a.toLocaleString('en-US');
  return neg ? `-${s}` : s;
}
