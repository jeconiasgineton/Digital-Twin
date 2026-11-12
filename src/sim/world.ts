import type { EquipmentKind, Layout, LayoutElement, Scenario } from '../model/types';
import { arrivalProfile } from '../model/traffic';
import { validateEquipment } from '../model/equipment';
import { STEP_LABEL, validateProcess } from '../model/process';
import { aisleCodeOf, aisleOf, areaCapacity } from '../model/areas';
import {
  type DistField, type NavGrid, type Pt, astar, buildNavGrid, cellCenter, cellOf, dijkstraField, dist, fieldPath,
  linearEnds, nearestFree, pathLength, pointInElement, simplifyPath, toLocal, toWorld,
} from '../math/spatial';
import type { PoolItem } from './engine';

export const DOCK_DEPTH = 3.5; // ponto interno de trabalho (m para dentro do galpão)
export const TRUCK_SPOT = 7.5; // centro do caminhão estacionado (m para fora)

export interface Agent extends PoolItem {
  kind: 'forklift' | 'worker' | 'checker' | 'mover';
  /** tipo de equipamento do catálogo (empilhadeira, paleteira, transpaleteira, AMR) */
  eq?: EquipmentKind;
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
  /** posições comprometidas (ocupadas + reservadas): base do cálculo de ocupação */
  stock: number;
  /** posições efetivamente ocupadas por palete (disponíveis para retirada) */
  occupied: number;
  /** estado de cada posição: ver SLOT_*; índice = (fileira * vãos + vão) * níveis + nível */
  slots: Uint8Array;
  /** código do rack usado no endereço (ex.: R01) */
  label: string;
  pickFace: boolean;
  zone: 0 | 1 | 2; // A, B, C
  /** distância média até docas (para ranking) */
  rank: number;
  /** pontos de acesso (por vão e lado), pré-computados */
  access: Pt[][];
  /** rua de cada face: [frontal (+Z local), de trás (−Z local)] */
  faceAisle: (string | undefined)[];
  /** estantes já numeradas na rua antes deste rack, por face (numeração contínua ao longo da rua) */
  estanteBase: number[];
}

/** face de acesso de uma posição: racks duplos usam a fileira; racks simples, a face que tem rua */
export function slotSide(r: RackRT, idx: number): 0 | 1 {
  if (r.rows > 1) return slotAddr(r, idx).row % 2 === 0 ? 0 : 1;
  return r.faceAisle[0] || !r.faceAisle[1] ? 0 : 1;
}

export const SLOT_FREE = 0;
export const SLOT_OCCUPIED = 1;
export const SLOT_RESERVED = 2;

export interface SlotAddr {
  row: number;
  bay: number;
  level: number;
}

export function slotAddr(r: RackRT, idx: number): SlotAddr {
  const level = idx % r.levels;
  const rb = (idx - level) / r.levels;
  return { row: Math.floor(rb / r.bays), bay: rb % r.bays, level };
}

/** endereço legível: código do rack + vão (2 dígitos) + nível (ex.: R01-023); fileira só em racks duplos */
export function slotLabel(r: RackRT, idx: number): string {
  const a = slotAddr(r, idx);
  const side = slotSide(r, idx);
  const aisle = r.faceAisle[side];
  if (aisle) return `${aisle}${String(r.estanteBase[side] + a.bay + 1).padStart(2, '0')}${a.level + 1}`;
  const row = r.rows > 1 ? `.${a.row + 1}` : '';
  return `${r.label}${row}-${String(a.bay + 1).padStart(2, '0')}${a.level + 1}`;
}

/** sorteia uma posição no estado `want` (sonda linear a partir de um índice aleatório); -1 se não houver */
export function findSlot(r: RackRT, want: number, start: number): number {
  const n = r.slots.length;
  if (want === SLOT_FREE ? r.stock >= n : r.occupied <= 0) return -1;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (r.slots[i] === want) return i;
  }
  return -1;
}

/** área com capacidade (stage, endereço transitório, triagem, estação de carga) em tempo de execução */
export interface AreaRT {
  idx: number;
  el: LayoutElement;
  capacity: number;
  /** paletes (ou veículos, no caso de estação de carga) presentes */
  occupied: number;
  /** ponto de trabalho (centro da área) */
  pt: Pt;
  /** rua (aisle e transit) */
  aisle?: string;
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
  aisles: AreaRT[];
  transits: AreaRT[];
  /** endereços transitórios por rua */
  transitsByAisle: Map<string, AreaRT[]>;
  stages: AreaRT[];
  /** stages de expedição (destino dos paletes de separação) */
  stagesOut: AreaRT[];
  /** áreas de triagem em ordem de prioridade */
  triages: AreaRT[];
  chargers: AreaRT[];
}

export interface ValidationIssue {
  level: 'erro' | 'aviso';
  msg: string;
}

