import { toJSON, toReceipt } from './donut.js';
import { check, fits, payable, totalAgrees, pick } from './check.js';
import { toReceiptFromRows } from './rows.js';
import { parseMoney, formatMoney } from './money.js';
import { split } from './split.js';
import * as model from './model.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const COLORS = ['#c2410c', '#1d6fa5', '#2f7d4f', '#8a3ea8', '#b8860b', '#b03060'];

$('#size').textContent = `${model.SIZE_MB} MB`;

let c = null;           // the checked receipt
let who = [];           // for each line, the people who had it
let people = ['Me', 'Sam'];
let active = 0;
let tip = 0;            // minor units

const status = (s) => { $('#status').textContent = s; };
const money = (v) => formatMoney(v, c?.cents);

// ---------- getting the receipt in --------------------------------------------------------

document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', async () => {
  const blob = await (await fetch(`data/samples/${b.dataset.sample}`)).blob();
  read(blob, b.dataset.note);
}));
$('#file').addEventListener('change', (e) => { if (e.target.files[0]) read(e.target.files[0]); });
const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) read(e.dataTransfer.files[0]); });

async function read(blob, note) {
  const bar = $('#bar');
  bar.hidden = false; bar.value = 0;
  document.querySelectorAll('[data-sample], #file').forEach((x) => { x.disabled = true; });
  $('#photo').src = URL.createObjectURL(blob);
  try {
    status('Loading the receipt reader (once; it is cached after this)…');
    const readReceipt = await model.load((p) => { bar.value = p * 0.8; status(`Downloading the receipt reader… ${Math.round(p * 100)}%`); });
    status('Reading the receipt on this device…');
    bar.removeAttribute('value');
    const t0 = performance.now();
    const image = await model.RawImage.fromBlob(blob);
    const first = check(toReceipt(toJSON(await readReceipt(image))));
    let by = 'Donut';
    c = first;
    if (first.status !== 'adds-up') {
      // The numbers do not add up: let a second open model read it, and keep the read that does.
      status('The numbers do not add up yet. Taking a second look with another model…');
      const readText = await model.loadOcr((p) => { bar.value = p; status(`The numbers do not add up yet. Downloading a second reader (once)… ${Math.round(p * 100)}%`); });
      bar.removeAttribute('value');
      status('The numbers do not add up yet. Taking a second look with another model…');
      const second = check(toReceiptFromRows(await readText(image)));
      c = pick(first, second);
      by = c === second ? 'Florence-2 (Donut’s read did not add up)' : 'Donut (a second look by Florence-2 did not do better)';
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    who = c.lines.map(() => []);
    tip = 0;
    $('#tip').value = '';
    status(`Read by ${by} in ${secs} s on this device. The photo was not uploaded anywhere.${note ? ' ' + note : ''}`);
    if (!c.lines.length) throw new Error('No items found. Is it a receipt, the right way up, and readable?');
    $('#bill').hidden = false;
    render();
    $('#bill').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    status(err.message || String(err));
  } finally {
    bar.hidden = true;
    document.querySelectorAll('[data-sample], #file').forEach((x) => { x.disabled = false; });
  }
}

// ---------- the bill ----------------------------------------------------------------------

const live = () => c.lines.map((l, i) => [l, i]).filter(([l]) => !l.dropped);

function verdict() {
  const sum = live().reduce((s, [l]) => s + l.amount, 0);
  const rule = fits(sum, c);
  if (rule) {
    const fixed = c.fixes.length && c.status === 'fixed';
    return `<p class="verdict ok"><span aria-hidden="true">✓</span> It adds up: ${esc(rule)}.${fixed ? ' ' + c.fixes.map((f) => f.kind === 'drop' ? `I left out “${esc(c.lines[f.line].name)}”: it is the only line that makes the numbers work, so it is probably not something anyone ordered.` : `I multiplied out the quantity on “${esc(c.lines[f.line].name)}”.`).join(' ') : ''}</p>`;
  }
  const target = targetSum();
  const said = c.subtotal != null ? `the subtotal says ${money(c.subtotal)}` : c.total != null ? `the total says ${money(c.total)}` : '';
  const short = target != null && target > sum ? target - sum : 0;
  return `<p class="verdict off"><span aria-hidden="true">!</span> It does not add up${said ? `: the lines come to ${money(sum)}, ${said}` : ''}. Check the prices against the photo and tap one to fix it. The split still comes to the printed total.</p>`
    + (short ? `<button class="mini add-line" data-add="${short}">Add the missing ${money(short)} as a line</button>` : '');
}

/** What the lines should add up to, from the printed subtotal, or the total minus tax and extras. */
function targetSum() {
  if (c.subtotal != null) return c.subtotal;
  if (c.total == null) return null;
  return c.total - ['tax', 'service', 'other'].reduce((a, k) => a + (c[k] ?? 0), 0) + Math.abs(c.discount ?? 0);
}

function render() {
  $('#people').innerHTML = people.map((p, i) => `
    <button class="person ${i === active ? 'on' : ''}" data-person="${i}" style="--c:${COLORS[i % COLORS.length]}" aria-pressed="${i === active}">
      <span class="dot"></span>${esc(p)}</button>`).join('') + '<button id="add" class="person add" aria-label="Add a person">+</button>';
  if (document.activeElement !== $('#person-name')) $('#person-name').value = people[active];

  $('#lines').innerHTML = c.lines.map((l, i) => `
    <li class="line ${l.dropped ? 'dropped' : ''} ${l.addon ? 'addon' : ''}" data-line="${i}">
      <button class="assign" data-assign="${i}" ${l.dropped ? 'disabled' : ''}>
        <span class="name">${esc(l.name || '(no name)')}${l.qty && l.qty !== '1' ? ` <span class="qty">×${esc(l.qty)}</span>` : ''}</span>
        <span class="tags">${l.dropped ? `<span class="why">${esc(l.dropped)}</span>` : who[i].length ? who[i].map((p) => `<span class="tag" data-p="${p}" style="--c:${COLORS[p % COLORS.length]}">${esc(people[p])}</span>`).join('') : '<span class="why">everyone</span>'}</span>
      </button>
      ${l.dropped
        ? `<button class="mini" data-restore="${i}">Put back</button>`
        : `<input class="amount" data-amount="${i}" inputmode="decimal" value="${l.amount == null ? '' : money(l.amount)}" aria-label="Price of ${esc(l.name)}">`}
    </li>`).join('');
  renderTotals();
}

// Everything that depends on names and amounts but not on which buttons exist, so typing a
// name or a price never rebuilds the buttons under someone's finger.
function renderTotals() {
  $('#verdict').innerHTML = verdict();
  const extras = [['subtotal', 'Subtotal'], ['tax', 'Tax'], ['service', 'Service'], ['other', 'Other charges'], ['discount', 'Discount'], ['total', 'Total']]
    .filter(([k]) => c[k] != null && c[k] !== 0);
  const due = payable(c);
  $('#extras').innerHTML = extras.filter(([k]) => k !== 'total').map(([k, name]) => `<li><span>${name}</span><span>${money(k === 'discount' ? -Math.abs(c[k]) : c[k])}</span></li>`).join('')
    + (!totalAgrees(c) ? '<li class="misread"><span>The total does not match the subtotal and tax: check it against the photo</span><span></span></li>' : '')
    + `<li><span>Total</span><span>${money(due)}</span></li>`;

  const lines = live();
  const pay = due + tip;
  const { shares } = split(lines.map(([l]) => l.amount), lines.map(([, i]) => who[i]), people.length, pay);
  $('#shares').innerHTML = people.map((p, k) => `<li style="--c:${COLORS[k % COLORS.length]}"><span class="dot"></span><span class="who">${esc(p)}</span><span class="owes">${money(shares[k])}</span></li>`).join('');
  $('#pay').textContent = money(pay);
  $('#msg').value = message(shares, pay);
}

function message(shares, pay) {
  const lines = live();
  const parts = people.map((p, k) => {
    const mine = lines.filter(([, i]) => who[i].includes(k) || !who[i].length).map(([l, i]) => {
      const n = who[i].length || people.length;
      return n > 1 ? `${n === 2 ? '½' : `1/${n}`} ${l.name}` : l.name;
    });
    return `${p}: ${money(shares[k])}${mine.length ? ` (${mine.join(', ')})` : ''}`;
  });
  return `Split of ${money(pay)}${tip ? ` incl. ${money(tip)} tip` : ''}, tax and extras shared in proportion:\n${parts.join('\n')}`;
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t || !c) return;
  if (t.dataset.person != null) { active = Number(t.dataset.person); render(); }
  else if (t.id === 'add') { people.push(`Friend ${people.length}`); active = people.length - 1; render(); }
  else if (t.dataset.assign != null) {
    const i = Number(t.dataset.assign);
    who[i] = who[i].includes(active) ? who[i].filter((p) => p !== active) : [...who[i], active].sort();
    render();
  } else if (t.dataset.add != null) {
    c.lines.push({ name: 'Missing line', qty: null, amount: Number(t.dataset.add), unit: null, addon: false, dropped: null });
    who.push([]);
    render();
  } else if (t.dataset.restore != null) {
    const l = c.lines[Number(t.dataset.restore)];
    l.dropped = null; l.amount ??= 0;
    render();
  }
});

