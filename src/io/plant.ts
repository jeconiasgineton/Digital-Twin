import type { ElementType, Layout, LayoutElement } from '../model/types';
import { aisleCode } from '../model/areas';
import { newId } from '../model/layoutGen';

/**
 * Importação de planta: qualquer formato (DXF, PDF vetorial, imagem) vira um PlantDoc — entidades geométricas
 * agrupadas em "camadas" — e uma tela de mapeamento diz o que cada camada é. A conversão gera elementos do layout.
 */

export interface PlantPt {
  x: number;
  y: number;
}

export interface PlantEntity {
  layer: string;
  pts: PlantPt[];
  closed: boolean;
  /** ponto de inserção (bloco sem geometria utilizável, ex.: símbolo de doca) */
  point?: boolean;
  /** geometria vinda da explosão de um bloco */
  fromBlock?: boolean;
}

export interface PlantDoc {
  source: 'dxf' | 'pdf' | 'image';
  entities: PlantEntity[];
  /** y cresce para cima (CAD e PDF): vira Z = −y */
  yUp: boolean;
  /** metros por unidade do desenho */
  unitScale: number;
  unitLabel: string;
  /** PDF/imagem: o usuário informa a largura real do desenho para calibrar a escala */
  needsScale: boolean;
  notes: string[];
}

export type PlantType = ElementType | 'ignore';

