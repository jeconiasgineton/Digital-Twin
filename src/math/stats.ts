import type { SummaryStat } from '../model/types';

export function mean(xs: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return xs.length ? s / xs.length : 0;
}

export function variance(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i] - m) ** 2;
  return s / (n - 1);
}

export const sd = (xs: ArrayLike<number>) => Math.sqrt(variance(xs));

/** percentil (interpolação linear), p em [0,1] */
export function percentile(xs: ArrayLike<number>, p: number): number {
  const n = xs.length;
  if (!n) return 0;
  const a = Array.from(xs).sort((x, y) => x - y);
  const idx = Math.min(Math.max(p, 0), 1) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

/** CDF normal padrão (Abramowitz–Stegun 7.1.26) */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp((-x * x) / 2);
  return 0.5 * (1 + (x >= 0 ? y : -y));
}

/** inversa da CDF normal padrão (Acklam) */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5;
    const r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** quantil t de Student bilateral 95% (Cornish–Fisher a partir de z) */
export function tCrit95(df: number): number {
  if (df <= 0) return NaN;
  const table: Record<number, number> = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228 };
  if (table[df]) return table[df];
  const z = 1.959964;
  const g1 = (z ** 3 + z) / 4;
  const g2 = (5 * z ** 5 + 16 * z ** 3 + 3 * z) / 96;
  const g3 = (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / 384;
  return z + g1 / df + g2 / df ** 2 + g3 / df ** 3;
}

export function summarize(xs: number[]): SummaryStat {
  const n = xs.length;
  const m = mean(xs);
  const s = sd(xs);
  return {
    mean: m,
    sd: s,
    ci95: n > 1 ? (tCrit95(n - 1) * s) / Math.sqrt(n) : 0,
    min: n ? Math.min(...xs) : 0,
    max: n ? Math.max(...xs) : 0,
    p50: percentile(xs, 0.5),
    p90: percentile(xs, 0.9),
    p95: percentile(xs, 0.95),
    n,
  };
}

/** quantil da Poisson(λ) – exato para λ pequeno, aprox. normal com correção de continuidade para λ grande */
export function poissonQuantile(lambda: number, p: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 200) return Math.ceil(lambda + normInv(p) * Math.sqrt(lambda) - 0.5);
  let k = 0;
  let pmf = Math.exp(-lambda);
  let cdf = pmf;
  while (cdf < p && k < 10000) {
    k++;
    pmf *= lambda / k;
    cdf += pmf;
  }
  return k;
}

/** P(N > k) para Poisson(λ) */
export function poissonSf(lambda: number, k: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 200) return 1 - normCdf((k + 0.5 - lambda) / Math.sqrt(lambda));
  let pmf = Math.exp(-lambda);
  let cdf = pmf;
  for (let i = 1; i <= k; i++) {
    pmf *= lambda / i;
    cdf += pmf;
  }
  return Math.max(0, 1 - cdf);
}