$('#person-name').addEventListener('input', (e) => {
  people[active] = e.target.value.slice(0, 20) || `Friend ${active}`;
  document.querySelector(`[data-person="${active}"]`).lastChild.textContent = people[active];
  document.querySelectorAll(`.tag[data-p="${active}"]`).forEach((t) => { t.textContent = people[active]; });
});
$('#person-name').addEventListener('change', () => renderTotals());

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.amount != null) {
    const a = parseMoney(t.value);
    const l = c.lines[Number(t.dataset.amount)];
    if (a) l.amount = c.cents && !a.cents ? a.v * 100 : a.v;
    t.value = money(l.amount);
    renderTotals();
  }
});

$('#tip').addEventListener('input', () => {
  const a = parseMoney($('#tip').value);
  tip = a ? (c?.cents && !a.cents ? a.v * 100 : a.v) : 0;
  if (c) renderTotals();
});
document.querySelectorAll('[data-tip]').forEach((b) => b.addEventListener('click', () => {
  if (!c) return;
  const base = payable(c);
  tip = Math.round((base * Number(b.dataset.tip)) / 100);
  $('#tip').value = money(tip);
  render();
}));

$('#copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#msg').value); $('#copy').textContent = 'Copied. Paste it in the group chat.'; }
  catch { $('#msg').select(); }
  setTimeout(() => { $('#copy').textContent = 'Copy for the group chat'; }, 2500);
});

// GitHub Pages cannot send the cross-origin isolation headers that let the model use several
// CPU threads, so sw.js adds them. A service worker only takes effect on pages it served, so
// on the very first visit, reload once it is in control.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').then(async () => {
    if (self.crossOriginIsolated) return;
    let tried = false;
    try { tried = sessionStorage.getItem('isolate-reload') === '1'; sessionStorage.setItem('isolate-reload', '1'); } catch { tried = true; }
    if (tried) return;
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) location.reload();
    else navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  }).catch(() => {});
}