export function validate(layout: Layout, sc: Scenario): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const c = (t: string) => layout.elements.filter((e) => e.type === t).length;
  if (c('rack') === 0) out.push({ level: 'erro', msg: 'O layout não possui estruturas porta-paletes (racks).' });
  const needIn = arrivalProfile(sc, 'in').some((v) => v > 0);
  const needOut = arrivalProfile(sc, 'out').some((v) => v > 0);
  if (needIn && c('dockIn') === 0) out.push({ level: 'erro', msg: 'Há demanda de recebimento, mas não há docas de entrada.' });
  if (needOut && c('dockOut') === 0) out.push({ level: 'erro', msg: 'Há demanda de expedição, mas não há docas de saída.' });
  if (sc.ordersPerHour.some((v) => v > 0) && c('conveyor') === 0)
    out.push({ level: 'aviso', msg: 'Há pedidos de picking, mas não há esteiras: os operários levarão as caixas a pé até a doca de saída.' });
  const aisles = layout.elements.filter((e) => e.type === 'aisle');
  const codes = aisles.map(aisleCodeOf);
  for (const c of new Set(codes.filter((x, i) => codes.indexOf(x) !== i))) out.push({ level: 'aviso', msg: `Há mais de uma rua com o código "${c}".` });
  for (const t of layout.elements.filter((e) => e.type === 'transit')) {
    const a = aisleOf(t, aisles);
    if (!a) out.push({ level: 'aviso', msg: `O endereço transitório "${t.name}" não pertence a nenhuma rua (desenhe uma rua ou informe o código).` });
    else if (!codes.includes(a) && aisles.length) out.push({ level: 'aviso', msg: `O endereço transitório "${t.name}" aponta para a rua "${a}", que não existe.` });
  }
  out.push(...validateEquipment(sc, c('charger')));
  if (sc.picking.mode === 'pallet') {
    if (layout.elements.filter((e) => e.type === 'stage' && e.stageKind === 'out').length === 0)
      out.push({ level: 'aviso', msg: 'Separação por palete sem stage de expedição: os paletes serão levados à doca de saída (use a ferramenta "Stage" e marque "Expedição").' });
    if (sc.workers.count < 1 && sc.ordersPerHour.some((v) => v > 0)) out.push({ level: 'erro', msg: 'Separação por palete sem operários (separadores) configurados.' });
    if (sc.picking.abc.a + sc.picking.abc.b + sc.picking.abc.c <= 0) out.push({ level: 'erro', msg: 'Separação: os percentuais das curvas A, B e C somam zero.' });
    if (!layout.elements.some((e) => e.type === 'aisle')) out.push({ level: 'aviso', msg: 'Separação por palete sem ruas desenhadas: a rota em U não distingue lados da rua e os endereços não terão letra de rua.' });
    if (sc.picking.stockout.mode === 'positions' && sc.picking.stockout.addresses.length === 0) out.push({ level: 'aviso', msg: 'Furo de estoque por posições ativado, mas nenhum endereço foi informado.' });
  }
  if (sc.useCustomProcesses) {
    const def = sc.processes.find((p) => p.trigger === 'unloadPallet');
    if (!def) out.push({ level: 'erro', msg: 'Processos personalizados ativados, mas não há nenhum processo de recebimento definido.' });
    else {
      for (const i of validateProcess(def)) out.push({ level: i.level, msg: `Processo "${def.name}": ${i.msg}` });
      const need = new Set<string>();
      for (const s of def.steps) if ('with' in s) for (const r of s.with) need.add(r);
      const units = (k: string) => (k === 'worker' ? sc.workers.count : k === 'checker' ? sc.checkers.count : k === 'forklift' ? sc.forklifts.count : sc.equipment.find((e) => e.kind === k)?.count ?? 0);
      const anyUnits = (kinds: string[]) => kinds.some((k) => units(k) > 0);
      for (const s of def.steps) {
        if (!('with' in s) || s.with.length === 0 || anyUnits(s.with)) continue;
        out.push({ level: 'aviso', msg: `Processo "${def.name}": nenhum recurso de "${s.label || STEP_LABEL[s.type]}" tem quantidade > 0; a empilhadeira fará o trabalho.` });
      }
      if (sc.storage.mode === 'phased') out.push({ level: 'aviso', msg: 'Com processos personalizados, a armazenagem faseada é definida pelos blocos do processo (movimentar até a rua + elevar); o modo global não tem efeito.' });
    }
  }
  if (sc.storage.mode === 'phased') {
    const movers = sc.storage.step1With.filter((k) => k !== 'forklift').some((k) => (sc.equipment.find((e) => e.kind === k)?.count ?? 0) > 0);
    if (!movers) out.push({ level: 'aviso', msg: 'Armazenagem faseada sem equipamento de etapa 1 (paleteira/transpaleteira/AMR com quantidade > 0): a empilhadeira fará as duas etapas.' });
    const codes = new Set(aisles.map(aisleCodeOf));
    const transitCodes = new Set(layout.elements.filter((e) => e.type === 'transit').map((t) => aisleOf(t, aisles)).filter(Boolean));
    if (!aisles.length) out.push({ level: 'aviso', msg: 'Armazenagem faseada sem ruas no layout (ferramenta "Rua"): os endereços não terão rua.' });
    for (const c of codes) if (!transitCodes.has(c)) out.push({ level: 'aviso', msg: `A rua "${c}" não tem endereço transitório: a etapa 1 levará o palete direto ao destino, sem limite de espaço.` });
  }
  const rc = sc.receiving;
  if (rc.damagePalletPct > 0 && sc.checkers.count < 1 && needIn)
    out.push({ level: 'aviso', msg: 'Há avarias configuradas, mas não há conferentes: sem conferência não há detecção nem triagem de avarias.' });
  if (rc.damagePalletPct > 0 && sc.checkers.count > 0 && c('triage') === 0)
    out.push({ level: 'aviso', msg: 'Há avarias configuradas, mas o layout não tem área de triagem (ferramenta "Triagem").' });
  if (sc.checkers.count > 0 && c('stage') === 0) out.push({ level: 'aviso', msg: 'Há conferentes, mas o layout não tem stage: o espaço de espera dos paletes não será limitado.' });
  if (rc.unloadWith.length === 0) out.push({ level: 'erro', msg: 'Nenhum equipamento permitido para a descarga do baú.' });
  for (const k of rc.unloadWith) {
    const e = sc.equipment.find((x) => x.kind === k) ?? (k === 'forklift' ? sc.forklifts : undefined);
    if (e && e.count < 1) out.push({ level: 'aviso', msg: `A descarga permite "${e.name}", mas a quantidade configurada é 0.` });
  }
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
      return { idx, el: e, bays, levels, rows, capacity: bays * levels * rows, stock: 0, occupied: 0, slots: new Uint8Array(bays * levels * rows), label: `R${String(idx + 1).padStart(2, '0')}`, pickFace: !!e.pickFace, zone: 2 as 0 | 1 | 2, rank: 0, access, faceAisle: [undefined, undefined], estanteBase: [0, 0] };
    });

  // rua de cada face (manual no painel do rack ou a rua mais próxima daquele lado) e numeração das estantes
  const aisleEls = els.filter((e) => e.type === 'aisle');
  const faces = new Map<string, { r: RackRT; side: 0 | 1; pos: number }[]>();
  for (const r of racks) {
    const manual = [r.el.aisleFront?.trim().toUpperCase() || undefined, r.el.aisleBack?.trim().toUpperCase() || undefined];
    for (const side of [0, 1] as const) {
      const pt = r.access[Math.floor(r.bays / 2)][side];
      let code = manual[side];
      let ael: LayoutElement | undefined = aisleEls.find((a) => (code ? aisleCodeOf(a) === code : pointInElement(a, pt, 0.3)));
      if (!code && !ael) {
        let bd = 4; // máx. 4 m de distância até uma rua
        for (const a of aisleEls) {
          const gap = Math.abs(toLocal(a, pt).z) - a.width / 2;
          if (gap < bd && pointInElement(a, pt, bd)) {
            bd = gap;
            ael = a;
          }
        }
      }
      if (!code && ael) code = aisleCodeOf(ael);
      r.faceAisle[side] = code;
      if (code) {
        const axis = ael ? toLocal(ael, pt).x : pt.x;
        faces.set(code, [...(faces.get(code) ?? []), { r, side, pos: axis }]);
      }
    }
  }
  for (const list of faces.values()) {
    list.sort((a, b) => a.pos - b.pos);
    let acc = 0;
    for (const f of list) {
      f.r.estanteBase[f.side] = acc;
      acc += f.r.bays;
    }
  }

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

  const area = (type: string) => els.filter((e) => e.type === type).map((e, idx): AreaRT => ({ idx, el: e, capacity: areaCapacity(e), occupied: 0, pt: { x: e.x, z: e.z } }));
  const aislesRT = area('aisle').map((a) => ({ ...a, aisle: aisleCodeOf(a.el) }));
  const transits = area('transit').map((a) => ({ ...a, aisle: aisleOf(a.el, aisleEls) }));
  const transitsByAisle = new Map<string, AreaRT[]>();
  for (const t of transits) if (t.aisle) transitsByAisle.set(t.aisle, [...(transitsByAisle.get(t.aisle) ?? []), t]);
  const triages = area('triage').sort((a, b) => (a.el.priority ?? a.idx + 1) - (b.el.priority ?? b.idx + 1));

  return {
    layout, nav, racks, pickRacks, docksIn, docksOut, conveyors, stations, home, totalCapacity: totalCap, zones,
    aisles: aislesRT, transits, transitsByAisle, stages: area('stage').filter((a) => a.el.stageKind !== 'out'), stagesOut: area('stage').filter((a) => a.el.stageKind === 'out'), triages, chargers: area('charger'),
  };
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
