// Fast checks of the parts that are not the model: reading amounts, parsing Donut's tags,
// the arithmetic check and its repairs, and the split.
import assert from 'node:assert/strict';
import { parseMoney, unify, formatMoney } from '../src/money.js';
import { toJSON, toReceipt } from '../src/donut.js';
import { check, payable, totalAgrees, pick } from '../src/check.js';
import { rowsOf, toReceiptFromRows } from '../src/rows.js';
import { split, roundTo } from '../src/split.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; };

t('amounts in every format on the test receipts', () => {
  const v = (s) => parseMoney(s)?.v ?? null;
  assert.equal(v('13.99'), 1399);
  assert.equal(v('$13.99'), 1399);
  assert.equal(v('4,75'), 475);
  assert.equal(v('60.000'), 60000);
  assert.equal(v('60,000'), 60000);
  assert.equal(v('1,450.00'), 145000);
  assert.equal(v('1.450,00'), 145000);
  assert.equal(v('-60.000'), -60000);
  assert.equal(v('Rp 25.000'), 25000);
  assert.equal(v('Rs1,971.00'), 197100);
  assert.equal(v('297,00'), 29700);
  assert.equal(v('12'), 12);
});

t('things that are not amounts', () => {
  for (const s of ['19:19', '12/30/2016', 'Airport 22', 'TRN#10007272530003', 'Gst', '', null, 'ARRIVEDERCI!', '4231919123', 'Total'])
    assert.equal(parseMoney(s), null, s);
});

t('one scale per receipt', () => {
  assert.deepEqual(unify([parseMoney('13'), parseMoney('2.50'), null]), [1300, 250, null]);
  assert.deepEqual(unify([parseMoney('60.000'), parseMoney('5.455')]), [60000, 5455]);
  assert.equal(formatMoney(145000, true), '1,450.00');
  assert.equal(formatMoney(60000, false), '60,000');
  assert.equal(formatMoney(-250, true), '-2.50');
});

t('Donut tags to JSON, lists and nesting', () => {
  const seq = '<s_cord-v2><s_menu><s_nm> Pad Thai</s_nm><s_price> 10.95</s_price><sep/><s_nm> Rice</s_nm><s_cnt> 2</s_cnt><s_price> 5.00</s_price></s_menu><s_sub_total><s_tax_price> 1.20</s_tax_price></s_sub_total><s_total><s_total_price> 17.15</s_total_price></s_total></s>';
  const j = toJSON(seq);
  assert.equal(j.menu.length, 2);
  assert.equal(j.menu[1].cnt, '2');
  const r = toReceipt(j);
  assert.equal(r.items[0].name, 'Pad Thai');
  assert.equal(r.tax, '1.20');
  assert.equal(r.total, '17.15');
  assert.deepEqual(toReceipt(toJSON('<s_cord-v2></s>')).items, []);
  // A tag the model never closed is skipped, not fatal.
  assert.equal(toReceipt(toJSON('<s_menu><s_nm> A</s_nm><s_price> 1.00</s_price></s_menu><s_total><s_total_price> 1.00')).items.length, 1);
});

const receipt = (items, extra = {}) => ({
  items: items.map(([name, price, qty = null, unit = null]) => ({ name, price, qty, unit, subs: [] })),
  subtotal: null, tax: null, service: null, other: null, discount: null, total: null, ...extra,
});

t('a receipt that adds up as read', () => {
  const c = check(receipt([['Pad Thai', '10.95'], ['Rice', '2.50'], ['Rice', '2.50'], ['Curry', '12.50']], { tax: '2.49', total: '30.94' }));
  assert.equal(c.status, 'adds-up');
  assert.equal(c.rule, 'items + tax = total');
  assert.equal(payable(c), 3094);
});

t('the shop name read as an item is dropped, because only it makes the sums work', () => {
  const c = check(receipt([['KOREAN RESTAURANT', '19:19'], ['Bibim', '13.99'], ['Dumpling', '8.99'], ['Kimchi BBQ', '22'], ['Rib', '14.99']], { subtotal: '37.97' }));
  assert.equal(c.lines[0].dropped, 'not an amount');
  assert.equal(c.status, 'fixed');
  assert.equal(c.lines[3].dropped, 'does not add up');
});

t('a line bigger than the whole bill is not an item; a total that does not agree is noticed', () => {
  const c = check(receipt([['A', '10.00'], ['Phone 604683', '604683'], ['B', '5.00']], { subtotal: '15.00', tax: '1.20', total: '3.09' }));
  assert.equal(c.lines[1].dropped, 'more than the whole bill');
  assert.equal(c.status, 'adds-up');
  assert.equal(payable(c), 309);
  assert.equal(totalAgrees(c), false);
  assert.equal(totalAgrees(check(receipt([['A', '10.00'], ['B', '5.00']], { subtotal: '15.00', tax: '1.20', total: '16.20' }))), true);
});

