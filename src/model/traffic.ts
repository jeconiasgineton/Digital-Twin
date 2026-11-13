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
export type VehicleKind = 'carreta' | 'truque' | 'truck' | 'toco' | 'vuc' | 'picape' | 'novo';

/**
 * Tipos conhecidos de veículo de carga. Capacidades em paletes (PBR 1,0 × 1,2 m): carreta 28 (referência definida
 * no projeto); toco 12, truque 16 e ¾/VUC 6 de tabelas de lotação de transportadoras (fontes de baixa autoridade);
 * baús e a picape (1 palete) são premissas. Participações e tempos de docagem também são premissas editáveis.
 */
export const VEHICLE_PRESETS: Record<Exclude<VehicleKind, 'truck'>, Omit<VehicleType, 'id'>> = {
  carreta: { name: 'Carreta', share: 0.4, shareIn: 0.45, shareOut: 0.25, dockTurnover: tri(120, 180, 300), capacityPallets: 28, pallets: { mean: 24, sd: 3, max: 28 }, trailerLengthM: 13.6 },
  truque: { name: 'Truque', share: 0.3, shareIn: 0.3, shareOut: 0.3, dockTurnover: tri(60, 90, 150), capacityPallets: 16, pallets: { mean: 14, sd: 2, max: 16 }, trailerLengthM: 8.5 },
  toco: { name: 'Toco', share: 0.2, shareIn: 0.15, shareOut: 0.25, dockTurnover: tri(45, 70, 120), capacityPallets: 12, pallets: { mean: 10, sd: 1.5, max: 12 }, trailerLengthM: 6.5 },
  vuc: { name: 'VUC (3/4)', share: 0.07, shareIn: 0.07, shareOut: 0.15, dockTurnover: tri(30, 45, 90), capacityPallets: 6, pallets: { mean: 5, sd: 1, max: 6 }, trailerLengthM: 4.5 },
  picape: { name: 'Picape', share: 0.03, shareIn: 0.03, shareOut: 0.05, dockTurnover: tri(20, 30, 60), capacityPallets: 1, pallets: { mean: 1, sd: 0, max: 1 }, trailerLengthM: 1.8 },
  novo: { name: 'Novo veículo', share: 0.1, dockTurnover: tri(60, 90, 150), capacityPallets: 10, pallets: { mean: 8, sd: 1, max: 10 }, trailerLengthM: 6 },
};

/** cria um tipo a partir de um modelo conhecido ("truck" é sinônimo de "truque") */
export function presetVehicle(kind: VehicleKind): VehicleType {
  const id = `v${Date.now().toString(36)}${vSeq++}`;
  const p = VEHICLE_PRESETS[kind === 'truck' ? 'truque' : kind];
  return { id, ...JSON.parse(JSON.stringify(p)) } as VehicleType;
}

/** catálogo que já vem no cenário: carreta, truque, toco, VUC e picape */
export function defaultVehicleTypes(): VehicleType[] {
  return (['carreta', 'truque', 'toco', 'vuc', 'picape'] as const).map((k) => ({ id: k, ...JSON.parse(JSON.stringify(VEHICLE_PRESETS[k])) }) as VehicleType);
}

/** participação do tipo num sentido (a própria, se informada, senão a geral) */
export const shareFor = (v: VehicleType, dir: 'in' | 'out'): number => Math.max(0, (dir === 'in' ? v.shareIn : v.shareOut) ?? v.share);

export function defaultBreak(kind: 'almoco' | 'cafe' = 'almoco'): BreakSpec {
  return kind === 'almoco'
    ? { name: 'Almoço', startHour: 12, durationMin: 60, groups: [...PEOPLE_ROLES], stagger: 'half', percentPerWave: 50 }
    : { name: 'Café', startHour: 16, durationMin: 15, groups: [...PEOPLE_ROLES], stagger: 'all', percentPerWave: 50 };
}

/** tipos efetivos: os cadastrados ou, se não houver, um tipo único com os parâmetros gerais */
export function effectiveVehicles(sc: Scenario, dir: 'in' | 'out'): VehicleType[] {
  if (sc.vehicleTypes.length) return sc.vehicleTypes;
  const pl = dir === 'in' ? sc.palletsPerTruckIn : sc.palletsPerTruckOut;
  return [{ id: 'padrao', name: 'Caminhão', share: 1, dockTurnover: sc.ops.dockTurnover, capacityPallets: pl.max, pallets: pl, trailerLengthM: 14 }];
}

/** paletes de uma carga expedida: capacidade do baú × ocupação (com tipos cadastrados) ou a quantidade fixa da expedição por etapas */
export function loadPallets(sc: Scenario, v: VehicleType): number {
  if (sc.expedition.mode === 'basic') return Math.min(v.pallets.mean, v.capacityPallets);
  return sc.vehicleTypes.length ? Math.max(1, Math.round(v.capacityPallets * sc.expedition.loadOccupancy)) : Math.max(1, Math.round(sc.expedition.palletsPerLoad));
}

/** médias ponderadas pela participação: paletes por veículo e tempo de docagem (s) */
export function vehicleMeans(sc: Scenario, dir: 'in' | 'out'): { pallets: number; dockSec: number; depthM: number } {
  const vs = effectiveVehicles(sc, dir);
  const tot = vs.reduce((s, v) => s + shareFor(v, dir), 0) || 1;
  let pallets = 0;
  let dock = 0;
  let depth = 0;
  for (const v of vs) {
    const w = shareFor(v, dir) / tot;
    const n = dir === 'out' ? loadPallets(sc, v) : Math.min(v.pallets.mean, v.capacityPallets);
    pallets += w * n;
    dock += w * distMean(v.dockTurnover);
    depth += w * meanTrailerDepth(n, v.trailerLengthM);
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
