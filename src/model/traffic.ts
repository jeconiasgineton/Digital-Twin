import type { ArrivalSpec, BreakSpec, Dist, PeopleRole, Scenario, VehicleType, WorkCalendar } from './types';
import { distMean } from '../math/rng';
import { meanTrailerDepth } from './receiving';

export const PEOPLE_ROLES: PeopleRole[] = ['forklift', 'worker', 'checker', 'mover'];
export const ROLE_NAMES: Record<PeopleRole, string> = { forklift: 'Empilhadeiristas', worker: 'Operários', checker: 'Conferentes', mover: 'Operadores de paleteira/transpaleteira' };

const tri = (a: number, b: number, c: number): Dist => ({ kind: 'triangular', a, b, c });

export const defaultArrival = (): ArrivalSpec => ({
  mode: 'poisson', intervalMin: 30, scheduleHours: [], delayProb: 0.2, delayMin: { kind: 'lognormal', a: 25, b: 20 },
});

export const defaultCalendar = (): WorkCalendar => ({ breaks: [], amrWorksDuringBreaks: true });

let vSeq = 0;
/** presets de veículo: tempos de docagem típicos (carreta mais lenta que truck) */
export function presetVehicle(kind: 'carreta' | 'truck' | 'vuc'): VehicleType {
  const id = `v${Date.now().toString(36)}${vSeq++}`;
  if (kind === 'carreta') return { id, name: 'Carreta', share: 0.5, dockTurnover: tri(120, 180, 300), pallets: { mean: 26, sd: 4, max: 33 }, trailerLengthM: 14 };
  if (kind === 'truck') return { id, name: 'Truck', share: 0.4, dockTurnover: tri(40, 60, 120), pallets: { mean: 12, sd: 2, max: 14 }, trailerLengthM: 8 };
  return { id, name: 'VUC', share: 0.1, dockTurnover: tri(30, 45, 90), pallets: { mean: 5, sd: 1, max: 6 }, trailerLengthM: 5 };
}

export function defaultBreak(kind: 'almoco' | 'cafe' = 'almoco'): BreakSpec {
  return kind === 'almoco'
    ? { name: 'Almoço', startHour: 12, durationMin: 60, groups: [...PEOPLE_ROLES], stagger: 'half', percentPerWave: 50 }
    : { name: 'Café', startHour: 16, durationMin: 15, groups: [...PEOPLE_ROLES], stagger: 'all', percentPerWave: 50 };
}

/** tipos efetivos: os cadastrados ou, se não houver, um tipo único com os parâmetros gerais */
export function effectiveVehicles(sc: Scenario, dir: 'in' | 'out'): VehicleType[] {
  if (sc.vehicleTypes.length) return sc.vehicleTypes;
  return [{ id: 'padrao', name: 'Caminhão', share: 1, dockTurnover: sc.ops.dockTurnover, pallets: dir === 'in' ? sc.palletsPerTruckIn : sc.palletsPerTruckOut, trailerLengthM: 14 }];
}

/** médias ponderadas pela participação: paletes por veículo e tempo de docagem (s) */
export function vehicleMeans(sc: Scenario, dir: 'in' | 'out'): { pallets: number; dockSec: number; depthM: number } {
  const vs = effectiveVehicles(sc, dir);
  const tot = vs.reduce((s, v) => s + Math.max(0, v.share), 0) || 1;
  let pallets = 0;
  let dock = 0;
  let depth = 0;
  for (const v of vs) {
    const w = Math.max(0, v.share) / tot;
    pallets += w * v.pallets.mean;
    dock += w * distMean(v.dockTurnover);
    depth += w * meanTrailerDepth(v.pallets.mean, v.trailerLengthM);
  }
  return { pallets, dockSec: dock, depthM: depth };
}

/** veículos por hora do dia (24 posições) conforme o modo de chegada, antes do fator de demanda */
export function arrivalProfile(sc: Scenario, dir: 'in' | 'out'): number[] {
  const spec = dir === 'in' ? sc.arrivalsIn : sc.arrivalsOut;
  const base = dir === 'in' ? sc.inboundTrucksPerHour : sc.outboundTrucksPerHour;
  if (spec.mode === 'poisson') return base;
  if (spec.mode === 'fixed') return new Array(24).fill(60 / Math.max(0.1, spec.intervalMin));
  const out = new Array(24).fill(0);
  for (const h of spec.scheduleHours) if (h >= 0 && h < 24) out[Math.floor(h)]++;
  return out;
}

/** tempo (s) desde o início do turno até a hora do dia `h`, ou null se cair fora do turno */
export function offsetInShift(sc: Scenario, h: number): number | null {
  const off = (((h - sc.startHour) % 24) + 24) % 24;
  return off < sc.shiftHours ? off * 3600 : null;
}

/** nº de ondas de um intervalo: 1 (todos juntos), 2 (metade por vez) ou ceil(100/%) */
export function breakWaves(b: BreakSpec): number {
  if (b.stagger === 'all') return 1;
  if (b.stagger === 'half') return 2;
  return Math.max(1, Math.ceil(100 / Math.min(100, Math.max(1, b.percentPerWave))));
}

/** onda (0-based) de um recurso dentro do seu grupo: divide a equipe em ondas de tamanho igual */
export function waveOf(b: BreakSpec, index: number, groupSize: number): number {
  const w = breakWaves(b);
  if (w === 1 || groupSize <= 1) return 0;
  const per = Math.ceil(groupSize / w);
  return Math.min(w - 1, Math.floor(index / per));
}

/** minutos de intervalo por pessoa por dia de um grupo (cada pessoa toma cada intervalo aplicável uma vez) */
export function breakMinutesPerDay(sc: Scenario, role: PeopleRole): number {
  return sc.calendar.breaks.filter((b) => b.groups.includes(role) && offsetInShift(sc, b.startHour) !== null).reduce((s, b) => s + Math.max(0, b.durationMin), 0);
}
