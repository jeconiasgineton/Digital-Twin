import type { Layout, LayoutElement } from '../model/types';

export interface Pt {
  x: number;
  z: number;
}

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.z - b.z);

const DEG = Math.PI / 180;

/** converte coordenada local do elemento em coordenada de mundo */
export function toWorld(el: { x: number; z: number; rot: number }, lx: number, lz: number): Pt {
  const c = Math.cos(el.rot * DEG);
  const s = Math.sin(el.rot * DEG);
  // rotação horária vista de cima (eixo Z para baixo): x' = x c - z s ; z' = x s + z c
  return { x: el.x + lx * c - lz * s, z: el.z + lx * s + lz * c };
}

/** converte coordenada de mundo em local do elemento */
export function toLocal(el: { x: number; z: number; rot: number }, p: Pt): Pt {
  const c = Math.cos(el.rot * DEG);
  const s = Math.sin(el.rot * DEG);
  const dx = p.x - el.x;
  const dz = p.z - el.z;
  return { x: dx * c + dz * s, z: -dx * s + dz * c };
}

/** Elementos centrados (rack, zone, station, parking, dock); wall e conveyor partem do ponto (x,z) ao longo de +X local. */
export const isLinear = (e: LayoutElement) => e.type === 'wall' || e.type === 'conveyor';

export function elementCenter(e: LayoutElement): Pt {
  return isLinear(e) ? toWorld(e, e.length / 2, 0) : { x: e.x, z: e.z };
}

export function linearEnds(e: LayoutElement): [Pt, Pt] {
  return [toWorld(e, 0, 0), toWorld(e, e.length, 0)];
}

export function pointInElement(e: LayoutElement, p: Pt, pad = 0): boolean {
  const l = toLocal(e, p);
  if (isLinear(e)) {
    return l.x >= -pad && l.x <= e.length + pad && Math.abs(l.z) <= e.width / 2 + pad;
  }
  return Math.abs(l.x) <= e.length / 2 + pad && Math.abs(l.z) <= e.width / 2 + pad;
}

export interface NavGrid {
  res: number;
  w: number; // nº de colunas
  h: number; // nº de linhas
  ox: number;
  oz: number; // origem (canto mín.) em metros
  blocked: Uint8Array;
}

/** Constrói grade de ocupação: racks e paredes bloqueiam; resolução adaptativa (≤ ~25k células). */
export function buildNavGrid(layout: Layout): NavGrid {
  const pad = 2;
  let minX = 0;
  let minZ = 0;
  let maxX = layout.floor.width;
  let maxZ = layout.floor.depth;
  for (const e of layout.elements) {
    const pts: Pt[] = isLinear(e) ? linearEnds(e) : [
      toWorld(e, -e.length / 2, -e.width / 2), toWorld(e, e.length / 2, -e.width / 2),
      toWorld(e, e.length / 2, e.width / 2), toWorld(e, -e.length / 2, e.width / 2),
    ];
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
  }
  minX -= pad;
  minZ -= pad;
  maxX += pad;
  maxZ += pad;
  const area = (maxX - minX) * (maxZ - minZ);
  const res = Math.max(0.5, Math.round(Math.sqrt(area / 25000) * 4) / 4);
  const w = Math.max(2, Math.ceil((maxX - minX) / res));
  const h = Math.max(2, Math.ceil((maxZ - minZ) / res));
  const blocked = new Uint8Array(w * h);
  const grid: NavGrid = { res, w, h, ox: minX, oz: minZ, blocked };
  for (const e of layout.elements) {
    if (e.type !== 'rack' && e.type !== 'wall') continue;
    // varre apenas o bounding box do elemento
    const pts: Pt[] = isLinear(e)
      ? linearEnds(e)
      : [toWorld(e, -e.length / 2, -e.width / 2), toWorld(e, e.length / 2, -e.width / 2), toWorld(e, e.length / 2, e.width / 2), toWorld(e, -e.length / 2, e.width / 2)];
    const bx0 = Math.max(0, Math.floor((Math.min(...pts.map((p) => p.x)) - e.width - minX) / res));
    const bx1 = Math.min(w - 1, Math.ceil((Math.max(...pts.map((p) => p.x)) + e.width - minX) / res));
    const bz0 = Math.max(0, Math.floor((Math.min(...pts.map((p) => p.z)) - e.width - minZ) / res));
    const bz1 = Math.min(h - 1, Math.ceil((Math.max(...pts.map((p) => p.z)) + e.width - minZ) / res));
    const half = res / 2;
    for (let cz = bz0; cz <= bz1; cz++) {
      for (let cx = bx0; cx <= bx1; cx++) {
        const p = { x: minX + (cx + 0.5) * res, z: minZ + (cz + 0.5) * res };
        const l = toLocal(e, p);
        let inside: boolean;
        if (isLinear(e)) {
          const t = Math.max(e.width, res);
          inside = l.x >= -half && l.x <= e.length + half && Math.abs(l.z) <= t / 2;
        } else {
          // encolhe levemente para não fechar corredores por arredondamento
          inside = Math.abs(l.x) <= e.length / 2 - half * 0.2 && Math.abs(l.z) <= e.width / 2 - half * 0.2;
        }
        if (inside) blocked[cz * w + cx] = 1;
      }
    }
  }
  return grid;
}

