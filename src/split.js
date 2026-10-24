// Who owes what. Each line is split evenly between the people who had it (nobody tapped:
// everyone). Everything that is not a line (tax, service, the tip, discounts) is shared in
// proportion to what each person had, which is how most people would do it on a napkin.
// Shares are rounded to whole minor units so they add up to exactly what the table pays.

/**
 * @param {number[]} amounts   each line's amount, minor units (dropped lines left out by the caller)
 * @param {number[][]} who     for each line, the people (0..n-1) who had it; empty = everyone
 * @param {number} n           number of people
 * @param {number} pay         what the table pays in total, minor units
 * @returns {{ shares: number[], items: number[] }} what each person pays, and their items alone
 */
export function split(amounts, who, n, pay) {
  const items = new Array(n).fill(0);
  amounts.forEach((a, i) => {
    const ps = who[i]?.length ? who[i] : [...Array(n).keys()];
    for (const p of ps) items[p] += a / ps.length;
  });
  const sum = items.reduce((s, x) => s + x, 0);
  const exact = sum > 0 ? items.map((x) => (x * pay) / sum) : items.map(() => pay / n);
  return { shares: roundTo(exact, pay), items: roundTo(items, Math.round(sum)) };
}

/** Largest-remainder rounding: whole numbers, each within 1 of the exact share, summing to total. */
export function roundTo(exact, total) {
  const floors = exact.map(Math.floor);
  let left = total - floors.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left <= 0) break; floors[i]++; left--; }
  return floors;
}
