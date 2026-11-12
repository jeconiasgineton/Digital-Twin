import type { Dist } from './types';

/**
 * Separação picking por palete: o operador percorre uma rota de endereços, lê o código de cada endereço,
 * pega as caixas e as coloca no palete; ao atingir o limite do palete, leva-o ao stage de expedição.
 */

export type PickRoute = 'u' | 'zigzag';
export const ROUTE_LABEL: Record<PickRoute, string> = { u: 'Em U (um lado na ida, o outro na volta)', zigzag: 'Zigue-zague (caixa mais próxima, qualquer lado)' };

export interface PickingSpec {
  /** legacy: fluxo antigo (esteira e embalagem) · pallet: separação por palete com rota */
  mode: 'legacy' | 'pallet';
  /** caixas por pedido (média e desvio) */
  boxesPerOrder: { mean: number; sd: number };
  /** percentual de caixas das curvas A, B e C (normalizado) */
  abc: { a: number; b: number; c: number };
  /** limite de caixas por palete de separação (média e desvio; cada palete sorteia o seu) */
  palletLimit: { mean: number; sd: number };
  route: PickRoute;
  /** separadores por pedido (o pedido é dividido por ruas) */
  pickersPerOrder: number;
  /** ler o código do endereço (por parada) */
  scan: Dist;
  /** pegar uma caixa */
  pick: Dist;
  /** colocar uma caixa no palete */
  place: Dist;
  stockout: {
    mode: 'off' | 'pct' | 'positions';
    /** pct: probabilidade de o endereço estar vazio quando o operador chega */
    pct: number;
    /** positions: endereços que ficam vazios durante a simulação (ex.: A015) */
    addresses: string[];
    /** tempo perdido até a reposição (s) */
    delay: Dist;
  };
}

/**
 * Padrões. Leitura de endereço de 3 s e ~10 s por caixa (pegar + colocar) partem de um exemplo público de
 * cálculo de picking (3 s de leitura + 12 s de coleta por linha) e das faixas de 100–250 caixas/h por pessoa de
 * guias do setor; são premissas editáveis. Palete de 60 caixas, 3% de furos e 5 min de reposição também.
 */
export const defaultPicking = (): PickingSpec => ({
  mode: 'legacy',
  boxesPerOrder: { mean: 24, sd: 12 },
  abc: { a: 0.7, b: 0.2, c: 0.1 },
  palletLimit: { mean: 60, sd: 8 },
  route: 'u',
  pickersPerOrder: 1,
  scan: { kind: 'constant', a: 3 },
  pick: { kind: 'triangular', a: 3, b: 5, c: 9 },
  place: { kind: 'triangular', a: 2, b: 4, c: 7 },
  stockout: { mode: 'off', pct: 0.03, addresses: [], delay: { kind: 'triangular', a: 120, b: 300, c: 900 } },
});

export const PICKING_SOURCE =
  'Premissa a partir de referências públicas: exemplo de calculadora de picking (3 s de leitura + 12 s de coleta por linha) e faixas de 100–250 caixas por hora por pessoa (case picking). Edite com os tempos medidos na sua operação.';

/** lista de endereços digitada pelo usuário ("A015, B023; C101") → normalizada */
export function parseAddresses(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
}

export interface PickPoint {
  x: number;
  z: number;
}

export interface PickPos {
  label: string;
  aisle: string;
  /** coordenada ao longo da rua */
  axis: number;
  /** 0 = lado direito da rua, 1 = lado esquerdo */
  side: 0 | 1;
  pt: PickPoint;
}

export interface Stop {
  pos: PickPos;
  boxes: number;
}

export interface AisleInfo {
  code: string;
  lo: PickPoint;
  hi: PickPoint;
}

type Dist2 = (a: PickPoint, b: PickPoint) => number;

/** rota em U: por rua, entra por uma ponta, coleta um lado na ida e o outro na volta; ruas da mais próxima à mais distante */
export function planU(stops: Stop[], from: PickPoint, aisles: Map<string, AisleInfo>, dist: Dist2): Stop[] {
  const groups = new Map<string, Stop[]>();
  for (const s of stops) groups.set(s.pos.aisle, [...(groups.get(s.pos.aisle) ?? []), s]);
  const out: Stop[] = [];
  let cur = from;
  while (groups.size) {
    let bestCode = '';
    let bestD = Infinity;
    for (const code of groups.keys()) {
      const info = aisles.get(code);
      const d = info ? Math.min(dist(cur, info.lo), dist(cur, info.hi)) : dist(cur, groups.get(code)![0].pos.pt);
      if (d < bestD) {
        bestD = d;
        bestCode = code;
      }
    }
    const list = groups.get(bestCode)!;
    groups.delete(bestCode);
    const info = aisles.get(bestCode);
    const dir = info && dist(cur, info.lo) > dist(cur, info.hi) ? -1 : 1;
    const a = list.filter((s) => s.pos.side === 0).sort((p, q) => (p.pos.axis - q.pos.axis) * dir);
    const b = list.filter((s) => s.pos.side === 1).sort((p, q) => (q.pos.axis - p.pos.axis) * dir);
    const seq = [...a, ...b];
    out.push(...seq);
    if (seq.length) cur = seq[seq.length - 1].pos.pt;
  }
  return out;
}

/** zigue-zague: sempre a parada mais próxima, de qualquer lado */
export function planZigzag(stops: Stop[], from: PickPoint, dist: Dist2): Stop[] {
  const rest = [...stops];
  const out: Stop[] = [];
  let cur = from;
  while (rest.length) {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < rest.length; i++) {
      const d = dist(cur, rest[i].pos.pt);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    const [s] = rest.splice(bi, 1);
    out.push(s);
    cur = s.pos.pt;
  }
  return out;
}

export function planRoute(route: PickRoute, stops: Stop[], from: PickPoint, aisles: Map<string, AisleInfo>, dist: Dist2): Stop[] {
  return route === 'u' ? planU(stops, from, aisles, dist) : planZigzag(stops, from, dist);
}

/** tempo de deslocamento (s) da rota: do stage à 1ª parada (vazio), entre paradas (com palete) e de volta ao stage */
export function routeTravelSec(order: Stop[], from: PickPoint, back: PickPoint, dist: Dist2, tt: (d: number, loaded: boolean) => number): number {
  if (!order.length) return 0;
  let t = tt(dist(from, order[0].pos.pt), false);
  for (let i = 1; i < order.length; i++) t += tt(dist(order[i - 1].pos.pt, order[i].pos.pt), true);
  return t + tt(dist(order[order.length - 1].pos.pt, back), true);
}

/** divide as paradas entre n separadores por rua, equilibrando o nº de caixas (maior grupo primeiro) */
export function splitAmongPickers(stops: Stop[], n: number): Stop[][] {
  const groups = new Map<string, Stop[]>();
  for (const s of stops) groups.set(s.pos.aisle, [...(groups.get(s.pos.aisle) ?? []), s]);
  const k = Math.max(1, Math.min(n, groups.size || 1));
  const bins: { boxes: number; stops: Stop[] }[] = Array.from({ length: k }, () => ({ boxes: 0, stops: [] }));
  const ordered = [...groups.values()].sort((a, b) => b.reduce((s, x) => s + x.boxes, 0) - a.reduce((s, x) => s + x.boxes, 0));
  for (const g of ordered) {
    const bin = bins.reduce((m, b) => (b.boxes < m.boxes ? b : m));
    bin.stops.push(...g);
    bin.boxes += g.reduce((s, x) => s + x.boxes, 0);
  }
  return bins.map((b) => b.stops).filter((s) => s.length);
}
