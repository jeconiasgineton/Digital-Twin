import type { Dist } from '../model/types';

/** Gerador pseudo-aleatório determinístico (mulberry32) com streams independentes via fork(). */
export class Rng {
  private s: number;
  private spare: number | null = null;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  /** U(0,1) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** cria um stream derivado (reprodutível) a partir de um rótulo */
  fork(label: string): Rng {
    let h = this.s ^ 0x811c9dc5;
    for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 16777619);
    return new Rng(h >>> 0);
  }
  uniform(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  exp(mean: number): number {
    return -mean * Math.log(1 - this.next());
  }
  normal(mean = 0, sd = 1): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return mean + sd * v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return mean + sd * r * Math.cos(2 * Math.PI * v);
  }
  /** lognormal parametrizada pela média e desvio-padrão da própria variável */
  lognormal(mean: number, sd: number): number {
    if (mean <= 0) return 0;
    const s2 = Math.log(1 + (sd * sd) / (mean * mean));
    return Math.exp(Math.log(mean) - s2 / 2 + Math.sqrt(s2) * this.normal());
  }
  triangular(min: number, mode: number, max: number): number {
    if (max <= min) return min;
    const u = this.next();
    const f = (mode - min) / (max - min);
    return u < f
      ? min + Math.sqrt(u * (max - min) * (mode - min))
      : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
  }
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 60) return Math.max(0, Math.round(this.normal(lambda, Math.sqrt(lambda))));
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > L);
    return k - 1;
  }
  /** escolha ponderada */
  pick(weights: number[]): number {
    let tot = 0;
    for (const w of weights) tot += w;
    let r = this.next() * tot;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }
}

export function sampleDist(rng: Rng, d: Dist): number {
  switch (d.kind) {
    case 'constant':
      return d.a;
    case 'triangular':
      return rng.triangular(d.a, d.b ?? d.a, d.c ?? d.b ?? d.a);
    case 'normal':
      return Math.max(0, rng.normal(d.a, d.b ?? 0));
    case 'lognormal':
      return rng.lognormal(d.a, d.b ?? 0);
    case 'exponential':
      return rng.exp(d.a);
    case 'uniform':
      return rng.uniform(d.a, d.b ?? d.a);
  }
}

/** média analítica de uma distribuição */
export function distMean(d: Dist): number {
  switch (d.kind) {
    case 'constant':
      return d.a;
    case 'triangular':
      return (d.a + (d.b ?? d.a) + (d.c ?? d.b ?? d.a)) / 3;
    case 'normal':
    case 'lognormal':
    case 'exponential':
      return d.a;
    case 'uniform':
      return (d.a + (d.b ?? d.a)) / 2;
  }
}

/** variância analítica */
export function distVar(d: Dist): number {
  switch (d.kind) {
    case 'constant':
      return 0;
    case 'triangular': {
      const a = d.a;
      const b = d.c ?? d.b ?? d.a;
      const c = d.b ?? d.a;
      return (a * a + b * b + c * c - a * b - a * c - b * c) / 18;
    }
    case 'normal':
    case 'lognormal':
      return (d.b ?? 0) ** 2;
    case 'exponential':
      return d.a * d.a;
    case 'uniform':
      return ((d.b ?? d.a) - d.a) ** 2 / 12;
  }
}

/** coeficiente de variação ao quadrado */
export function distScv(d: Dist): number {
  const m = distMean(d);
  return m > 0 ? distVar(d) / (m * m) : 0;
}
