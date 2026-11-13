import type { Scenario } from '../model/types';
import type { AisleInfo, PickPos } from '../model/picking';
import { toLocal, toWorld } from '../math/spatial';
import { slotLabel, slotSide, type World } from './world';

/**
 * Posições de coleta do picking (as mesmas para a simulação e para a análise analítica):
 * candidatos da área escolhida, divididos nas curvas A/B/C pela proximidade das docas.
 */
export function buildPickPositions(w: World, sc: Scenario): { pickPos: PickPos[][]; aisleInfo: Map<string, AisleInfo>; unmatched: number } {
  const aisleInfo = new Map<string, AisleInfo>();
  const pickPos: PickPos[][] = [[], [], []];
  for (const a of w.aisles) {
    const code = a.aisle ?? a.el.name;
    aisleInfo.set(code, { code, lo: toWorld(a.el, -a.el.length / 2, 0), hi: toWorld(a.el, a.el.length / 2, 0) });
  }
  const area = sc.picking.area;
  const custom = new Set(area.addresses);
  const floorLevels = Math.max(1, Math.round(area.levels));
  const cand: (PickPos & { rank: number })[] = [];
  const found = new Set<string>();
  // sem nenhum endereço válido na área escolhida, cai para o chão de todos os racks (nunca fica sem onde coletar)
  for (const mode of [area.mode, 'floor'] as const) {
    const racks = mode === 'faces' ? w.pickRacks : w.racks;
    for (const r of racks) {
      for (let row = 0; row < r.rows; row++) {
        for (let bay = 0; bay < r.bays; bay++) {
          for (let lv = 0; lv < (mode === 'custom' ? r.levels : Math.min(floorLevels, r.levels)); lv++) {
            const idx = (row * r.bays + bay) * r.levels + lv;
            const label = slotLabel(r, idx);
            if (mode === 'custom') {
              if (!custom.has(label)) continue;
              found.add(label);
            }
            const side = slotSide(r, idx);
            const aisle = r.faceAisle[side] ?? '?';
            const pt = r.access[bay][side];
            const el = w.aisles.find((x) => (x.aisle ?? x.el.name) === aisle)?.el;
            const axis = el ? toLocal(el, pt).x : pt.x;
            const sideLR: 0 | 1 = el && toLocal(el, pt).z < 0 ? 1 : 0;
            cand.push({ label, aisle, axis, side: sideLR, pt, rank: r.rank });
          }
        }
      }
    }
    if (cand.length) break;
  }
  const unmatched = area.mode === 'custom' ? [...custom].filter((a) => !found.has(a)).length : 0;
  // curvas pela proximidade das docas: A = 20% mais próximos, B = 30% seguintes, C = o restante
  cand.sort((a, b) => a.rank - b.rank);
  const n = cand.length;
  cand.forEach((p, i) => pickPos[i < n * 0.2 ? 0 : i < n * 0.5 ? 1 : 2].push(p));
  for (let k = 0; k < 3; k++) if (!pickPos[k].length) pickPos[k] = cand.length ? [...cand] : [];
  return { pickPos, aisleInfo, unmatched };
}