t('an extra as big as the bill is the subtotal read twice', () => {
  const c = check(receipt([['A', '50.00'], ['B', '7.30']], { subtotal: '57.30', tax: '4.03', other: '57.30' }));
  assert.equal(c.other, null);
  assert.equal(payable(c), 6133);
});

t('two lines that could each be the odd one out: no guess', () => {
  const c = check(receipt([['A', '5.00'], ['B', '5.00'], ['C', '3.00']], { subtotal: '8.00' }));
  assert.equal(c.status, 'off');
  assert.equal(c.off, -500);
});

t('a quantity that was never multiplied out', () => {
  const c = check(receipt([['Tea', '2.00', '3', '2.00'], ['Cake', '4.00']], { total: '10.00' }));
  assert.equal(c.status, 'fixed');
  assert.equal(c.lines[0].amount, 600);
});

t('Indonesian receipt: thousands separators, tax included, discount', () => {
  const c = check(receipt([['TICKET CP', '60.000']], { tax: '5.455', discount: '-60.000', total: '60.000' }));
  assert.equal(c.status, 'adds-up');
  assert.equal(c.rule, 'items = total');
});

t('split: shared dishes, proportional tax and tip, exact to the cent', () => {
  // Ana had the curry, Ben the pad thai, both shared the rice; tax and tip on top.
  const { shares, items } = split([1250, 1095, 500], [[0], [1], [0, 1]], 2, 3094 + 500);
  assert.deepEqual(items, [1500, 1345]);
  assert.equal(shares[0] + shares[1], 3594);
  assert.ok(Math.abs(shares[0] - 3594 * 1500 / 2845) <= 1);
});

t('split: nobody tapped means everyone', () => {
  assert.deepEqual(split([900], [[]], 3, 900).shares, [300, 300, 300]);
  assert.deepEqual(split([1000], [[]], 3, 1000).shares.reduce((a, b) => a + b, 0), 1000);
});

t('rounding never loses or invents a cent', () => {
  for (let k = 0; k < 200; k++) {
    const ex = Array.from({ length: 1 + (k % 7) }, (_, i) => ((k * 37 + i * 101) % 997) / 3);
    const tot = Math.round(ex.reduce((a, b) => a + b, 0));
    const r = roundTo(ex, tot);
    assert.equal(r.reduce((a, b) => a + b, 0), tot);
    r.forEach((x, i) => assert.ok(Math.abs(x - ex[i]) < 1 + 1e-9));
  }
});

// OCR pieces as Florence-2 returns them: text and a quad (x1 y1 x2 y2 x3 y3 x4 y4).
const piece = (t, x0, y0, x1, y1) => [t, [x0, y0, x1, y0, x1, y1, x0, y1]];
const ocrOf = (list) => ({ text: list.map(([t]) => t), quads: list.map(([, q]) => q), width: 400, height: 600 });

t('OCR rows: names left, amounts right, labelled rows at the bottom', () => {
  const o = ocrOf([
    piece('BASIL THAI', 120, 10, 280, 30),
    piece('Tel 415-552-8999', 100, 40, 300, 60),
    piece('1 Pad Thai', 20, 100, 160, 120), piece('10.95', 320, 101, 380, 121),
    piece('Jasmine Rice', 20, 130, 160, 150), piece('2.50', 330, 131, 380, 151),
    piece('Coupon', 20, 160, 120, 180), piece('1.00-', 320, 160, 380, 180),
    piece('Subtotal', 20, 200, 140, 220), piece('12.45', 320, 200, 380, 220),
    piece('Tax', 20, 230, 80, 250), piece('1.10', 330, 230, 380, 250),
    piece('TOTAL', 20, 260, 110, 280), piece('$13.55', 310, 260, 380, 280),
    piece('VISA', 20, 290, 90, 310), piece('13.55', 320, 290, 380, 310),
  ]);
  assert.equal(rowsOf(o).length, 9);
  const r = toReceiptFromRows(o);
  assert.deepEqual(r.items.map((i) => [i.name, i.qty, i.price]), [['Pad Thai', '1', '10.95'], ['Jasmine Rice', null, '2.50']]);
  assert.equal(r.discount, '1.00');
  assert.deepEqual([r.subtotal, r.tax, r.total], ['12.45', '1.10', '$13.55']);
  // The lines come to 13.45; with the coupon taken off and tax added, that is the total.
  assert.equal(check(r).rule, 'items + tax + discount = total');
});

t('two readers: the read that adds up wins, then the one with more lines', () => {
  const good = check(receipt([['A', '1.00'], ['B', '2.00']], { total: '3.00' }));
  const bad = check(receipt([['A', '1.00'], ['B', '2.50'], ['C', '1.00']], { total: '3.00' }));
  assert.equal(pick(bad, good), good);
  assert.equal(pick(bad, null), bad);
  const fewer = check(receipt([['A', '1.00']], { total: '9.00' }));
  assert.equal(pick(fewer, bad), bad);
});

console.log(`${passed}/${passed} unit checks pass`);
