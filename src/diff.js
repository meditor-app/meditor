// A line diff, for showing what a commit will change before it is made.

/**
 * @returns {{op: ' '|'+'|'-'|'…', line: string}[]} the changed lines with `context` lines
 *   of unchanged text around each change; '…' marks skipped unchanged lines
 */
export function lineDiff(before, after, context = 2) {
  // an empty text has no lines (not one empty line), as a new file's base has none
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  let mid;
  if (am.length * bm.length > 4e6) {
    // too big to align line by line: show it as replaced wholesale
    mid = [...am.map((line) => ({ op: '-', line })), ...bm.map((line) => ({ op: '+', line }))];
  } else {
    // longest common subsequence, filled from the end so the walk below goes forwards
    const n = am.length;
    const m = bm.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i][j] = am[i] === bm[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      }
    }
    mid = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        mid.push({ op: ' ', line: am[i] });
        i++;
        j++;
      } else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) {
        mid.push({ op: '-', line: am[i] });
        i++;
      } else {
        mid.push({ op: '+', line: bm[j] });
        j++;
      }
    }
  }
  const all = [
    ...a.slice(0, pre).map((line) => ({ op: ' ', line })),
    ...mid,
    ...a.slice(a.length - suf).map((line) => ({ op: ' ', line })),
  ];
  // keep only the neighbourhood of the changes
  const keep = new Uint8Array(all.length);
  all.forEach((d, k) => {
    if (d.op !== ' ') for (let t = Math.max(0, k - context); t <= Math.min(all.length - 1, k + context); t++) keep[t] = 1;
  });
  const out = [];
  let skipped = false;
  all.forEach((d, k) => {
    if (keep[k]) { out.push(d); skipped = false; } else if (!skipped) { out.push({ op: '…', line: '' }); skipped = true; }
  });
  return out;
}
