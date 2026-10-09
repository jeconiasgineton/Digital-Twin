import type { Layout, LayoutElement } from './types';

export interface LayoutParams {
  docksIn: number;
  docksOut: number;
  rackRows: number; // nº de fileiras de racks (cada uma dupla)
  baysPerRow: number;
  levels: number;
  conveyors: number;
  stations: number;
  bayLength?: number;
}

export const defaultLayoutParams = (): LayoutParams => ({ docksIn: 3, docksOut: 3, rackRows: 8, baysPerRow: 30, levels: 5, conveyors: 1, stations: 2 });

let seq = 0;
export const newId = (p = 'el') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Gera um galpão paramétrico: docas de entrada ao norte, saída ao sul, racks no centro, esteira e estações na expedição. */
export function generateLayout(p: LayoutParams): Layout {
  const bayLen = p.bayLength ?? 2.8;
  const cols = p.baysPerRow > 14 ? 2 : 1;
  const baysPerCol = Math.ceil(p.baysPerRow / cols);
  const crossAisle = cols === 2 ? 4 : 0;
  const rackLen = baysPerCol * bayLen;
  const rackDepth = 2.3;
  const aisle = 3.4;
  const margin = 5;
  const W = Math.max(40, cols * rackLen + crossAisle + 2 * margin);
  const rackBlock = p.rackRows * rackDepth + (p.rackRows + 1) * aisle;
  const zoneN = 16;
  const zoneS = 18;
  const D = zoneN + rackBlock + zoneS;
  const els: LayoutElement[] = [];
  const add = (e: Omit<LayoutElement, 'id'>) => els.push({ id: newId(e.type), ...e });

  // paredes (com vãos para docas)
  const dockW = 3.6;
  const dockPitch = 5.2;
  const wallLine = (z: number, docks: number, name: string) => {
    const gaps: number[] = [];
    const total = docks * dockPitch;
    for (let i = 0; i < docks; i++) gaps.push(W / 2 - total / 2 + dockPitch * (i + 0.5));
    let x = 0;
    for (const g of gaps) {
      const x1 = g - dockW / 2;
      if (x1 - x > 0.1) add({ type: 'wall', name, x, z, rot: 0, length: x1 - x, width: 0.3 });
      x = g + dockW / 2;
    }
    if (W - x > 0.1) add({ type: 'wall', name, x, z, rot: 0, length: W - x, width: 0.3 });
    return gaps;
  };
  const gIn = wallLine(0, p.docksIn, 'Parede norte');
  const gOut = wallLine(D, p.docksOut, 'Parede sul');
  add({ type: 'wall', name: 'Parede oeste', x: 0, z: 0, rot: 90, length: D, width: 0.3 });
  add({ type: 'wall', name: 'Parede leste', x: W, z: 0, rot: 90, length: D, width: 0.3 });

  // docas: rot 180 => abre para o norte (fora); rot 0 => abre para o sul
  gIn.forEach((x, i) => add({ type: 'dockIn', name: `Doca Entrada ${i + 1}`, x, z: 0, rot: 180, length: dockW, width: 1 }));
  gOut.forEach((x, i) => add({ type: 'dockOut', name: `Doca Saída ${i + 1}`, x, z: D, rot: 0, length: dockW, width: 1 }));

  // racks
  for (let r = 0; r < p.rackRows; r++) {
    const z = zoneN + aisle + r * (rackDepth + aisle) + rackDepth / 2;
    for (let c = 0; c < cols; c++) {
      const x0 = W / 2 - (cols * rackLen + crossAisle) / 2 + c * (rackLen + crossAisle) + rackLen / 2;
      add({
        type: 'rack', name: `Rack ${r + 1}${cols > 1 ? (c ? 'B' : 'A') : ''}`, x: x0, z, rot: 0, length: rackLen, width: rackDepth,
        bays: baysPerCol, levels: p.levels, rows: 2, pickFace: r >= p.rackRows - Math.max(1, Math.round(p.rackRows / 3)),
      });
    }
  }
  // zonas
  add({ type: 'zone', name: 'Conferência/Staging entrada', x: W / 2, z: 8.5, rot: 0, length: Math.min(W - 10, p.docksIn * dockPitch + 4), width: 5 });
  add({ type: 'zone', name: 'Staging expedição', x: W / 2, z: D - 8.5, rot: 0, length: Math.min(W - 10, p.docksOut * dockPitch + 4), width: 5 });
  add({ type: 'parking', name: 'Estacionamento de empilhadeiras', x: 6, z: 6, rot: 0, length: 6, width: 4 });

  // esteiras e estações na área sul (entre racks e docas de saída)
  for (let i = 0; i < p.conveyors; i++) {
    const z = D - zoneS + 3 + i * 2.2;
    add({ type: 'conveyor', name: `Esteira ${i + 1}`, x: margin + 2, z, rot: 0, length: W - 2 * margin - 4, width: 0.8, speed: 0.6 });
  }
  for (let i = 0; i < p.stations; i++) {
    add({ type: 'station', name: `Estação de expedição ${i + 1}`, x: W - margin - 6 - i * 3.2, z: D - zoneS + 3 + Math.max(0, p.conveyors - 1) * 1.1 + 3.2, rot: 0, length: 2.4, width: 1.6 });
  }
  return { name: 'Galpão gerado', floor: { width: W, depth: D }, elements: els };
}