export const PLANT_TYPE_LABEL: Record<PlantType, string> = {
  ignore: 'Ignorar', wall: 'Parede', rack: 'Rack (porta-paletes)', dockIn: 'Doca de entrada', dockOut: 'Doca de saída', conveyor: 'Esteira',
  zone: 'Zona', station: 'Estação', parking: 'Estacionamento', aisle: 'Rua', transit: 'Endereço transitório', stage: 'Stage', triage: 'Triagem', charger: 'Carga AMR',
};

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** sugere o tipo de elemento a partir do nome da camada (ou da cor, em PDF) */
export function suggestType(layer: string): PlantType {
  const n = norm(layer);
  if (/transit/.test(n)) return 'transit';
  if (/parede|wall|muro|alvenaria|contorno externo|cerramento/.test(n)) return 'wall';
  if (/doca.*(saida|out|exped)|dock.*out|exped.*doca|saida.*doca/.test(n)) return 'dockOut';
  if (/doca|dock|portao|gate|recebimento/.test(n)) return 'dockIn';
  if (/rack|estante|porta.?pal|pallet|prateleira|shelf|estrutura/.test(n)) return 'rack';
  if (/\b(rua|corredor(es)?|aisle|via)s?\b/.test(n)) return 'aisle';
  if (/stage|staging|confer/.test(n)) return 'stage';
  if (/triag/.test(n)) return 'triage';
  if (/amr|carreg|charger|bateria/.test(n)) return 'charger';
  if (/esteira|conveyor|transportador/.test(n)) return 'conveyor';
  if (/estacion|parking|garagem/.test(n)) return 'parking';
  if (/estacao|station|embal|bancada/.test(n)) return 'station';
  if (/zona|area|zone/.test(n)) return 'zone';
  // PDF: traços escuros viram paredes por padrão; o resto fica para o usuário decidir
  const hex = n.match(/#([0-9a-f]{6})/);
  if (hex && /traco/.test(n)) {
    const v = parseInt(hex[1], 16);
    const [r, g, bl] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    const lum = (0.299 * r + 0.587 * g + 0.114 * bl) / 255;
    const neutral = Math.max(r, g, bl) - Math.min(r, g, bl) < 40; // preto/cinza-escuro, não vermelho/azul escuros
    return lum < 0.35 && neutral ? 'wall' : 'ignore';
  }
  return 'ignore';
}

export interface LayerInfo {
  name: string;
  count: number;
  closed: number;
  points: number;
  suggested: PlantType;
}

export function layerSummary(doc: PlantDoc): LayerInfo[] {
  const m = new Map<string, LayerInfo>();
  for (const e of doc.entities) {
    const l = m.get(e.layer) ?? { name: e.layer, count: 0, closed: 0, points: 0, suggested: suggestType(e.layer) };
    l.count++;
    if (e.closed) l.closed++;
    if (e.point) l.points++;
    m.set(e.layer, l);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/* ------------------------------------------------------------------ DXF */

const UNIT_SCALE: Record<number, [number, string]> = {
  1: [0.0254, 'polegadas'], 2: [0.3048, 'pés'], 4: [0.001, 'mm'], 5: [0.01, 'cm'], 6: [1, 'm'], 14: [0.1, 'dm'],
};

export const DXF_UNIT_OPTIONS: [number, string][] = [[1, 'metros'], [0.1, 'decímetros'], [0.01, 'centímetros'], [0.001, 'milímetros'], [0.0254, 'polegadas'], [0.3048, 'pés']];

interface RawEnt {
  type: string;
  layer: string;
  pts: PlantPt[];
  closed: boolean;
  block?: string;
  rot?: number;
  sx?: number;
  sy?: number;
}

type Pair = [number, string];

function readEntities(pairs: Pair[], from: number, stop: (code: number, val: string) => boolean): { ents: RawEnt[]; next: number } {
  const ents: RawEnt[] = [];
  let i = from;
  const n = pairs.length;
  while (i < n) {
    const [c, v] = pairs[i];
    if (c === 0 && stop(c, v)) break;
    if (c !== 0) {
      i++;
      continue;
    }
    const type = v;
    const e: RawEnt = { type, layer: '0', pts: [], closed: false };
    if (type === 'POLYLINE') {
      i++;
      while (i < n && pairs[i][0] !== 0) {
        if (pairs[i][0] === 8) e.layer = pairs[i][1];
        if (pairs[i][0] === 70) e.closed = (parseInt(pairs[i][1], 10) & 1) === 1;
        i++;
      }
      while (i < n && !(pairs[i][0] === 0 && pairs[i][1] === 'SEQEND')) {
        if (pairs[i][0] === 0 && pairs[i][1] === 'VERTEX') {
          let x = 0;
          let y = 0;
          i++;
          while (i < n && pairs[i][0] !== 0) {
            if (pairs[i][0] === 10) x = parseFloat(pairs[i][1]);
            if (pairs[i][0] === 20) y = parseFloat(pairs[i][1]);
            i++;
          }
          e.pts.push({ x, y });
        } else i++;
      }
      ents.push(e);
      continue;
    }
    i++;
    let cur: PlantPt | null = null;
    while (i < n && pairs[i][0] !== 0) {
      const [code, val] = pairs[i];
      const f = parseFloat(val);
      if (code === 8) e.layer = val;
      else if (code === 2 && type === 'INSERT') e.block = val;
      else if (type === 'LINE') {
        if (code === 10) e.pts[0] = { x: f, y: e.pts[0]?.y ?? 0 };
        else if (code === 20) e.pts[0] = { x: e.pts[0]?.x ?? 0, y: f };
        else if (code === 11) e.pts[1] = { x: f, y: e.pts[1]?.y ?? 0 };
        else if (code === 21) e.pts[1] = { x: e.pts[1]?.x ?? 0, y: f };
      } else if (type === 'LWPOLYLINE') {
        if (code === 70) e.closed = (parseInt(val, 10) & 1) === 1;
        else if (code === 10) {
          cur = { x: f, y: 0 };
          e.pts.push(cur);
        } else if (code === 20 && cur) cur.y = f;
      } else if (type === 'INSERT') {
        if (code === 10) e.pts[0] = { x: f, y: e.pts[0]?.y ?? 0 };
        else if (code === 20) e.pts[0] = { x: e.pts[0]?.x ?? 0, y: f };
        else if (code === 41) e.sx = f;
        else if (code === 42) e.sy = f;
        else if (code === 50) e.rot = f;
      } else if (type === 'BLOCK') {
        if (code === 2) e.block = val;
        else if (code === 10) e.pts[0] = { x: f, y: e.pts[0]?.y ?? 0 };
        else if (code === 20) e.pts[0] = { x: e.pts[0]?.x ?? 0, y: f };
      }
      i++;
    }
    ents.push(e);
  }
  return { ents, next: i };
}

/** lê DXF ASCII: LINE, LWPOLYLINE, POLYLINE e blocos (INSERT), com camadas; arcos, círculos e textos são ignorados */
export function parseDxfPlant(text: string): PlantDoc {
  const lines = text.split(/\r?\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  let insunits = 0;
  for (let i = 0; i < pairs.length; i++)
    if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS')
      for (let j = i + 1; j < Math.min(i + 6, pairs.length); j++) if (pairs[j][0] === 70) { insunits = parseInt(pairs[j][1], 10); break; }

  // seções
  const blocks = new Map<string, { base: PlantPt; ents: RawEnt[] }>();
  let top: RawEnt[] = [];
  let skipped = 0;
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1] === 'SECTION' && pairs[i + 1]?.[0] === 2) {
      const name = pairs[i + 1][1];
      const end = pairs.findIndex((p, k) => k > i && p[0] === 0 && p[1] === 'ENDSEC');
      const slice = pairs.slice(i + 2, end < 0 ? pairs.length : end);
      if (name === 'ENTITIES') top = readEntities(slice, 0, () => false).ents;
      else if (name === 'BLOCKS') {
        let k = 0;
        while (k < slice.length) {
          if (slice[k][0] === 0 && slice[k][1] === 'BLOCK') {
            const hdr = readEntities(slice, k, (_c, v) => v !== 'BLOCK' && v !== 'ENDBLK');
            const head = hdr.ents[0];
            const endBlk = slice.findIndex((p, q) => q > k && p[0] === 0 && p[1] === 'ENDBLK');
            const body = readEntities(slice.slice(k + 1, endBlk < 0 ? slice.length : endBlk), 0, () => false).ents;
            // o registro BLOCK é o primeiro da fatia; readEntities(slice, k) só leu o cabeçalho
            if (head?.block) blocks.set(head.block, { base: head.pts[0] ?? { x: 0, y: 0 }, ents: body.filter((b) => b.type !== 'BLOCK') });
            k = endBlk < 0 ? slice.length : endBlk + 1;
          } else k++;
        }
      }
      i = end < 0 ? pairs.length : end;
    }
  }

  const entities: PlantEntity[] = [];
  const geom = (e: RawEnt, layer: string, tf: (p: PlantPt) => PlantPt, fromBlock: boolean) => {
    if (e.type === 'LINE' && e.pts.length >= 2) entities.push({ layer, pts: e.pts.slice(0, 2).map(tf), closed: false, fromBlock });
    else if ((e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') && e.pts.length >= 2) entities.push({ layer, pts: e.pts.map(tf), closed: e.closed, fromBlock });
    else if (e.type !== 'INSERT') skipped++;
  };
  const explode = (e: RawEnt, tf: (p: PlantPt) => PlantPt, parentLayer: string | null, depth: number) => {
    const layer = parentLayer && e.layer === '0' ? parentLayer : e.layer;
    if (e.type !== 'INSERT') return geom(e, layer, tf, parentLayer !== null);
    const blk = e.block ? blocks.get(e.block) : undefined;
    const ins = e.pts[0] ?? { x: 0, y: 0 };
    const ang = ((e.rot ?? 0) * Math.PI) / 180;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const sx = e.sx ?? 1;
    const sy = e.sy ?? e.sx ?? 1;
    const child = (p: PlantPt): PlantPt => {
      const bx = (p.x - (blk?.base.x ?? 0)) * sx;
      const by = (p.y - (blk?.base.y ?? 0)) * sy;
      return tf({ x: ins.x + bx * c - by * s, y: ins.y + bx * s + by * c });
    };
    entities.push({ layer, pts: [tf(ins)], closed: false, point: true });
    if (blk && depth < 4) for (const b of blk.ents) explode(b, child, layer, depth + 1);
  };
  for (const e of top) explode(e, (p) => p, null, 0);

  const ok = entities.filter((e) => e.pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const e of ok) for (const p of e.pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const ext = Math.max(maxX - minX, maxY - minY);
  let [scale, label] = UNIT_SCALE[insunits] ?? [1, 'sem unidade'];
  const notes: string[] = [];
  if (!(insunits in UNIT_SCALE)) {
    [scale, label] = ext > 2000 ? [0.001, 'mm (estimado)'] : ext > 300 ? [0.01, 'cm (estimado)'] : [1, 'm (estimado)'];
    notes.push('O DXF não informa a unidade; estimei pelo tamanho do desenho. Confira a unidade antes de aplicar.');
  }
  if (skipped) notes.push(`${skipped} entidade(s) de tipo não suportado (arcos, círculos, textos, hachuras) foram ignoradas.`);
  return { source: 'dxf', entities: ok, yUp: true, unitScale: scale, unitLabel: label, needsScale: false, notes };
}

/* ------------------------------------------------------------ geometria */

interface Obb {
  cx: number;
  cz: number;
  len: number;
  wid: number;
  rot: number;
}

/** menor retângulo orientado que envolve os pontos (testa o ângulo de cada aresta) */
export function obb(pts: { x: number; z: number }[]): Obb {
  let best: Obb | null = null;
  let bestArea = Infinity;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const th = Math.atan2(b.z - a.z, b.x - a.x);
    if (!Number.isFinite(th) || (a.x === b.x && a.z === b.z)) continue;
    const c = Math.cos(th);
    const s = Math.sin(th);
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const p of pts) {
      const lx = (p.x - a.x) * c + (p.z - a.z) * s;
      const lz = -(p.x - a.x) * s + (p.z - a.z) * c;
      x0 = Math.min(x0, lx);
      x1 = Math.max(x1, lx);
      z0 = Math.min(z0, lz);
      z1 = Math.max(z1, lz);
    }
    const area = (x1 - x0) * (z1 - z0);
    if (area < bestArea - 1e-9) {
      bestArea = area;
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      const cx = a.x + mx * c - mz * s;
      const cz = a.z + mx * s + mz * c;
      let len = x1 - x0;
      let wid = z1 - z0;
      let rot = (th * 180) / Math.PI;
      if (wid > len) {
        [len, wid] = [wid, len];
        rot += 90;
      }
      rot = ((((rot + 90) % 180) + 180) % 180) - 90; // (−90, 90]
      best = { cx, cz, len, wid, rot };
    }
  }
  if (!best) {
    const x0 = Math.min(...pts.map((p) => p.x));
    const x1 = Math.max(...pts.map((p) => p.x));
    const z0 = Math.min(...pts.map((p) => p.z));
    const z1 = Math.max(...pts.map((p) => p.z));
    return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, len: Math.max(x1 - x0, z1 - z0), wid: Math.min(x1 - x0, z1 - z0), rot: x1 - x0 >= z1 - z0 ? 0 : 90 };
  }
  return best;
}

interface Seg {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
}

/**
 * retângulos montados a partir de segmentos soltos (horizontais/verticais), comuns em CAD (4 LINEs) e em imagens.
 * Devolve os retângulos e os índices dos segmentos consumidos.
 */
export function rectsFromSegments(segs: Seg[], tol: number): { rects: { x0: number; z0: number; x1: number; z1: number }[]; used: Set<number> } {
  const H: { i: number; z: number; x0: number; x1: number }[] = [];
  const V: { i: number; x: number; z0: number; z1: number }[] = [];
  segs.forEach((s, i) => {
    const dx = Math.abs(s.x2 - s.x1);
    const dz = Math.abs(s.z2 - s.z1);
    if (dz <= tol && dx > tol * 2) H.push({ i, z: (s.z1 + s.z2) / 2, x0: Math.min(s.x1, s.x2), x1: Math.max(s.x1, s.x2) });
    else if (dx <= tol && dz > tol * 2) V.push({ i, x: (s.x1 + s.x2) / 2, z0: Math.min(s.z1, s.z2), z1: Math.max(s.z1, s.z2) });
  });
  H.sort((a, b) => a.z - b.z);
  const rects: { x0: number; z0: number; x1: number; z1: number }[] = [];
  const used = new Set<number>();
  for (let a = 0; a < H.length && a < 3000; a++) {
    if (used.has(H[a].i)) continue;
    for (let b = a + 1; b < H.length; b++) {
      const top = H[a];
      const bot = H[b];
      if (used.has(bot.i)) continue;
      if (bot.z - top.z <= tol * 2) continue;
      if (Math.abs(top.x0 - bot.x0) > tol * 2 || Math.abs(top.x1 - bot.x1) > tol * 2) continue;
      const left = V.find((v) => !used.has(v.i) && Math.abs(v.x - Math.min(top.x0, bot.x0)) <= tol * 2 && v.z0 <= top.z + tol * 2 && v.z1 >= bot.z - tol * 2);
      const right = V.find((v) => !used.has(v.i) && v !== left && Math.abs(v.x - Math.max(top.x1, bot.x1)) <= tol * 2 && v.z0 <= top.z + tol * 2 && v.z1 >= bot.z - tol * 2);
      if (left && right) {
        rects.push({ x0: (top.x0 + bot.x0) / 2, x1: (top.x1 + bot.x1) / 2, z0: top.z, z1: bot.z });
        for (const k of [top.i, bot.i, left.i, right.i]) used.add(k);
        break;
      }
    }
  }
  return { rects, used };
}

/* ------------------------------------------------------------ conversão */

export interface ConvertOptions {
  rackLevels: number;
  bayLength: number;
  /** metros por unidade do desenho (sobrepõe doc.unitScale) */
  unitScale?: number;
  margin: number;
}

export const defaultConvertOptions = (): ConvertOptions => ({ rackLevels: 4, bayLength: 2.8, margin: 2 });

export interface ConvertResult {
  elements: LayoutElement[];
  floor: { width: number; depth: number };
  counts: Partial<Record<ElementType, number>>;
  warnings: string[];
}

const DEFAULTS: Record<string, { length: number; width: number }> = {
  dockIn: { length: 3.6, width: 1 }, dockOut: { length: 3.6, width: 1 }, zone: { length: 10, width: 6 }, station: { length: 2.4, width: 1.6 },
  parking: { length: 6, width: 4 }, aisle: { length: 20, width: 3.4 }, transit: { length: 5, width: 2.6 }, stage: { length: 12, width: 4 },
  triage: { length: 8, width: 4 }, charger: { length: 3, width: 2 }, rack: { length: 22.4, width: 2.3 },
};
const NAMES: Record<string, string> = {
  rack: 'Rack', dockIn: 'Doca Entrada', dockOut: 'Doca Saída', zone: 'Zona', station: 'Estação', parking: 'Estacionamento', aisle: 'Rua',
  transit: 'Transitório', stage: 'Stage', triage: 'Triagem', charger: 'Carga AMR', conveyor: 'Esteira', wall: 'Parede',
};
const AREA_TYPES = ['rack', 'zone', 'station', 'parking', 'aisle', 'transit', 'stage', 'triage', 'charger', 'dockIn', 'dockOut'] as const;

/** converte o documento da planta em elementos do layout, segundo o mapeamento camada → tipo */
export function plantToLayout(doc: PlantDoc, mapping: Record<string, PlantType>, opt: Partial<ConvertOptions> = {}): ConvertResult {
  const o = { ...defaultConvertOptions(), ...opt };
  const scale = o.unitScale ?? doc.unitScale;
  const warnings: string[] = [];
  const sel = doc.entities.filter((e) => (mapping[e.layer] ?? 'ignore') !== 'ignore');
  if (!sel.length) return { elements: [], floor: { width: 40, depth: 30 }, counts: {}, warnings: ['Nenhuma camada foi mapeada para um tipo de elemento.'] };

  // coordenadas do plano (m), com origem no canto noroeste do que foi mapeado
  const tf = (p: PlantPt) => ({ x: p.x * scale, z: (doc.yUp ? -p.y : p.y) * scale });
  let minX = Infinity;
  let minZ = Infinity;
  for (const e of sel) for (const p of e.pts) {
    const q = tf(p);
    minX = Math.min(minX, q.x);
    minZ = Math.min(minZ, q.z);
  }
  const sh = (p: PlantPt) => {
    const q = tf(p);
    return { x: q.x - minX + o.margin, z: q.z - minZ + o.margin };
  };

  const els: LayoutElement[] = [];
  const counts: Partial<Record<ElementType, number>> = {};
  const add = (type: ElementType, partial: Partial<LayoutElement>) => {
    counts[type] = (counts[type] ?? 0) + 1;
    const n = counts[type]!;
    const d = DEFAULTS[type];
    const el: LayoutElement = { id: newId(type), type, name: `${NAMES[type]} ${n}`, x: 0, z: 0, rot: 0, length: d?.length ?? 5, width: d?.width ?? 1, ...partial };
    el.x = +el.x.toFixed(3);
    el.z = +el.z.toFixed(3);
    el.rot = +el.rot.toFixed(3);
    el.length = +el.length.toFixed(3);
    el.width = +el.width.toFixed(3);
    els.push(el);
    return el;
  };
  const layersOf = (t: PlantType) => sel.filter((e) => mapping[e.layer] === t);

  // paredes
  const wallPts: { a: { x: number; z: number }; b: { x: number; z: number } }[] = [];
  for (const e of layersOf('wall')) {
    if (e.point) continue;
    const pts = e.pts.map(sh);
    const segs: [typeof pts[0], typeof pts[0]][] = [];
    for (let k = 1; k < pts.length; k++) segs.push([pts[k - 1], pts[k]]);
    if (e.closed && pts.length > 2) segs.push([pts[pts.length - 1], pts[0]]);
    for (const [a, b] of segs) {
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.2 || els.length > 6000) continue;
      add('wall', { name: 'Parede (planta)', x: a.x, z: a.z, rot: (Math.atan2(b.z - a.z, b.x - a.x) * 180) / Math.PI, length: len, width: 0.25 });
      wallPts.push({ a, b });
    }
  }

  // esteiras
  for (const e of layersOf('conveyor')) {
    if (e.point || e.pts.length < 2) continue;
    const pts = e.pts.map(sh);
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1) continue;
      add('conveyor', { x: a.x, z: a.z, rot: (Math.atan2(b.z - a.z, b.x - a.x) * 180) / Math.PI, length: len, width: 0.8, speed: 0.6 });
    }
  }

  // áreas e racks
  const dockNormals = new Map<string, { nx: number; nz: number }>();
  const aislePending: LayoutElement[] = [];
  for (const type of AREA_TYPES) {
    const layers = layersOf(type);
    if (!layers.length) continue;
    const polys: { x: number; z: number }[][] = [];
    const openSegs: Seg[] = [];
    const points: { x: number; z: number }[] = [];
    for (const e of layers) {
      const pts = e.pts.map(sh);
      if (e.point) points.push(pts[0]);
      else if (e.closed && pts.length >= 3) polys.push(pts);
      else if (!e.fromBlock || type !== 'dockIn') for (let k = 1; k < pts.length; k++) openSegs.push({ x1: pts[k - 1].x, z1: pts[k - 1].z, x2: pts[k].x, z2: pts[k].z });
    }
    // retângulos montados a partir de linhas soltas
    const { rects, used } = rectsFromSegments(openSegs, 0.15);
    for (const r of rects) polys.push([{ x: r.x0, z: r.z0 }, { x: r.x1, z: r.z0 }, { x: r.x1, z: r.z1 }, { x: r.x0, z: r.z1 }]);
    const place = (b: Obb) => {
      const base = { x: b.cx, z: b.cz, rot: b.rot, length: Math.max(0.5, b.len), width: Math.max(0.3, b.wid) };
      if (type === 'rack') {
        const bays = Math.max(1, Math.round(base.length / o.bayLength));
        add('rack', { ...base, bays, levels: o.rackLevels, rows: base.width > 1.6 ? 2 : 1, pickFace: false });
      } else if (type === 'dockIn' || type === 'dockOut') pendingDocks.push({ type, c: { x: b.cx, z: b.cz }, len: b.len, wid: b.wid });
      else {
        const el = add(type, base);
        if (type === 'aisle') aislePending.push(el);
        if (type === 'triage') el.priority = counts.triage;
      }
    };
    const pendingDocks: { type: 'dockIn' | 'dockOut'; c: { x: number; z: number }; len: number; wid: number }[] = [];
    for (const poly of polys) place(obb(poly));
    // linhas restantes: rack (eixo = linha, profundidade padrão) e rua (eixo = linha, largura padrão)
    if (type === 'rack' || type === 'aisle') {
      openSegs.forEach((s, i) => {
        if (used.has(i)) return;
        const len = Math.hypot(s.x2 - s.x1, s.z2 - s.z1);
        if (len < 1.5) return;
        place({ cx: (s.x1 + s.x2) / 2, cz: (s.z1 + s.z2) / 2, len, wid: DEFAULTS[type].width, rot: (Math.atan2(s.z2 - s.z1, s.x2 - s.x1) * 180) / Math.PI });
      });
    } else if (openSegs.length - used.size > 0 && !points.length && !polys.length) {
      warnings.push(`A camada de "${PLANT_TYPE_LABEL[type]}" só tem linhas abertas que não formam retângulo; nada foi criado para ela.`);
    }
    for (const p of points) {
      if (type === 'rack') continue;
      if (type === 'dockIn' || type === 'dockOut') pendingDocks.push({ type, c: p, len: DEFAULTS[type].length, wid: DEFAULTS[type].width });
      else {
        const el = add(type, { x: p.x, z: p.z });
        if (type === 'aisle') aislePending.push(el);
      }
    }
    // docas: encaixam na parede mais próxima, com a abertura voltada para fora do galpão
    for (const d of pendingDocks) {
      let best: { a: { x: number; z: number }; b: { x: number; z: number }; t: number; dist: number } | null = null;
      for (const w of wallPts) {
        const dx = w.b.x - w.a.x;
        const dz = w.b.z - w.a.z;
        const L2 = dx * dx + dz * dz;
        if (L2 < 1e-9) continue;
        const t = Math.min(1, Math.max(0, ((d.c.x - w.a.x) * dx + (d.c.z - w.a.z) * dz) / L2));
        const dist = Math.hypot(w.a.x + t * dx - d.c.x, w.a.z + t * dz - d.c.z);
        if (!best || dist < best.dist) best = { ...w, t, dist };
      }
      const dockLen = Math.min(6, Math.max(2.4, d.len > d.wid * 1.5 ? d.len : DEFAULTS.dockIn.length));
      if (best && best.dist < 8) {
        const wrot = (Math.atan2(best.b.z - best.a.z, best.b.x - best.a.x) * 180) / Math.PI;
        const px = best.a.x + best.t * (best.b.x - best.a.x);
        const pz = best.a.z + best.t * (best.b.z - best.a.z);
        // normal local +Z da parede = (−sin, cos); "fora" = lado oposto ao centro do galpão
        const nx = -Math.sin((wrot * Math.PI) / 180);
        const nz = Math.cos((wrot * Math.PI) / 180);
        const dock = add(d.type, { x: px, z: pz, rot: wrot, length: dockLen, width: 1 });
        dockNormals.set(dock.id, { nx, nz });
      } else add(d.type, { x: d.c.x, z: d.c.z, rot: 0, length: dockLen, width: 1 });
    }
  }

  // ruas: código A, B, C… do norte para o sul
  aislePending.sort((a, b) => a.z - b.z || a.x - b.x).forEach((a, i) => {
    a.aisle = aisleCode(i);
    a.name = `Rua ${a.aisle}`;
  });

  // piso e orientação das docas (com o centro do galpão conhecido)
  let maxX = 0;
  let maxZ = 0;
  for (const e of els) {
    const pts = e.type === 'wall' || e.type === 'conveyor'
      ? [{ x: e.x, z: e.z }, { x: e.x + Math.cos((e.rot * Math.PI) / 180) * e.length, z: e.z + Math.sin((e.rot * Math.PI) / 180) * e.length }]
      : [-1, 1].flatMap((sx) => [-1, 1].map((sz) => ({
        x: e.x + (sx * e.length) / 2 * Math.cos((e.rot * Math.PI) / 180) - (sz * e.width) / 2 * Math.sin((e.rot * Math.PI) / 180),
        z: e.z + (sx * e.length) / 2 * Math.sin((e.rot * Math.PI) / 180) + (sz * e.width) / 2 * Math.cos((e.rot * Math.PI) / 180),
      })));
    for (const p of pts) {
      maxX = Math.max(maxX, p.x);
      maxZ = Math.max(maxZ, p.z);
    }
  }
  const floor = { width: Math.ceil(maxX + o.margin), depth: Math.ceil(maxZ + o.margin) };
  const center = { x: floor.width / 2, z: floor.depth / 2 };
  for (const e of els) {
    const n = dockNormals.get(e.id);
    if (!n) continue;
    const outward = n.nx * (e.x - center.x) + n.nz * (e.z - center.z) > 0;
    if (!outward) e.rot = +((((e.rot + 180) % 360) + 360) % 360).toFixed(3);
  }
  const nWalls = counts.wall ?? 0;
  if (!nWalls && (counts.dockIn || counts.dockOut)) warnings.push('Docas criadas sem paredes mapeadas: a orientação delas ficou padrão (rot 0°).');
  return { elements: els, floor, counts, warnings };
}

/** layout completo (substituindo ou somando ao existente) */
export function mergeLayout(base: Layout, res: ConvertResult, replace: boolean): Layout {
  if (replace) return { name: 'Layout importado da planta', floor: res.floor, elements: res.elements };
  return { ...base, floor: { width: Math.max(base.floor.width, res.floor.width), depth: Math.max(base.floor.depth, res.floor.depth) }, elements: [...base.elements, ...res.elements] };
}
