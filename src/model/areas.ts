import type { LayoutElement } from './types';
import { pointInElement } from '../math/spatial';

/** Palete padrão 1,2 × 1,0 m (ISO/GMA) com 30 % de folga de manobra: área útil de piso por palete. */
export const PALLET_FLOOR_M2 = 1.2 * 1.0 * 1.3;

export const AREA_TYPES = ['aisle', 'transit', 'stage', 'triage', 'charger'] as const;
export type AreaType = (typeof AREA_TYPES)[number];
export const isAreaType = (t: string): t is AreaType => (AREA_TYPES as readonly string[]).includes(t);

/** capacidade efetiva: valor informado pelo usuário ou, na falta dele, calculada pela área de piso */
export function areaCapacity(e: LayoutElement): number {
  if (e.type === 'charger') return Math.max(1, Math.round(e.capacity ?? 1));
  if (e.capacity !== undefined && e.capacity !== null && Number.isFinite(e.capacity)) return Math.max(0, Math.round(e.capacity));
  return Math.max(1, Math.floor((e.length * e.width) / PALLET_FLOOR_M2));
}

/** código de rua por índice: A..Z, depois AA, AB… */
export function aisleCode(i: number): string {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** rua de um endereço transitório: a informada ou a rua que o contém (a mais próxima se nenhuma o contém) */
export function aisleOf(transit: LayoutElement, aisles: LayoutElement[]): string | undefined {
  if (transit.aisle && transit.aisle.trim()) return transit.aisle.trim().toUpperCase();
  const p = { x: transit.x, z: transit.z };
  const inside = aisles.find((a) => pointInElement(a, p));
  if (inside) return aisleCodeOf(inside);
  let best: LayoutElement | undefined;
  let bd = Infinity;
  for (const a of aisles) {
    const d = Math.hypot(a.x - p.x, a.z - p.z);
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  return best ? aisleCodeOf(best) : undefined;
}

export const aisleCodeOf = (a: LayoutElement): string => (a.aisle && a.aisle.trim() ? a.aisle.trim().toUpperCase() : a.name);

/** próximo código de rua ainda não usado */
export function nextAisleCode(aisles: LayoutElement[]): string {
  const used = new Set(aisles.map(aisleCodeOf));
  for (let i = 0; ; i++) {
    const c = aisleCode(i);
    if (!used.has(c)) return c;
  }
}
