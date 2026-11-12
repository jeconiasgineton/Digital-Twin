import { rectsFromSegments, type PlantDoc, type PlantEntity } from './plant';

/** imagem em escala de pixels (compatível com ImageData) */
export interface RasterImage {
  data: Uint8ClampedArray | number[];
  width: number;
  height: number;
}

export const LAYER_LINES = 'Linhas horizontais e verticais (parede)';
export const LAYER_BLOCKS = 'Blocos preenchidos (rack)';
export const LAYER_RECTS = 'Retângulos de contorno (zona)';

interface Band {
  a0: number; // linha(s) / coluna(s) inicial/final (eixo "primário")
  a1: number;
  b0: number; // extensão ao longo do eixo "secundário"
  b1: number;
  last: number;
}

/** limiar de Otsu para uma imagem em tons de cinza (0–255) */
export function otsu(gray: Uint8Array): number {
  const hist = new Array(256).fill(0);
  for (const g of gray) hist[g]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0;
  let wB = 0;
  let best = 0;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB;
    const mF = (sum - sB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > best) {
      best = v;
      thr = t;
    }
  }
  return thr;
}

/** faixas contínuas de pixels escuros: varre linha a linha (horizontal) ou coluna a coluna (vertical) */
function bands(mask: Uint8Array, W: number, H: number, horizontal: boolean, minLen: number, gapTol = 2): Band[] {
  const nA = horizontal ? H : W;
  const nB = horizontal ? W : H;
  const at = (a: number, b: number) => (horizontal ? mask[a * W + b] : mask[b * W + a]);
  const done: Band[] = [];
  let active: Band[] = [];
  for (let a = 0; a < nA; a++) {
    // runs da linha `a`, unindo vãos pequenos
    const runs: [number, number][] = [];
    let b = 0;
    while (b < nB) {
      if (!at(a, b)) {
        b++;
        continue;
      }
      const s = b;
      let e = b;
      while (b < nB) {
        if (at(a, b)) {
          e = b;
          b++;
        } else {
          let g = 0;
          while (b + g < nB && !at(a, b + g) && g <= gapTol) g++;
          if (g > gapTol || b + g >= nB) break;
          b += g;
        }
      }
      if (e - s + 1 >= minLen) runs.push([s, e]);
    }
    const next: Band[] = [];
    for (const [s, e] of runs) {
      const len = e - s + 1;
      const hit = active.find((bd) => {
        if (bd.last !== a - 1) return false;
        const ov = Math.min(e, bd.b1) - Math.max(s, bd.b0) + 1;
        return ov >= 0.8 * Math.min(len, bd.b1 - bd.b0 + 1);
      });
      if (hit) {
        hit.a1 = a;
        hit.last = a;
        hit.b0 = Math.min(hit.b0, s);
        hit.b1 = Math.max(hit.b1, e);
        next.push(hit);
      } else next.push({ a0: a, a1: a, b0: s, b1: e, last: a });
    }
    for (const bd of active) if (!next.includes(bd)) done.push(bd);
    active = next;
  }
  return [...done, ...active];
}

export interface RasterOptions {
  /** espessura (px) a partir da qual uma faixa é um bloco preenchido; padrão ≈ 0,8% da maior dimensão */
  thickPx?: number;
  /** comprimento mínimo (px) de uma linha; padrão ≈ 2% da maior dimensão */
  minLenPx?: number;
}

/**
 * Reconhece, numa imagem de planta (linhas escuras sobre fundo claro), linhas horizontais/verticais,
 * blocos preenchidos e retângulos de contorno. É um reconhecimento local e aproximado: o usuário revisa o mapeamento.
 */
