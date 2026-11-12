import type { ReceivingSpec, Scenario } from './types';
import { Rng, distMean, sampleDist } from '../math/rng';

/** palete padrão 1,2 m de comprimento: cada fileira de 2 paletes ocupa 1,2 m de profundidade do baú */
export const PALLET_ROW_M = 1.2;

/**
 * Padrões do recebimento. Avaria de 3% dos paletes, fração de caixas 5% / 20% / 100% (mín/moda/máx) e
 * +50% no tempo de conferência são premissas ajustáveis; sem dado público de referência.
 */
export const defaultReceiving = (): ReceivingSpec => ({
  damagePalletPct: 0.03,
  damagedCartonsFraction: { kind: 'triangular', a: 0.05, b: 0.2, c: 1 },
  damagedCheckFactor: 1.5,
  unloadWith: ['forklift'],
  trailerDepth: true,
  triageClearEveryHours: 24,
});

/** distância (m) da porta do baú até a fileira do palete de índice i (0 = mais perto da porta) */
export function trailerDepthM(index: number, lengthM: number): number {
  return Math.min(Math.max(0, lengthM), (Math.floor(index / 2) + 0.5) * PALLET_ROW_M);
}

/** profundidade média no baú (m) para um veículo com n paletes e comprimento de baú L */
export function meanTrailerDepth(n: number, lengthM: number): number {
  const k = Math.max(1, Math.round(n));
  let s = 0;
  for (let i = 0; i < k; i++) s += trailerDepthM(i, lengthM);
  return s / k;
}

export interface CheckStats {
  /** probabilidade de um palete conferido estar avariado */
  pDamaged: number;
  /** dado avariado, probabilidade de ir inteiro para a triagem */
  pWhole: number;
  /** caixas avariadas movidas por palete avariado parcial (média, condicionada a ser parcial) */
  meanBadPartial: number;
  /** tempo médio (s) de conferência + triagem por palete e seu CV² */
  serviceMean: number;
  serviceScv: number;
  /** caixas por palete (média ponderada pelo giro) */
  cartonsPerPallet: number;
}

/**
 * Estatísticas da conferência com avarias: estimadas por amostragem (semente fixa, determinístico)
 * das mesmas distribuições que a simulação usa.
 */
export function checkStats(sc: Scenario, samples = 4000): CheckStats {
  const rc = sc.receiving;
  const skus = sc.skus.length ? sc.skus : [{ share: 1, cartonsPerPallet: 60 }];
  const tot = skus.reduce((s, k) => s + Math.max(0, k.share), 0) || 1;
  const cartons = Math.max(1, Math.round(skus.reduce((s, k) => s + (Math.max(0, k.share) / tot) * k.cartonsPerPallet, 0)));
  const rng = new Rng(20240601);
  let dmg = 0; // paletes avariados na amostra (base de pWhole)
  let whole = 0;
  let badPartial = 0;
  let partial = 0;
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < samples; i++) {
    const damaged = rng.next() < rc.damagePalletPct;
    let t = sampleDist(rng, sc.ops.checkPallet);
    if (damaged) {
      dmg++;
      t *= Math.max(1, rc.damagedCheckFactor);
      const frac = Math.min(1, Math.max(0, sampleDist(rng, rc.damagedCartonsFraction)));
      const bad = Math.min(cartons, Math.max(1, Math.round(frac * cartons)));
      if (bad >= cartons) whole++;
      else {
        partial++;
        badPartial += bad;
        t += bad * distMean(sc.ops.triageCarton);
      }
    }
    sum += t;
    sum2 += t * t;
  }
  const mean = sum / samples;
  const varS = Math.max(0, sum2 / samples - mean * mean);
  return {
    pDamaged: Math.min(1, Math.max(0, rc.damagePalletPct)), // dado exato da configuração (a amostragem só serve para tempos e frações)
    pWhole: dmg ? whole / dmg : 0,
    meanBadPartial: partial ? badPartial / partial : 0,
    serviceMean: mean,
    serviceScv: mean > 0 ? varS / (mean * mean) : 0,
    cartonsPerPallet: cartons,
  };
}
