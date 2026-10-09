import type { LayoutElement } from '../model/types';
import { newId } from '../model/layoutGen';

export interface DxfResult {
  walls: LayoutElement[];
  unitsDetected: string;
  scale: number;
  bounds: { w: number; d: number };
  segments: number;
}

interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const UNIT_SCALE: Record<number, [number, string]> = {
  0: [1, 'sem unidade'], 1: [0.0254, 'polegadas'], 2: [0.3048, 'pés'], 4: [0.001, 'mm'], 5: [0.01, 'cm'], 6: [1, 'm'], 14: [0.1, 'dm'],
};

/** Parser ASCII de DXF (LINE, LWPOLYLINE, POLYLINE/VERTEX) → paredes. Eixo Y do CAD vira -Z. */
export function parseDxf(text: string, scaleOverride?: number): DxfResult {
  const lines = text.split(/\r?\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  let insunits = 0;
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS') {
      for (let j = i + 1; j < Math.min(i + 6, pairs.length); j++) if (pairs[j][0] === 70) { insunits = parseInt(pairs[j][1], 10); break; }
    }
  }
  const segs: Seg[] = [];
  let i = 0;
  const n = pairs.length;
  const addPoly = (pts: [number, number][], closed: boolean) => {
    for (let k = 1; k < pts.length; k++) segs.push({ x1: pts[k - 1][0], y1: pts[k - 1][1], x2: pts[k][0], y2: pts[k][1] });
    if (closed && pts.length > 2) segs.push({ x1: pts[pts.length - 1][0], y1: pts[pts.length - 1][1], x2: pts[0][0], y2: pts[0][1] });
  };
  while (i < n) {
    const [c, v] = pairs[i];
    if (c !== 0) {
      i++;
      continue;
    }
    if (v === 'LINE') {
      const s: Seg = { x1: 0, y1: 0, x2: 0, y2: 0 };
      i++;
      while (i < n && pairs[i][0] !== 0) {
        const [code, val] = pairs[i];
        if (code === 10) s.x1 = parseFloat(val);
        else if (code === 20) s.y1 = parseFloat(val);
        else if (code === 11) s.x2 = parseFloat(val);
        else if (code === 21) s.y2 = parseFloat(val);
        i++;
      }
      segs.push(s);
    } else if (v === 'LWPOLYLINE') {
      const pts: [number, number][] = [];
      let closed = false;
      i++;
      while (i < n && pairs[i][0] !== 0) {
        const [code, val] = pairs[i];
        if (code === 70) closed = (parseInt(val, 10) & 1) === 1;
        else if (code === 10) pts.push([parseFloat(val), 0]);
        else if (code === 20 && pts.length) pts[pts.length - 1][1] = parseFloat(val);
        i++;
      }
      addPoly(pts, closed);
    } else if (v === 'POLYLINE') {
      const pts: [number, number][] = [];
      let closed = false;
      i++;
      while (i < n && pairs[i][0] !== 0) {
        if (pairs[i][0] === 70) closed = (parseInt(pairs[i][1], 10) & 1) === 1;
        i++;
      }
      while (i < n && pairs[i][1] !== 'SEQEND') {
        if (pairs[i][0] === 0 && pairs[i][1] === 'VERTEX') {
          let x = 0;
          let y = 0;
          i++;
          while (i < n && pairs[i][0] !== 0) {
            if (pairs[i][0] === 10) x = parseFloat(pairs[i][1]);
            if (pairs[i][0] === 20) y = parseFloat(pairs[i][1]);
            i++;
          }
          pts.push([x, y]);
        } else i++;
      }
      addPoly(pts, closed);
    } else i++;
  }
  const valid = segs.filter((s) => [s.x1, s.y1, s.x2, s.y2].every(Number.isFinite));
  if (!valid.length) return { walls: [], unitsDetected: '—', scale: 1, bounds: { w: 0, d: 0 }, segments: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of valid) {
    minX = Math.min(minX, s.x1, s.x2);
    maxX = Math.max(maxX, s.x1, s.x2);
    minY = Math.min(minY, s.y1, s.y2);
    maxY = Math.max(maxY, s.y1, s.y2);
  }
  let [scale, unitsDetected] = UNIT_SCALE[insunits] ?? [1, 'm'];
  if (insunits === 0 || !(insunits in UNIT_SCALE)) {
    // heurística: desenhos grandes sem unidade geralmente estão em mm
    const ext = Math.max(maxX - minX, maxY - minY);
    if (ext > 2000) [scale, unitsDetected] = [0.001, 'mm (estimado)'];
    else if (ext > 300) [scale, unitsDetected] = [0.01, 'cm (estimado)'];
    else [scale, unitsDetected] = [1, 'm (estimado)'];
  }
  if (scaleOverride) scale = scaleOverride;
  const walls: LayoutElement[] = [];
  for (const s of valid) {
    const x1 = (s.x1 - minX) * scale;
    const z1 = (maxY - s.y1) * scale;
    const x2 = (s.x2 - minX) * scale;
    const z2 = (maxY - s.y2) * scale;
    const len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 0.2) continue;
    walls.push({
      id: newId('wall'), type: 'wall', name: 'Parede (DXF)', x: +x1.toFixed(3), z: +z1.toFixed(3),
      rot: +((Math.atan2(z2 - z1, x2 - x1) * 180) / Math.PI).toFixed(3), length: +len.toFixed(3), width: 0.25,
    });
    if (walls.length >= 4000) break;
  }
  return { walls, unitsDetected, scale, bounds: { w: (maxX - minX) * scale, d: (maxY - minY) * scale }, segments: valid.length };
}