export const cellOf = (g: NavGrid, p: Pt): number => {
  const cx = Math.min(g.w - 1, Math.max(0, Math.floor((p.x - g.ox) / g.res)));
  const cz = Math.min(g.h - 1, Math.max(0, Math.floor((p.z - g.oz) / g.res)));
  return cz * g.w + cx;
};
export const cellCenter = (g: NavGrid, idx: number): Pt => ({
  x: g.ox + ((idx % g.w) + 0.5) * g.res,
  z: g.oz + (Math.floor(idx / g.w) + 0.5) * g.res,
});

/** célula livre mais próxima (busca em espiral por anéis) */
export function nearestFree(g: NavGrid, idx: number): number {
  if (!g.blocked[idx]) return idx;
  const cx0 = idx % g.w;
  const cz0 = Math.floor(idx / g.w);
  for (let r = 1; r < Math.max(g.w, g.h); r++) {
    let best = -1;
    let bd = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = cx0 + dx;
        const cz = cz0 + dz;
        if (cx < 0 || cz < 0 || cx >= g.w || cz >= g.h) continue;
        const i = cz * g.w + cx;
        if (!g.blocked[i] && dx * dx + dz * dz < bd) {
          bd = dx * dx + dz * dz;
          best = i;
        }
      }
    }
    if (best >= 0) return best;
  }
  return idx;
}

const SQ2 = Math.SQRT2;
const NB = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQ2], [1, -1, SQ2], [-1, 1, SQ2], [-1, -1, SQ2],
];

/** Heap binário mínimo (chave numérica) */
class MinHeap {
  keys: number[] = [];
  vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(k: number, v: number) {
    const ks = this.keys;
    const vs = this.vals;
    let i = ks.length;
    ks.push(k);
    vs.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (ks[p] <= k) break;
      ks[i] = ks[p];
      vs[i] = vs[p];
      i = p;
    }
    ks[i] = k;
    vs[i] = v;
  }
  pop(): number {
    const ks = this.keys;
    const vs = this.vals;
    const top = vs[0];
    const lk = ks.pop()!;
    const lv = vs.pop()!;
    const n = ks.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && ks[c + 1] < ks[c]) c++;
        if (ks[c] >= lk) break;
        ks[i] = ks[c];
        vs[i] = vs[c];
        i = c;
      }
      ks[i] = lk;
      vs[i] = lv;
    }
    return top;
  }
}

/** não permite cortar quinas de obstáculos nas diagonais */
function canStep(g: NavGrid, cx: number, cz: number, dx: number, dz: number): boolean {
  const nx = cx + dx;
  const nz = cz + dz;
  if (nx < 0 || nz < 0 || nx >= g.w || nz >= g.h) return false;
  if (g.blocked[nz * g.w + nx]) return false;
  if (dx !== 0 && dz !== 0) {
    if (g.blocked[cz * g.w + nx] || g.blocked[nz * g.w + cx]) return false;
  }
  return true;
}

/** Campo de distâncias (Dijkstra) a partir de uma célula – permite O(1) para distância e rota. */
export interface DistField {
  src: number;
  dist: Float32Array;
  parent: Int32Array;
}

export function dijkstraField(g: NavGrid, src: number): DistField {
  const n = g.w * g.h;
  const dist = new Float32Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  dist[src] = 0;
  heap.push(0, src);
  while (heap.size) {
    const u = heap.pop();
    const du = dist[u];
    const cx = u % g.w;
    const cz = (u / g.w) | 0;
    for (const [dx, dz, c] of NB) {
      if (!canStep(g, cx, cz, dx, dz)) continue;
      const v = (cz + dz) * g.w + cx + dx;
      const nd = du + c;
      if (nd < dist[v]) {
        dist[v] = nd;
        parent[v] = u;
        heap.push(nd, v);
      }
    }
  }
  // converte para metros
  for (let i = 0; i < n; i++) dist[i] *= g.res;
  return { src, dist, parent };
}

