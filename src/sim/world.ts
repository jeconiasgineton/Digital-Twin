import type { Layout, LayoutElement, Scenario } from '../model/types';
import {
  type DistField, type NavGrid, type Pt, astar, buildNavGrid, cellCenter, cellOf, dijkstraField, dist, fieldPath,
  linearEnds, nearestFree, pathLength, simplifyPath, toWorld,
} from '../math/spatial';
import type { PoolItem } from './engine';

export const DOCK_DEPTH = 3.5; // ponto interno de trabalho (m para dentro do galpão)
export const TRUCK_SPOT = 7.5; // centro do caminhão estacionado (m para fora)

export interface Agent extends PoolItem {
  kind: 'forklift' | 'worker' | 'checker';
  speedEmpty: number;
  speedLoaded: number;
  km: number;
  tasks: number;
}

export interface DockItem extends PoolItem {
  idx: number;
  el: LayoutElement;
  inner: Pt;
  outer: Pt;
}

export interface ConveyorRT extends PoolItem {
  el: LayoutElement;
  start: Pt;
  end: Pt;
  speed: number;
}

export interface RackRT {
  idx: number;
  el: LayoutElement;
  bays: number;
  levels: number;
  rows: number;
  capacity: number;
  stock: number;
  pickFace: boolean;
  zone: 0 | 1 | 2; // A, B, C
  /** distância média até docas (para ranking) */
  rank: number;
  /** pontos de acesso (por vão e lado), pré-computados */
  access: Pt[][];
}

/** Navegação: grade + campos de distância para pontos-chave + A* com cache para pares. */
export class Nav {
  readonly grid: NavGrid;
  private fields = new Map<number, DistField>();
  private pairs = new Map<number, number>();
  private pairCells = new Map<number, number[]>();

  constructor(layout: Layout) {
    this.grid = buildNavGrid(layout);
  }

  cell(p: Pt): number {
    return nearestFree(this.grid, cellOf(this.grid, p));
  }

  /** registra ponto-chave e calcula seu campo de distância */
  key(p: Pt): number {
    const c = this.cell(p);
    if (!this.fields.has(c)) this.fields.set(c, dijkstraField(this.grid, c));
    return c;
  }

  /** distância de navegação em metros */
  distance(a: Pt, b: Pt): number {
    const ca = this.cell(a);
    const cb = this.cell(b);
    if (ca === cb) return dist(a, b);
    const fb = this.fields.get(cb);
    const fa = this.fields.get(ca);
    let d: number;
    if (fb) d = fb.dist[ca];
    else if (fa) d = fa.dist[cb];
    else {
      const k = ca < cb ? ca * 1_000_003 + cb : cb * 1_000_003 + ca;
      const cached = this.pairs.get(k);
      if (cached !== undefined) return cached;
      const path = astar(this.grid, ca, cb);
      d = path ? pathLength(this.grid, path) : Infinity;
      if (Number.isFinite(d)) this.pairs.set(k, d);
    }
    if (!Number.isFinite(d)) d = (Math.abs(a.x - b.x) + Math.abs(a.z - b.z)) * 1.3; // sem rota: aproxima por Manhattan
    return Math.max(d, dist(a, b));
  }

  /** rota (polilinha simplificada em metros) de a até b */
  route(a: Pt, b: Pt): Pt[] {
    const ca = this.cell(a);
    const cb = this.cell(b);
    let cells: number[] | null = null;
    const fb = this.fields.get(cb);
    const fa = this.fields.get(ca);
    if (fb && Number.isFinite(fb.dist[ca])) cells = fieldPath(fb, ca);
    else if (fa && Number.isFinite(fa.dist[cb])) cells = fieldPath(fa, cb).reverse();
    else {
      const lo = Math.min(ca, cb);
      const hi = Math.max(ca, cb);
      const k = lo * 1_000_003 + hi;
      let c = this.pairCells.get(k);
      if (!c) {
        c = astar(this.grid, lo, hi) ?? [lo, hi];
        if (this.pairCells.size < 4000) this.pairCells.set(k, c);
      }
      cells = ca === lo ? c : [...c].reverse();
    }
    const simp = simplifyPath(this.grid, cells);
    const pts = simp.map((c) => cellCenter(this.grid, c));
    pts[0] = { x: a.x, z: a.z };
    pts[pts.length - 1] = { x: b.x, z: b.z };
    return pts;
  }
}

export interface World {
  layout: Layout;
  nav: Nav;
  racks: RackRT[];
  pickRacks: RackRT[];
  docksIn: DockItem[];
  docksOut: DockItem[];
  conveyors: ConveyorRT[];
  stations: LayoutElement[];
  home: Pt;
  totalCapacity: number;
  /** racks por zona de ABC, ordenados por proximidade */
  zones: RackRT[][];
}

export interface ValidationIssue {
  level: 'erro' | 'aviso';
  msg: string;
}

