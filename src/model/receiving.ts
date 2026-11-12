import type { ReceivingSpec } from './types';

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
