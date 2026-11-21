/** Small statistics toolkit for the benchmark chapter of the report. */
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export const stddev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

export const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

// two-sided 97.5th percentile of Student t, df = 1..30 (then ~normal)
const T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
export const tCritical95 = (df: number) => (df < 1 ? NaN : df <= 30 ? T975[df - 1] : df <= 60 ? 2.0 : 1.96);

export const ci95 = (xs: number[]) => {
  if (xs.length < 2) return { low: NaN, high: NaN };
  const half = (tCritical95(xs.length - 1) * stddev(xs)) / Math.sqrt(xs.length);
  const m = mean(xs);
  return { low: m - half, high: m + half };
};

/** Paired t statistic for (a - b). |t| > tCritical95(n-1) => significant at 5%. */
export const pairedT = (a: number[], b: number[]) => {
  const diff = a.map((x, i) => x - b[i]);
  const n = diff.length;
  const sd = stddev(diff);
  const t = n > 1 && sd > 0 ? mean(diff) / (sd / Math.sqrt(n)) : n > 1 && mean(diff) !== 0 ? Infinity : 0;
  return { t, df: n - 1, significant: n > 1 && Math.abs(t) > tCritical95(n - 1) };
};

export const summarize = (xs: number[]) => ({
  n: xs.length, mean: mean(xs), median: median(xs), stddev: stddev(xs),
  min: Math.min(...xs), max: Math.max(...xs), ci95: ci95(xs),
});