/** estado reutilizável do A* (evita alocar vetores do tamanho da grade a cada consulta) */
interface AStarState {
  g: Float32Array;
  parent: Int32Array;
  stamp: Int32Array;
  closed: Int32Array;
  gen: number;
  heap: MinHeap;
}
const astarStates = new WeakMap<NavGrid, AStarState>();

/** A* entre duas células. Retorna lista de células ou null. */
export function astar(g: NavGrid, s: number, t: number): number[] | null {
  if (s === t) return [s];
  const n = g.w * g.h;
  let st = astarStates.get(g);
  if (!st) {
    st = { g: new Float32Array(n), parent: new Int32Array(n), stamp: new Int32Array(n), closed: new Int32Array(n), gen: 0, heap: new MinHeap() };
    astarStates.set(g, st);
  }
  const gen = ++st.gen;
  const { g: gScore, parent, stamp, closed } = st;
  const heap = st.heap;
  heap.keys.length = 0;
  heap.vals.length = 0;
  const tx = t % g.w;
  const tz = (t / g.w) | 0;
  const hfun = (i: number) => {
    const dx = Math.abs((i % g.w) - tx);
    const dz = Math.abs(((i / g.w) | 0) - tz);
    return (Math.max(dx, dz) + (SQ2 - 1) * Math.min(dx, dz)) * 1.001;
  };
  stamp[s] = gen;
  gScore[s] = 0;
  parent[s] = -1;
  heap.push(hfun(s), s);
  while (heap.size) {
    const u = heap.pop();
    if (u === t) {
      const path = [t];
      let c = t;
      while (parent[c] >= 0) {
        c = parent[c];
        path.push(c);
      }
      return path.reverse();
    }
    if (closed[u] === gen) continue;
    closed[u] = gen;
    const cx = u % g.w;
    const cz = (u / g.w) | 0;
    for (const [dx, dz, c] of NB) {
      if (!canStep(g, cx, cz, dx, dz)) continue;
      const v = (cz + dz) * g.w + cx + dx;
      const ng = gScore[u] + c;
      if (stamp[v] !== gen || ng < gScore[v]) {
        stamp[v] = gen;
        gScore[v] = ng;
        parent[v] = u;
        heap.push(ng + hfun(v), v);
      }
    }
  }
  return null;
}

export function pathLength(g: NavGrid, cells: number[]): number {
  let L = 0;
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1];
    const b = cells[i];
    const diag = a % g.w !== b % g.w && ((a / g.w) | 0) !== ((b / g.w) | 0);
    L += diag ? SQ2 : 1;
  }
  return L * g.res;
}

/** linha de visada livre entre duas células */
function lineOfSight(g: NavGrid, a: number, b: number): boolean {
  let x0 = a % g.w;
  let z0 = (a / g.w) | 0;
  const x1 = b % g.w;
  const z1 = (b / g.w) | 0;
  const dx = Math.abs(x1 - x0);
  const dz = Math.abs(z1 - z0);
  const sx = x0 < x1 ? 1 : -1;
  const sz = z0 < z1 ? 1 : -1;
  let err = dx - dz;
  for (;;) {
    if (g.blocked[z0 * g.w + x0]) return false;
    if (x0 === x1 && z0 === z1) return true;
    const e2 = 2 * err;
    let mx = 0;
    let mz = 0;
    if (e2 > -dz) {
      err -= dz;
      mx = sx;
    }
    if (e2 < dx) {
      err += dx;
      mz = sz;
    }
    // evita atravessar quinas
    if (mx !== 0 && mz !== 0 && (g.blocked[z0 * g.w + x0 + mx] || g.blocked[(z0 + mz) * g.w + x0])) return false;
    x0 += mx;
    z0 += mz;
  }
}

/** "string pulling": reduz o caminho em células a poucos vértices (rota visual suave) */
export function simplifyPath(g: NavGrid, cells: number[]): number[] {
  if (cells.length <= 2) return cells;
  const out = [cells[0]];
  let i = 0;
  while (i < cells.length - 1) {
    let j = cells.length - 1;
    while (j > i + 1 && !lineOfSight(g, cells[i], cells[j])) j--;
    out.push(cells[j]);
    i = j;
  }
  return out;
}

/** caminho (células) de `from` até a fonte do campo, seguindo os pais. */
export function fieldPath(f: DistField, from: number): number[] {
  const out = [from];
  let c = from;
  while (f.parent[c] >= 0) {
    c = f.parent[c];
    out.push(c);
  }
  return out;
}