export function rasterToPlant(img: RasterImage, opt: RasterOptions = {}): PlantDoc {
  const { width: W, height: H } = img;
  const d = img.data;
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const a = (d[i * 4 + 3] ?? 255) / 255;
    // composição sobre fundo branco (PNG transparente)
    const r = d[i * 4] * a + 255 * (1 - a);
    const g = d[i * 4 + 1] * a + 255 * (1 - a);
    const b = d[i * 4 + 2] * a + 255 * (1 - a);
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  const thr = otsu(gray);
  let dark = 0;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    mask[i] = gray[i] <= thr ? 1 : 0;
    dark += mask[i];
  }
  const notes: string[] = [];
  if (dark > 0.5 * W * H) {
    for (let i = 0; i < W * H; i++) mask[i] = 1 - mask[i]; // linhas claras sobre fundo escuro
    notes.push('Imagem com fundo escuro: inverti as cores para reconhecer as linhas.');
  }
  const big = Math.max(W, H);
  const minLen = opt.minLenPx ?? Math.max(10, Math.round(0.02 * big));
  const thick = opt.thickPx ?? Math.max(6, Math.round(0.008 * big));

  const blocks: PlantEntity[] = [];
  const segs: { x1: number; z1: number; x2: number; z2: number }[] = [];
  const addBlock = (x0: number, y0: number, x1: number, y1: number) =>
    blocks.push({ layer: LAYER_BLOCKS, closed: true, pts: [{ x: x0, y: y0 }, { x: x1 + 1, y: y0 }, { x: x1 + 1, y: y1 + 1 }, { x: x0, y: y1 + 1 }] });

  // 1) horizontais: faixas grossas viram blocos (e são apagadas para não reaparecerem na passada vertical)
  const hb = bands(mask, W, H, true, minLen);
  for (const b of hb) {
    const t = b.a1 - b.a0 + 1;
    if (t >= thick) {
      addBlock(b.b0, b.a0, b.b1, b.a1);
      for (let y = b.a0; y <= b.a1; y++) for (let x = b.b0; x <= b.b1; x++) mask[y * W + x] = 0;
    }
  }
  for (const b of hb) {
    const t = b.a1 - b.a0 + 1;
    if (t < thick) {
      const y = (b.a0 + b.a1) / 2 + 0.5;
      segs.push({ x1: b.b0, z1: y, x2: b.b1 + 1, z2: y });
    }
  }
  // 2) verticais
  const vb = bands(mask, W, H, false, minLen);
  for (const b of vb) {
    const t = b.a1 - b.a0 + 1;
    if (t >= thick) addBlock(b.a0, b.b0, b.a1, b.b1);
    else {
      const x = (b.a0 + b.a1) / 2 + 0.5;
      segs.push({ x1: x, z1: b.b0, x2: x, z2: b.b1 + 1 });
    }
  }

  // 3) retângulos de contorno a partir das linhas; retângulos enormes (a própria planta) continuam sendo paredes
  const tol = Math.max(3, Math.round(thick / 2));
  const { rects, used } = rectsFromSegments(segs, tol);
  const entities: PlantEntity[] = [...blocks];
  const releaseAll = new Set<number>();
  const rectIdx: number[][] = [];
  // associa cada retângulo aos seus 4 segmentos (para devolver as linhas dos retângulos gigantes)
  for (const r of rects) {
    const mine: number[] = [];
    segs.forEach((s, i) => {
      if (!used.has(i)) return;
      const onH = Math.abs(s.z1 - s.z2) <= tol && (Math.abs(s.z1 - r.z0) <= tol * 2 || Math.abs(s.z1 - r.z1) <= tol * 2) && s.x1 >= r.x0 - tol * 2 && s.x2 <= r.x1 + tol * 2;
      const onV = Math.abs(s.x1 - s.x2) <= tol && (Math.abs(s.x1 - r.x0) <= tol * 2 || Math.abs(s.x1 - r.x1) <= tol * 2) && s.z1 >= r.z0 - tol * 2 && s.z2 <= r.z1 + tol * 2;
      if (onH || onV) mine.push(i);
    });
    rectIdx.push(mine);
  }
  rects.forEach((r, k) => {
    const area = (r.x1 - r.x0) * (r.z1 - r.z0);
    if (area > 0.4 * W * H) {
      for (const i of rectIdx[k]) releaseAll.add(i); // contorno da planta: fica como linhas
      return;
    }
    entities.push({ layer: LAYER_RECTS, closed: true, pts: [{ x: r.x0, y: r.z0 }, { x: r.x1, y: r.z0 }, { x: r.x1, y: r.z1 }, { x: r.x0, y: r.z1 }] });
    for (const i of rectIdx[k]) used.add(i);
  });
  for (const i of releaseAll) used.delete(i);
  let nLines = 0;
  segs.forEach((s, i) => {
    if (used.has(i) || nLines > 3000) return;
    nLines++;
    entities.push({ layer: LAYER_LINES, closed: false, pts: [{ x: s.x1, y: s.z1 }, { x: s.x2, y: s.z2 }] });
  });
  if (!entities.length) notes.push('Não reconheci linhas na imagem. Use uma planta com linhas escuras sobre fundo claro e boa resolução.');
  notes.push('Reconhecimento local e aproximado: só linhas horizontais/verticais. Revise o resultado e ajuste no editor.');
  return { source: 'image', entities, yUp: false, unitScale: 1, unitLabel: 'pixels', needsScale: true, notes };
}

/** menor/maior extensão (no sistema do desenho) das entidades: para calibrar a escala pela largura real */
export function plantExtent(doc: PlantDoc, layers?: Set<string>): { w: number; h: number } {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const e of doc.entities) {
    if (layers && !layers.has(e.layer)) continue;
    for (const p of e.pts) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
  }
  return Number.isFinite(x0) ? { w: x1 - x0, h: y1 - y0 } : { w: 0, h: 0 };
}
