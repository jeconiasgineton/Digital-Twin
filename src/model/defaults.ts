import type { Dist, Scenario } from './types';

const tri = (min: number, mode: number, max: number): Dist => ({ kind: 'triangular', a: min, b: mode, c: max });

/** perfil horário típico (24 posições) normalizado para somar `total` por dia operacional de 16h (06h–22h) */
export function hourlyProfile(total: number, start = 6, hours = 16, shape: 'flat' | 'peaks' = 'peaks'): number[] {
  const arr = new Array(24).fill(0);
  const w: number[] = [];
  for (let k = 0; k < hours; k++) {
    const h = (start + k) % 24;
    const x = k / Math.max(1, hours - 1);
    w[h] = shape === 'flat' ? 1 : 0.65 + 0.7 * Math.exp(-((x - 0.3) ** 2) / 0.02) + 0.5 * Math.exp(-((x - 0.75) ** 2) / 0.03);
  }
  const sum = w.reduce((s, v) => s + (v || 0), 0);
  for (let h = 0; h < 24; h++) arr[h] = w[h] ? (total * w[h]) / sum : 0;
  return arr;
}

export function defaultScenario(): Scenario {
  return {
    name: 'Cenário base',
    shiftHours: 16,
    startHour: 6,
    days: 5,
    warmupHours: 8,
    replications: 20,
    seed: 20240601,
    targetUtilization: 0.85,
    targetWaitP95Min: 10,
    serviceLevel: 0.95,
    forklifts: { count: 5, speedEmpty: 3.0, speedLoaded: 2.2, availability: 0.94, costPerHour: 85 },
    workers: { count: 10, speedEmpty: 1.2, speedLoaded: 1.0, availability: 0.92, costPerHour: 38 },
    checkers: { count: 0, speedEmpty: 1.2, speedLoaded: 1.0, availability: 0.95, costPerHour: 38 },
    inboundTrucksPerHour: hourlyProfile(24),
    outboundTrucksPerHour: hourlyProfile(22),
    ordersPerHour: hourlyProfile(900),
    palletsPerTruckIn: { mean: 18, sd: 4, max: 33 },
    palletsPerTruckOut: { mean: 16, sd: 4, max: 33 },
    linesPerOrder: { mean: 4 },
    cartonsPerLine: { mean: 6, sd: 4 },
    ops: {
      unloadPallet: tri(35, 55, 95),
      checkPallet: tri(30, 45, 90),
      putawayPosition: tri(25, 40, 80),
      loadPallet: tri(40, 60, 100),
      pickCarton: tri(6, 9, 16),
      dockTurnover: tri(300, 480, 900),
      packOrder: tri(40, 70, 140),
    },
    liftSpeed: 0.45,
    levelHeight: 1.8,
    accel: 0.6,
    conveyorSpacing: 0.7,
    initialOccupancy: 0.7,
    dwellDays: 4,
    slotting: 'abc',
    skus: [
      { sku: 'SKU-A1', description: 'Alto giro 1', cls: 'A', share: 0.35, cartonsPerPallet: 80 },
      { sku: 'SKU-A2', description: 'Alto giro 2', cls: 'A', share: 0.3, cartonsPerPallet: 60 },
      { sku: 'SKU-B1', description: 'Médio giro', cls: 'B', share: 0.2, cartonsPerPallet: 48 },
      { sku: 'SKU-C1', description: 'Baixo giro', cls: 'C', share: 0.1, cartonsPerPallet: 40 },
      { sku: 'SKU-C2', description: 'Baixíssimo giro', cls: 'C', share: 0.05, cartonsPerPallet: 40 },
    ],
    demandFactor: 1,
  };
}
