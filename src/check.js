// A receipt checks itself. The items have to add up to the subtotal, or, with tax, service and
// discounts, to the total. When they do, every price is very probably right, because a
// misread digit almost never cancels out. When they do not, the arithmetic usually says
// which line is wrong: a header the model mistook for something you ordered, or a
// quantity it did not multiply out.
import { parseMoney, unify } from './money.js';

const EXTRAS = ['tax', 'service', 'other', 'discount'];

/** Every way the printed numbers could fit together, as [name, target, extras used]. */
function equations(sum, f) {
  const out = [];
  if (f.subtotal != null) out.push([sum === f.subtotal, 'items = subtotal']);
  if (f.total != null) {
    const have = EXTRAS.filter((k) => f[k] != null && f[k] !== 0);
    for (let mask = 0; mask < 1 << have.length; mask++) {
      const used = have.filter((_, b) => mask & (1 << b));
      const extra = used.reduce((s, k) => s + (k === 'discount' ? -Math.abs(f[k]) : f[k]), 0);
      out.push([sum + extra === f.total, ['items', ...used].join(' + ') + ' = total']);
    }
  }
  return out;
}

/** The first way the numbers fit together, or null. Lines that add up to nothing prove nothing. */
export const fits = (sum, f) => (sum === 0 ? null : equations(sum, f).find(([ok]) => ok)?.[1] ?? null);

/**
 * Parses what Donut read and checks it.
 * @param {ReturnType<import('./donut.js').toReceipt>} r
 * @returns {{ lines, cents, subtotal, tax, service, other, discount, total, status, rule, fixes, off }}
 *   lines: [{ name, qty, amount, addon, dropped }] in receipt order (amount in minor units)
 *   status: 'adds-up' (as read), 'fixed' (after a repair the arithmetic chose), 'off' (neither)
 */
export function check(r) {
  const raw = [];
  for (const it of r.items) {
    raw.push({ name: it.name, qty: it.qty, price: parseMoney(it.price), unit: parseMoney(it.unit), addon: false, text: it.price });
    for (const s of it.subs) if (s.price != null) raw.push({ name: s.name, qty: null, price: parseMoney(s.price), unit: null, addon: true, text: s.price });
  }
  const fieldsRaw = { subtotal: r.subtotal, tax: r.tax, service: r.service, other: r.other, discount: r.discount, total: r.total };
  const parsed = Object.fromEntries(Object.entries(fieldsRaw).map(([k, v]) => [k, parseMoney(v)]));
  const all = unify([...raw.flatMap((l) => [l.price, l.unit]), ...Object.values(parsed)]);
  const cents = [...raw.flatMap((l) => [l.price, l.unit]), ...Object.values(parsed)].some((a) => a?.cents);
  const lines = raw.map((l, i) => ({
    name: l.name, qty: l.qty, amount: all[2 * i], unit: all[2 * i + 1], addon: l.addon,
    dropped: all[2 * i] == null ? 'not an amount' : null,
  }));
  const f = {};
  Object.keys(parsed).forEach((k, i) => { f[k] = all[raw.length * 2 + i]; });

  // No tax, service charge or discount is as big as the bill itself: that is the subtotal
  // read twice, into the wrong field.
  const base = f.subtotal ?? lines.filter((l) => !l.dropped).reduce((a, l) => a + l.amount, 0);
  if (base > 0) for (const k of EXTRAS) if (f[k] != null && Math.abs(f[k]) >= base) f[k] = null;

  // Nothing on the bill costs more than the whole bill: a "price" bigger than the printed
  // subtotal or total is a phone number, a zip code or a reference number.
  const ceiling = Math.max(f.subtotal ?? -Infinity, f.total ?? -Infinity);
  if (ceiling > 0) for (const l of lines) if (!l.dropped && l.amount > ceiling) l.dropped = 'more than the whole bill';

  const live = () => lines.filter((l) => !l.dropped);
  const sum = () => live().reduce((s, l) => s + l.amount, 0);
  const fixes = [];
  let rule = fits(sum(), f);
  let status = rule ? 'adds-up' : 'off';

  // Repair 1: a line was a price for one, and the quantity was never multiplied out.
  if (!rule) {
    for (const l of live()) {
      const q = Number(String(l.qty ?? '').replace(/[^\d]/g, ''));
      if (q > 1 && l.unit != null && l.amount === l.unit) {
        const before = l.amount;
        l.amount = l.unit * q;
        const r2 = fits(sum(), f);
        if (r2) { rule = r2; fixes.push({ line: lines.indexOf(l), kind: 'quantity', from: before, to: l.amount }); break; }
        l.amount = before;
      }
    }
  }
  // Repair 2: one line is not something anyone ordered (the shop's name, a table number).
  // Only taken when exactly one line makes the numbers fit, so the arithmetic is unambiguous,
  // and never when it would leave a single line: that line is usually the subtotal itself.
  if (!rule && live().length > 2) {
    const s = sum();
    const candidates = live().filter((l) => fits(s - l.amount, f));
    if (candidates.length === 1) {
      const l = candidates[0];
      l.dropped = 'does not add up';
      rule = fits(sum(), f);
      fixes.push({ line: lines.indexOf(l), kind: 'drop' });
    }
  }
  if (rule && fixes.length) status = 'fixed';

  // How far off the items are from the most likely target, to tell the person what to look for.
  let off = null;
  if (!rule) {
    const target = f.subtotal ?? (f.total != null ? f.total - EXTRAS.reduce((a, k) => a + (f[k] == null ? 0 : k === 'discount' ? -Math.abs(f[k]) : f[k]), 0) : null);
    if (target != null) off = target - sum();
  }
  return { lines, cents, ...f, status, rule, fixes, off };
}

/** The amount the table actually pays: the printed total, or the lines and extras if there is none. */
export function payable(c) {
  if (c.total != null && c.total > 0) return c.total;
  return (c.subtotal ?? c.lines.filter((l) => !l.dropped).reduce((s, l) => s + l.amount, 0))
    + EXTRAS.reduce((a, k) => a + (c[k] == null ? 0 : k === 'discount' ? -Math.abs(c[k]) : c[k]), 0);
}

/** Whether the printed total agrees with the subtotal (or the lines) plus some of the extras. */
export function totalAgrees(c) {
  if (c.total == null) return true;
  const lines = c.lines.filter((l) => !l.dropped).reduce((s, l) => s + l.amount, 0);
  const noSub = { ...c, subtotal: null };
  return fits(lines, noSub) != null || (c.subtotal != null && fits(c.subtotal, noSub) != null);
}

const RANK = { 'adds-up': 0, fixed: 1, off: 2 };

/**
 * Two readers, one receipt: keep the read whose numbers add up. If both do (or neither does),
 * keep the one that found more lines.
 */
export function pick(...checks) {
  const live = (c) => c.lines.filter((l) => !l.dropped).length;
  return checks.filter(Boolean).sort((a, b) => RANK[a.status] - RANK[b.status] || live(b) - live(a))[0];
}
