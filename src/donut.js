// Donut writes a receipt as a tag sequence:
//   <s_menu><s_nm>Pad Thai</s_nm><s_cnt>1</s_cnt><s_price>10.95</s_price><sep/><s_nm>...</s_menu>
//   <s_sub_total><s_tax_price>2.11</s_tax_price></s_sub_total><s_total><s_total_price>30.94</s_total_price></s_total>
// toJSON is a port of DonutProcessor.token2json from Hugging Face transformers (Apache-2.0).

export const PROMPT = '<s_cord-v2>';

export function toJSON(seq, inner = false) {
  let tokens = seq.replace(/<s_cord-v2>|<\/s>|<s>|<pad>/g, '').trim();
  const out = {};
  while (tokens) {
    const start = tokens.match(/<s_(.*?)>/);
    if (!start) break;
    const key = start[1];
    const endTag = `</s_${key}>`;
    const endAt = tokens.indexOf(endTag);
    if (endAt === -1) { tokens = tokens.replace(start[0], ''); continue; }
    const content = tokens.slice(tokens.indexOf(start[0]) + start[0].length, endAt).trim();
    if (content.includes('<s_') && content.includes('</s_')) {
      const value = toJSON(content, true);
      if (value.length) out[key] = value.length === 1 ? value[0] : value;
    } else {
      const leaves = content.split('<sep/>').map((l) => l.trim());
      out[key] = leaves.length === 1 ? leaves[0] : leaves;
    }
    tokens = tokens.slice(endAt + endTag.length).trim();
    if (tokens.startsWith('<sep/>')) return [out, ...toJSON(tokens.slice(6), true)];
  }
  if (Object.keys(out).length) return inner ? [out] : out;
  return inner ? [] : {};
}

const list = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
// A field is text. When the model nests tags where it should not, the field is unusable.
const first = (x) => { const v = Array.isArray(x) ? x[0] : x; return typeof v === 'string' ? v : null; };
const one = (x) => (Array.isArray(x) ? x[0] : x) ?? null;

/**
 * The receipt as plain fields, still as printed text:
 *   items: [{ name, qty, price, unit, subs: [{ name, price }] }]
 *   subtotal, tax, service, discount, tip, total
 */
export function toReceipt(json) {
  const items = list(json.menu).filter((m) => m && typeof m === 'object').map((m) => ({
    name: first(m.nm) ?? '',
    qty: first(m.cnt) ?? null,
    price: first(m.price) ?? first(m.itemsubtotal) ?? null,
    unit: first(m.unitprice) ?? null,
    subs: list(m.sub).filter((x) => x && typeof x === 'object').map((s) => ({ name: first(s.nm) ?? '', price: first(s.price) ?? null })),
  }));
  const st = one(json.sub_total) ?? {};
  const t = one(json.total) ?? {};
  return {
    items,
    subtotal: first(st.subtotal_price) ?? null,
    tax: first(st.tax_price) ?? null,
    service: first(st.service_price) ?? null,
    other: first(st.othersvc_price) ?? first(st.etc) ?? null,
    discount: first(st.discount_price) ?? null,
    total: first(t.total_price) ?? null,
  };
}
