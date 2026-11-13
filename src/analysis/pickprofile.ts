import type { Layout, Scenario } from '../model/types';
import { distMean, Rng } from '../math/rng';
import { type Stop, planRoute, routeTravelSec, splitAmongPickers } from '../model/picking';
import { buildPickPositions } from '../sim/pickpos';
import { travelTime } from '../sim/model';
import type { World } from '../sim/world';

/** perfil do separador por parte de pedido: média de pedidos amostrados com a semente fixa (mesmas regras da simulação) */
export interface PickProfile {
  /** partes (rotas de um separador) por pedido */
  partsPerOrder: number;
  /** paletes de separação fechados por pedido */
  palletsPerOrder: number;
  boxesPerOrder: number;
  stopsPerPart: number;
  /** tempo ocupado do separador por parte, com a rota escolhida (s): manuseio + deslocamento + viagens de palete + furos */
  partSec: number;
  uPartSec: number;
  zPartSec: number;
  /** de cada parte: s gastos em furos de estoque */
  stockoutSec: number;
  /** distância média (m) do stage às paradas */
  stageDist: number;
  /** caixas por palete fechado */
  boxesPerPallet: number;
}

const cache = new Map<string, PickProfile>();

export function pickProfile(sc: Scenario, layout: Layout, w: World, samples = 40): PickProfile | null {
  const pk = sc.picking;
  const key = JSON.stringify([pk, sc.cartonsPerLine, sc.workers.speedEmpty, sc.workers.speedLoaded, sc.accel, layout, samples]);
  const hit = cache.get(key);
  if (hit) return hit;
  const { pickPos, aisleInfo } = buildPickPositions(w, sc);
  if (!pickPos[0].length) return null;
  const rng = new Rng(20240611);
  const stage = w.stagesOut[0]?.pt ?? w.docksOut[0]?.inner ?? w.home;
  w.nav.key(stage);
  const wk = sc.workers;
  const tt = (d: number, loaded: boolean) => travelTime(d, loaded ? wk.speedLoaded : wk.speedEmpty, sc.accel);
  const memo = new Map<string, number>();
  const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => {
    const k = `${a.x.toFixed(2)},${a.z.toFixed(2)}|${b.x.toFixed(2)},${b.z.toFixed(2)}`;
    let v = memo.get(k);
    if (v === undefined) {
      v = w.nav.distance(a, b);
      memo.set(k, v);
    }
    return v;
  };
  const scan = distMean(pk.scan);
  const handle1 = distMean(pk.pick) + distMean(pk.place);
  const tot = Math.max(1e-9, pk.abc.a + pk.abc.b + pk.abc.c);
  const weights = [pk.abc.a / tot, pk.abc.b / tot, pk.abc.c / tot];
  const emptyAddr = new Set(pk.stockout.addresses);
  const delay = distMean(pk.stockout.delay);
  const limit = Math.max(1, pk.palletLimit.mean);
  let parts = 0;
  let pallets = 0;
  let boxesTot = 0;
  let stops = 0;
  let sec = 0;
  let secU = 0;
  let secZ = 0;
  let so = 0;
  let sd = 0;
  let sdn = 0;
  for (let o = 0; o < samples; o++) {
    const boxes = Math.max(1, Math.round(rng.normal(pk.boxesPerOrder.mean, pk.boxesPerOrder.sd)));
    const list: Stop[] = [];
    let left = boxes;
    while (left > 0) {
      const k = Math.min(left, Math.max(1, Math.round(rng.lognormal(sc.cartonsPerLine.mean, sc.cartonsPerLine.sd))));
      const arr = pickPos[rng.pick(weights)];
      list.push({ pos: arr[rng.int(arr.length)], boxes: k });
      left -= k;
    }
    boxesTot += boxes;
    for (const part of splitAmongPickers(list, pk.pickersPerOrder)) {
      const b = part.reduce((n, s) => n + s.boxes, 0);
      const np = Math.max(1, Math.ceil(b / limit));
      const handle = part.length * scan + b * handle1;
      const dStops = part.reduce((n, s) => n + dist(s.pos.pt, stage), 0) / part.length;
      const extra = (np - 1) * (tt(dStops, true) + tt(dStops, false)); // viagens de palete cheio ao stage no meio da rota
      let stock = 0;
      if (pk.stockout.mode === 'pct') stock = part.length * pk.stockout.pct * delay;
      else if (pk.stockout.mode === 'positions') stock = part.filter((s) => emptyAddr.has(s.pos.label)).length * delay;
      const t = (r: 'u' | 'zigzag') => handle + routeTravelSec(planRoute(r, part, stage, aisleInfo, dist), stage, stage, dist, tt) + extra + stock;
      const tu = t('u');
      const tz = t('zigzag');
      secU += tu;
      secZ += tz;
      sec += pk.route === 'u' ? tu : tz;
      so += stock;
      sd += dStops;
      sdn++;
      stops += part.length;
      pallets += np;
      parts++;
    }
  }
  const prof: PickProfile = {
    partsPerOrder: parts / samples, palletsPerOrder: pallets / samples, boxesPerOrder: boxesTot / samples, stopsPerPart: stops / Math.max(1, parts),
    partSec: sec / Math.max(1, parts), uPartSec: secU / Math.max(1, parts), zPartSec: secZ / Math.max(1, parts), stockoutSec: so / Math.max(1, parts),
    stageDist: sd / Math.max(1, sdn), boxesPerPallet: boxesTot / Math.max(1, pallets),
  };
  if (cache.size > 6) cache.clear();
  cache.set(key, prof);
  return prof;
}