export function validate(layout: Layout, sc: Scenario): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const c = (t: string) => layout.elements.filter((e) => e.type === t).length;
  if (c('rack') === 0) out.push({ level: 'erro', msg: 'O layout não possui estruturas porta-paletes (racks).' });
  const needIn = sc.inboundTrucksPerHour.some((v) => v > 0);
  const needOut = sc.outboundTrucksPerHour.some((v) => v > 0);
  if (needIn && c('dockIn') === 0) out.push({ level: 'erro', msg: 'Há demanda de recebimento, mas não há docas de entrada.' });
  if (needOut && c('dockOut') === 0) out.push({ level: 'erro', msg: 'Há demanda de expedição, mas não há docas de saída.' });
  if (sc.ordersPerHour.some((v) => v > 0) && c('conveyor') === 0)
    out.push({ level: 'aviso', msg: 'Há pedidos de picking, mas não há esteiras: os operários levarão as caixas a pé até a doca de saída.' });
  if (sc.forklifts.count < 1) out.push({ level: 'aviso', msg: 'Nenhuma empilhadeira configurada.' });
  if (sc.workers.count < 1 && sc.ordersPerHour.some((v) => v > 0)) out.push({ level: 'aviso', msg: 'Nenhum operário configurado para o picking.' });
  return out;
}

/** monta o modelo espacial runtime a partir do layout */
export function buildWorld(layout: Layout, sc: Scenario, sharedNav?: Nav): World {
  const nav = sharedNav ?? new Nav(layout);
  const els = layout.elements;
  const mkDock = (e: LayoutElement, idx: number): DockItem => ({
    id: idx, x: 0, z: 0, busy: false, busyTime: 0, busySince: 0, downTime: 0, idx, el: e,
    inner: toWorld(e, 0, -DOCK_DEPTH),
    outer: toWorld(e, 0, TRUCK_SPOT),
  });
  const docksIn = els.filter((e) => e.type === 'dockIn').map(mkDock);
  const docksOut = els.filter((e) => e.type === 'dockOut').map(mkDock);
  for (const d of [...docksIn, ...docksOut]) {
    d.x = d.inner.x;
    d.z = d.inner.z;
    nav.key(d.inner);
  }
  const conveyors: ConveyorRT[] = els
    .filter((e) => e.type === 'conveyor')
    .map((e, i) => {
      const [s, t] = linearEnds(e);
      nav.key(s);
      return { id: i, x: s.x, z: s.z, busy: false, busyTime: 0, busySince: 0, downTime: 0, el: e, start: s, end: t, speed: e.speed ?? 0.5 };
    });
  const stations = els.filter((e) => e.type === 'station');
  const park = els.find((e) => e.type === 'parking');
  const home: Pt = park ? { x: park.x, z: park.z } : docksIn[0]?.inner ?? { x: layout.floor.width / 2, z: layout.floor.depth / 2 };

  const aisleOff = Math.max(1.2, nav.grid.res * 1.6);
  const racks: RackRT[] = els
    .filter((e) => e.type === 'rack')
    .map((e, idx) => {
      const bays = Math.max(1, e.bays ?? Math.round(e.length / 2.7));
      const levels = Math.max(1, e.levels ?? 4);
      const rows = e.rows ?? (e.width > 1.6 ? 2 : 1);
      // pontos de acesso agrupados (~5 por rack): limita o nº de pares origem-destino distintos
      // (cache de rotas) sem perda relevante de realismo (±1,5 vãos)
      const groups = Math.min(bays, 5);
      const gs = Math.ceil(bays / groups);
      const access: Pt[][] = [];
      for (let b = 0; b < bays; b++) {
        const cb = Math.min(bays - 1, Math.floor(b / gs) * gs + Math.floor(gs / 2));
        const lx = -e.length / 2 + ((cb + 0.5) * e.length) / bays;
        access.push([toWorld(e, lx, e.width / 2 + aisleOff), toWorld(e, lx, -(e.width / 2 + aisleOff))]);
      }
      return { idx, el: e, bays, levels, rows, capacity: bays * levels * rows, stock: 0, pickFace: !!e.pickFace, zone: 2 as 0 | 1 | 2, rank: 0, access };
    });

  // ranking por proximidade média das docas (ABC slotting)
  const docks = [...docksIn, ...docksOut];
  for (const r of racks) {
    const mid = r.access[Math.floor(r.bays / 2)][0];
    let s = 0;
    let n = 0;
    for (const d of docks) {
      s += nav.distance(mid, d.inner);
      n++;
    }
    r.rank = n ? s / n : dist(mid, home);
  }
  const sorted = [...racks].sort((a, b) => a.rank - b.rank);
  const totalCap = racks.reduce((s, r) => s + r.capacity, 0);
  let acc = 0;
  const zones: RackRT[][] = [[], [], []];
  for (const r of sorted) {
    const frac = acc / Math.max(1, totalCap);
    r.zone = frac < 0.2 ? 0 : frac < 0.5 ? 1 : 2;
    zones[r.zone].push(r);
    acc += r.capacity;
  }
  for (let z = 0; z < 3; z++) if (!zones[z].length) zones[z] = z === 0 ? sorted : zones[z - 1];
  let pickRacks = racks.filter((r) => r.pickFace);
  if (!pickRacks.length) pickRacks = racks;

  return { layout, nav, racks, pickRacks, docksIn, docksOut, conveyors, stations, home, totalCapacity: totalCap, zones };
}

/** distância média (m) entre doca e posições de rack – usada pela análise analítica */
export function meanTravel(world: World, from: Pt[], to: (r: RackRT) => Pt, weightByCapacity = true): number {
  if (!from.length || !world.racks.length) return 0;
  let s = 0;
  let w = 0;
  for (const r of world.racks) {
    const wt = weightByCapacity ? r.capacity : 1;
    let d = 0;
    for (const f of from) d += world.nav.distance(f, to(r));
    s += (d / from.length) * wt;
    w += wt;
  }
  return w ? s / w : 0;
}
