/** Teoria das filas aplicada a recursos logísticos (Erlang B/C, M/G/c, Little). */

/** Erlang B – probabilidade de bloqueio com c servidores e carga a = λ/μ (recursão estável). */
export function erlangB(c: number, a: number): number {
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  return b;
}

/** Erlang C – probabilidade de espera (M/M/c). Retorna 1 se instável. */
export function erlangC(c: number, a: number): number {
  if (c <= 0) return 1;
  if (a >= c) return 1;
  const b = erlangB(c, a);
  const rho = a / c;
  return b / (1 - rho * (1 - b));
}

export interface QueueMetrics {
  rho: number;
  stable: boolean;
  pWait: number;
  wq: number; // espera média na fila (s)
  lq: number; // comprimento médio da fila
  w: number; // tempo médio no sistema (s)
  l: number; // nº médio no sistema
  waitQuantile: (p: number) => number; // quantil da espera (s)
  pWaitExceeds: (t: number) => number; // P(Wq > t)
}

/**
 * Aproximação de Allen–Cunneen para M/G/c (ou G/G/c com ca2):
 * Wq ≈ ErlangC/(cμ−λ) · (ca² + cs²)/2.
 * @param lambda taxa de chegada (1/s)
 * @param meanS tempo médio de serviço (s)
 * @param scvS coeficiente de variação² do serviço
 * @param ca2 coeficiente de variação² das chegadas (1 = Poisson)
 */
export function ggcMetrics(c: number, lambda: number, meanS: number, scvS: number, ca2 = 1): QueueMetrics {
  const mu = meanS > 0 ? 1 / meanS : Infinity;
  const a = lambda * meanS;
  const rho = c > 0 ? a / c : Infinity;
  const stable = rho < 1;
  const k = (ca2 + scvS) / 2;
  if (!stable || lambda <= 0) {
    const inf = !stable;
    return {
      rho,
      stable,
      pWait: inf ? 1 : 0,
      wq: inf ? Infinity : 0,
      lq: inf ? Infinity : 0,
      w: inf ? Infinity : meanS,
      l: inf ? Infinity : a,
      waitQuantile: () => (inf ? Infinity : 0),
      pWaitExceeds: () => (inf ? 1 : 0),
    };
  }
  const pw = erlangC(c, a);
  const rate = (c * mu - lambda) / Math.max(k, 1e-9); // taxa efetiva da cauda exponencial
  const wq = (pw / (c * mu - lambda)) * k;
  return {
    rho,
    stable,
    pWait: pw,
    wq,
    lq: lambda * wq,
    w: wq + meanS,
    l: lambda * (wq + meanS),
    pWaitExceeds: (t) => pw * Math.exp(-rate * t),
    waitQuantile: (p) => {
      const tail = 1 - p;
      if (pw <= tail) return 0;
      return Math.log(pw / tail) / rate;
    },
  };
}

export interface SizingResult {
  servers: number;
  metrics: QueueMetrics;
  /** capacidade máxima sustentável (clientes/hora) com o nº de servidores dimensionado */
  capacityPerHour: number;
  reason: string;
}

/**
 * Menor número de servidores c tal que ρ ≤ metaUtil e P(Wq>tAlvo) ≤ 1−nivel (ex.: 5%).
 */
export function sizeServers(opts: {
  lambda: number;
  meanS: number;
  scvS: number;
  availability?: number;
  targetUtil: number;
  waitTarget: number; // s
  confidence: number; // ex.: 0.95
  ca2?: number;
  cMax?: number;
}): SizingResult {
  const avail = opts.availability ?? 1;
  const cMax = opts.cMax ?? 500;
  let reason = 'sem carga';
  if (opts.lambda <= 0 || opts.meanS <= 0) {
    return { servers: 0, metrics: ggcMetrics(1, 0, 1, 0), capacityPerHour: 0, reason };
  }
  for (let c = 1; c <= cMax; c++) {
    const eff = c * avail; // servidores efetivos (disponibilidade)
    // modelo contínuo: usamos 'c' servidores com carga inflada por 1/avail
    const m = ggcMetrics(c, opts.lambda / avail, opts.meanS, opts.scvS, opts.ca2 ?? 1);
    const okUtil = m.rho <= opts.targetUtil;
    const okWait = m.pWaitExceeds(opts.waitTarget) <= 1 - opts.confidence;
    if (okUtil && okWait) {
      reason = `ρ=${(m.rho * 100).toFixed(0)}% ≤ ${(opts.targetUtil * 100).toFixed(0)}% e P(espera>${(opts.waitTarget / 60).toFixed(0)} min)≤${((1 - opts.confidence) * 100).toFixed(0)}%`;
      return { servers: c, metrics: m, capacityPerHour: (eff / opts.meanS) * 3600, reason };
    }
  }
  const m = ggcMetrics(cMax, opts.lambda / avail, opts.meanS, opts.scvS);
  return { servers: cMax, metrics: m, capacityPerHour: ((cMax * avail) / opts.meanS) * 3600, reason: 'limite de busca atingido' };
}

/** Lei de Little: L = λ·W */
export const little = {
  L: (lambda: number, w: number) => lambda * w,
  W: (L: number, lambda: number) => (lambda > 0 ? L / lambda : 0),
  lambda: (L: number, w: number) => (w > 0 ? L / w : 0),
};

/** Estoque de segurança: z · σ_d · √L (σ_d: desvio da demanda por período, L: lead time em períodos). */
export function safetyStock(z: number, sigmaDemand: number, leadPeriods: number): number {
  return z * sigmaDemand * Math.sqrt(Math.max(leadPeriods, 0));
}
