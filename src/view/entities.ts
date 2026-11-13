import * as THREE from 'three';
import type { LayoutElement } from '../model/types';

/** Fábrica de malhas 3D das entidades logísticas. Convenção: elemento centrado; comprimento em X local, profundidade em Z local. */

const mat = (color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.1, ...opts });

export const M = {
  floor: mat(0xb9bec6, { roughness: 0.95 }),
  upright: mat(0x1f55a4, { metalness: 0.3 }),
  beam: mat(0xe8741a, { metalness: 0.3 }),
  pallet: mat(0x9b6b3a),
  carton: [mat(0xc89b5e), mat(0xd7ad70), mat(0xb88a52), mat(0xe0c08a)],
  wall: mat(0xe6e8ec, { transparent: true, opacity: 0.45, depthWrite: false }),
  wallTop: mat(0x8d94a0),
  dockIn: mat(0x2e9e5b),
  dockOut: mat(0xe6892b),
  steel: mat(0x6b7280, { metalness: 0.6, roughness: 0.4 }),
  dark: mat(0x23262d),
  belt: mat(0x3a3f48, { roughness: 0.9 }),
  rollers: mat(0x9aa3b2, { metalness: 0.7 }),
  yellow: mat(0xf2c100),
  orange: mat(0xff7a00),
  vest: mat(0xff9f1a, { emissive: 0x442200 }),
  skin: mat(0xf1c9a5),
  helmet: mat(0xfff03a),
  pants: mat(0x2c3e66),
  truckIn: mat(0xf4f4f4),
  truckOut: mat(0xf7f3e8),
  cabIn: mat(0x2e9e5b),
  cabOut: mat(0xd2691e),
  tire: mat(0x15171c),
  glass: mat(0x8fc7ff, { transparent: true, opacity: 0.6 }),
  station: mat(0x5a8f7b),
  zoneStaging: new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.22, depthWrite: false }),
  zoneGeneric: new THREE.MeshBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.28, depthWrite: false }),
  parking: new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.35, depthWrite: false }),
  aisle: new THREE.MeshBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.16, depthWrite: false }),
  transit: new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.45, depthWrite: false }),
  stage: new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.3, depthWrite: false }),
  triage: new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.3, depthWrite: false }),
  charger: new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.4, depthWrite: false }),
  selected: new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.25, depthWrite: false }),
};

const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 16);

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(BOX, m);
  mesh.scale.set(w, h, d);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

function cyl(r: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0, rotZ = false): THREE.Mesh {
  const mesh = new THREE.Mesh(CYL, m);
  mesh.scale.set(r, h, r);
  mesh.position.set(x, y, z);
  if (rotZ) mesh.rotation.x = Math.PI / 2;
  return mesh;
}

/** PRNG determinístico a partir de string (para variação visual estável) */
export function hash01(s: string, i = 0): number {
  let h = 2166136261 ^ i;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export interface RackVis {
  group: THREE.Group;
  loads: THREE.InstancedMesh;
  capacity: number;
  setStock(n: number): void;
}

export function buildRack(el: LayoutElement, levelHeight: number): RackVis {
  const g = new THREE.Group();
  const bays = Math.max(1, el.bays ?? 8);
  const levels = Math.max(1, el.levels ?? 4);
  const rows = Math.max(1, el.rows ?? (el.width > 1.6 ? 2 : 1));
  const L = el.length;
  const rowD = el.width / rows;
  const bayL = L / bays;
  const H = levels * levelHeight + 0.35;

  // montantes
  const postGeo = new THREE.BoxGeometry(0.1, H, 0.1);
  const nPosts = (bays + 1) * rows * 2;
  const posts = new THREE.InstancedMesh(postGeo, M.upright, nPosts);
  let pi = 0;
  const m4 = new THREE.Matrix4();
  for (let r = 0; r < rows; r++) {
    const zc = -el.width / 2 + rowD * (r + 0.5);
    for (let b = 0; b <= bays; b++) {
      for (const dz of [-rowD / 2 + 0.05, rowD / 2 - 0.05]) {
        m4.makeTranslation(-L / 2 + b * bayL, H / 2, zc + dz);
        posts.setMatrixAt(pi++, m4);
      }
    }
  }
  g.add(posts);

  // longarinas
  const beamGeo = new THREE.BoxGeometry(bayL, 0.12, 0.07);
  const nBeams = bays * levels * rows * 2;
  const beams = new THREE.InstancedMesh(beamGeo, M.beam, nBeams);
  let bi = 0;
  for (let r = 0; r < rows; r++) {
    const zc = -el.width / 2 + rowD * (r + 0.5);
    for (let k = 0; k < levels; k++) {
      for (let b = 0; b < bays; b++) {
        for (const dz of [-rowD / 2 + 0.05, rowD / 2 - 0.05]) {
          m4.makeTranslation(-L / 2 + (b + 0.5) * bayL, 0.25 + k * levelHeight, zc + dz);
          beams.setMatrixAt(bi++, m4);
        }
      }
    }
  }
  g.add(beams);

  // cargas (paletes) – ordem permutada para que `count` mostre uma fração aleatória
  const capacity = bays * levels * rows;
  const slots: THREE.Matrix4[] = [];
  const colors: number[] = [];
  const loadH = levelHeight - 0.4;
  for (let r = 0; r < rows; r++) {
    const zc = -el.width / 2 + rowD * (r + 0.5);
    for (let k = 0; k < levels; k++) {
      for (let b = 0; b < bays; b++) {
        const mm = new THREE.Matrix4();
        const hh = loadH * (0.7 + 0.3 * hash01(el.id, slots.length));
        mm.compose(
          new THREE.Vector3(-L / 2 + (b + 0.5) * bayL, 0.31 + hh / 2 + 0.14, zc),
          new THREE.Quaternion(),
          new THREE.Vector3(Math.min(bayL - 0.3, 1.2), hh, Math.min(rowD - 0.25, 1.0)),
        );
        slots.push(mm);
        colors.push(Math.floor(hash01(el.id, slots.length + 7) * 4));
      }
    }
  }
  const order = slots.map((_, i) => i).sort((a, b) => hash01(el.id, a + 99) - hash01(el.id, b + 99));
  const loads = new THREE.InstancedMesh(BOX, M.carton[0], capacity);
  const palc = [0xc89b5e, 0xd7ad70, 0xb88a52, 0xe0c08a, 0xa3b8c9, 0xcfd6dd];
  order.forEach((si, i) => {
    loads.setMatrixAt(i, slots[si]);
    loads.setColorAt(i, new THREE.Color(palc[colors[si] % palc.length]));
  });
  loads.instanceColor!.needsUpdate = true;
  loads.instanceMatrix.needsUpdate = true;
  loads.count = 0;
  g.add(loads);

  // base dos paletes (madeira) – instanciado junto às cargas
  const base = new THREE.InstancedMesh(BOX, M.pallet, capacity);
  order.forEach((si, i) => {
    const mm = new THREE.Matrix4().copy(slots[si]);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    mm.decompose(p, q, s);
    const mb = new THREE.Matrix4().compose(new THREE.Vector3(p.x, 0.31 + 0.07, p.z), q, new THREE.Vector3(s.x, 0.14, s.z));
    base.setMatrixAt(i, mb);
  });
  base.count = 0;
  g.add(base);

  const setStock = (n: number) => {
    const c = Math.max(0, Math.min(capacity, Math.round(n)));
    loads.count = c;
    base.count = c;
  };
  return { group: g, loads, capacity, setStock };
}

export function buildWall(el: LayoutElement, opacity = 0.45): THREE.Group {
  const g = new THREE.Group();
  const h = 5;
  const t = Math.max(0.2, el.width);
  const body = new THREE.Mesh(BOX, M.wall.clone());
  (body.material as THREE.MeshStandardMaterial).opacity = opacity;
  body.scale.set(el.length, h, t);
  body.position.set(el.length / 2, h / 2, 0);
  body.userData.isWall = true;
  g.add(body);
  g.add(box(el.length, 0.12, t + 0.05, M.wallTop, el.length / 2, h, 0));
  return g;
}

export function buildDock(el: LayoutElement, kind: 'in' | 'out'): THREE.Group {
  const g = new THREE.Group();
  const col = kind === 'in' ? M.dockIn : M.dockOut;
  const w = el.length;
  g.add(box(0.25, 4.6, 0.5, M.steel, -w / 2 - 0.12, 0, 0));
  g.add(box(0.25, 4.6, 0.5, M.steel, w / 2 + 0.12, 0, 0));
  g.add(box(w + 0.6, 0.5, 0.5, col, 0, 4.2, 0));
  // niveladora e para-choques
  const lev = box(w - 0.2, 0.12, 2.0, M.steel, 0, 1.15, -1.0);
  lev.rotation.x = 0.04;
  g.add(lev);
  g.add(box(0.3, 0.5, 0.3, M.dark, -w / 2 + 0.2, 1.0, 0.25));
  g.add(box(0.3, 0.5, 0.3, M.dark, w / 2 - 0.2, 1.0, 0.25));
  // piso sinalizado na área de trabalho interna
  const mark = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.6, 3.4), kind === 'in' ? new THREE.MeshBasicMaterial({ color: 0x2e9e5b, transparent: true, opacity: 0.25 }) : new THREE.MeshBasicMaterial({ color: 0xe6892b, transparent: true, opacity: 0.25 }));
  mark.rotation.x = -Math.PI / 2;
  mark.position.set(0, 0.03, -1.9);
  g.add(mark);
  return g;
}

export function buildConveyor(el: LayoutElement): { group: THREE.Group; cartons: THREE.InstancedMesh; length: number; speed: number } {
  const g = new THREE.Group();
  const L = el.length;
  const w = Math.max(0.5, el.width);
  const hBelt = 0.85;
  const belt = box(L, 0.14, w, M.belt, L / 2, hBelt, 0);
  g.add(belt);
  g.add(box(L, 0.2, 0.06, M.steel, L / 2, hBelt - 0.04, w / 2 + 0.03));
  g.add(box(L, 0.2, 0.06, M.steel, L / 2, hBelt - 0.04, -w / 2 - 0.03));
  // rolos
  const nR = Math.max(2, Math.floor(L / 0.25));
  const rolls = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.035, w, 6), M.rollers, nR);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
  for (let i = 0; i < nR; i++) {
    m4.compose(new THREE.Vector3((i + 0.5) * (L / nR), hBelt + 0.09, 0), q, new THREE.Vector3(1, 1, 1));
    rolls.setMatrixAt(i, m4);
  }
  g.add(rolls);
  // pernas
  const nLeg = Math.max(2, Math.floor(L / 3) + 1);
  for (let i = 0; i < nLeg; i++) {
    const x = (i * L) / (nLeg - 1);
    g.add(box(0.08, hBelt - 0.05, 0.08, M.steel, x, 0, w / 2));
    g.add(box(0.08, hBelt - 0.05, 0.08, M.steel, x, 0, -w / 2));
  }
  // caixas em movimento (animadas)
  const n = Math.max(3, Math.floor(L / 1.4));
  const cartons = new THREE.InstancedMesh(BOX, M.carton[1], n);
  cartons.userData.n = n;
  g.add(cartons);
  return { group: g, cartons, length: L, speed: el.speed ?? 0.6 };
}

export function buildStation(el: LayoutElement): THREE.Group {
  const g = new THREE.Group();
  g.add(box(el.length, 0.9, el.width, M.station, 0, 0, 0));
  g.add(box(0.5, 0.35, 0.06, M.dark, 0, 0.9, -el.width / 2 + 0.25));
  g.add(box(0.4, 0.04, 0.3, M.dark, 0, 0.9, -el.width / 2 + 0.45));
  return g;
}

export function buildZone(el: LayoutElement, staging: boolean): THREE.Group {
  const g = new THREE.Group();
  const p = new THREE.Mesh(new THREE.PlaneGeometry(el.length, el.width), staging ? M.zoneStaging : M.zoneGeneric);
  p.rotation.x = -Math.PI / 2;
  p.position.y = 0.02;
  g.add(p);
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(el.length, el.width)), new THREE.LineBasicMaterial({ color: staging ? 0x2563eb : 0x64748b }));
  e.rotation.x = -Math.PI / 2;
  e.position.y = 0.03;
  g.add(e);
  return g;
}

export function buildParking(el: LayoutElement): THREE.Group {
  const g = new THREE.Group();
  const p = new THREE.Mesh(new THREE.PlaneGeometry(el.length, el.width), M.parking);
  p.rotation.x = -Math.PI / 2;
  p.position.y = 0.02;
  g.add(p);
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(el.length, el.width)), new THREE.LineBasicMaterial({ color: 0xca8a04 }));
  e.rotation.x = -Math.PI / 2;
  e.position.y = 0.03;
  g.add(e);
  return g;
}

const AREA_EDGE: Record<string, number> = { aisle: 0x64748b, transit: 0xd97706, stage: 0x2563eb, triage: 0xdc2626, charger: 0x16a34a };
const AREA_Y: Record<string, number> = { aisle: 0.015, transit: 0.04, stage: 0.025, triage: 0.025, charger: 0.03 };

/** área plana de piso (rua, endereço transitório, stage, triagem, estação de carga) */
export function buildArea(el: LayoutElement): THREE.Group {
  const g = new THREE.Group();
  const y = AREA_Y[el.type] ?? 0.02;
  const p = new THREE.Mesh(new THREE.PlaneGeometry(el.length, el.width), (M as any)[el.type]);
  p.rotation.x = -Math.PI / 2;
  p.position.y = y;
  g.add(p);
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(el.length, el.width)), new THREE.LineBasicMaterial({ color: AREA_EDGE[el.type] ?? 0x64748b }));
  e.rotation.x = -Math.PI / 2;
  e.position.y = y + 0.01;
  g.add(e);
  return g;
}

/* ---------------- agentes móveis ---------------- */

export interface ForkliftVis {
  group: THREE.Group;
  carry: THREE.Group;
  forks: THREE.Group;
  wheels: THREE.Mesh[];
}

export function buildForklift(): ForkliftVis {
  const g = new THREE.Group();
  const body = box(1.5, 0.8, 1.05, M.yellow, -0.25, 0.28, 0);
  g.add(body);
  g.add(box(0.7, 0.55, 1.0, M.dark, -0.75, 1.08, 0)); // contrapeso/assento
  g.add(box(0.5, 0.15, 0.95, M.orange, -0.95, 0.28, 0));
  // proteção superior
  for (const [x, z] of [[-0.9, 0.5], [-0.9, -0.5], [0.3, 0.5], [0.3, -0.5]]) g.add(box(0.06, 1.1, 0.06, M.dark, x, 1.08, z));
  g.add(box(1.3, 0.05, 1.1, M.yellow, -0.3, 2.18, 0));
  // operador
  g.add(box(0.28, 0.5, 0.3, M.vest, -0.55, 1.15, 0));
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), M.helmet);
  head.position.set(-0.55, 1.85, 0);
  g.add(head);
  // mastro e garfos
  g.add(box(0.1, 2.0, 0.08, M.steel, 0.95, 0.15, 0.35));
  g.add(box(0.1, 2.0, 0.08, M.steel, 0.95, 0.15, -0.35));
  const forks = new THREE.Group();
  forks.position.set(0, 0.0, 0);
  forks.add(box(1.1, 0.06, 0.1, M.steel, 1.5, 0.12, 0.3));
  forks.add(box(1.1, 0.06, 0.1, M.steel, 1.5, 0.12, -0.3));
  forks.add(box(0.06, 0.6, 1.0, M.steel, 0.98, 0.12, 0));
  g.add(forks);
  const carry = new THREE.Group();
  carry.add(box(1.0, 0.14, 1.2, M.pallet, 1.55, 0.18, 0));
  carry.add(box(0.95, 0.9, 1.1, M.carton[0], 1.55, 0.32, 0));
  carry.visible = false;
  forks.add(carry);
  const wheels: THREE.Mesh[] = [];
  for (const [x, z] of [[0.4, 0.5], [0.4, -0.5], [-0.85, 0.46], [-0.85, -0.46]]) {
    const w = cyl(0.26, 0.2, M.tire, x, 0.26, z, true);
    wheels.push(w);
    g.add(w);
  }
  return { group: g, carry, forks, wheels };
}

export interface WorkerVis {
  group: THREE.Group;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  carry: THREE.Mesh;
}

export function buildWorker(kind: 'worker' | 'checker' = 'worker'): WorkerVis {
  const g = new THREE.Group();
  const vest = kind === 'checker' ? new THREE.MeshStandardMaterial({ color: 0x3b82f6 }) : M.vest;
  const torso = box(0.34, 0.6, 0.22, vest, 0, 0.85, 0);
  g.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), M.skin);
  head.position.set(0, 1.58, 0);
  g.add(head);
  const hat = new THREE.Mesh(new THREE.SphereGeometry(0.135, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.helmet);
  hat.position.set(0, 1.62, 0);
  g.add(hat);
  const mkLimb = (x: number, y: number, len: number, m: THREE.Material) => {
    const l = box(0.12, len, 0.12, m, 0, -len, 0);
    const pivot = new THREE.Group();
    pivot.position.set(0, y, x);
    pivot.add(l);
    g.add(pivot);
    return pivot as unknown as THREE.Mesh;
  };
  const legL = mkLimb(0.09, 0.85, 0.8, M.pants);
  const legR = mkLimb(-0.09, 0.85, 0.8, M.pants);
  const armL = mkLimb(0.23, 1.4, 0.55, vest);
  const armR = mkLimb(-0.23, 1.4, 0.55, vest);
  const carry = box(0.4, 0.3, 0.5, M.carton[2], 0.3, 1.0, 0);
  carry.visible = false;
  g.add(carry);
  return { group: g, legL, legR, armL, armR, carry };
}

/** classe visual do veículo, pelo comprimento do baú (o nome é livre; o tamanho é o que importa) */
export type VehicleClass = 'carreta' | 'truque' | 'toco' | 'vuc' | 'picape';
export const vehicleClass = (lengthM: number): VehicleClass => (lengthM >= 11 ? 'carreta' : lengthM >= 7.5 ? 'truque' : lengthM >= 5.5 ? 'toco' : lengthM >= 3.5 ? 'vuc' : 'picape');

export interface VehicleStyle {
  name?: string;
  lengthM: number;
}

const REAR = -6.7; // a traseira fica sempre no mesmo ponto: é ela que encosta na doca

/**
 * Veículo conforme o tamanho: carreta (cavalo + semirreboque, 3 eixos), truque (baú rígido, eixo traseiro duplo),
 * toco (baú rígido, 2 eixos), VUC (baú baixo, cabine curta) e picape (carroceria aberta com 1 palete).
 * Comprimento ao longo de Z local; traseira em -Z (voltada para a doca).
 */
export function buildTruck(kind: 'in' | 'out', style: VehicleStyle = { lengthM: 13.6 }): THREE.Group {
  const g = new THREE.Group();
  const cls = vehicleClass(style.lengthM);
  const box_ = kind === 'in' ? M.truckIn : M.truckOut;
  const cab = kind === 'in' ? M.cabIn : M.cabOut;
  const L = Math.max(1.6, style.lengthM);
  const wheel = (x: number, z: number, r = 0.5) => {
    const w = cyl(r, 0.3, M.tire, x, r, z, false);
    w.rotation.z = Math.PI / 2;
    g.add(w);
  };
  if (cls === 'picape') {
    // cabine + caçamba aberta com um palete
    g.add(box(1.9, 0.7, L + 2.0, cab, 0, 0.75, REAR + (L + 2.0) / 2));
    g.add(box(1.8, 0.85, 1.7, cab, 0, 1.45, REAR + L + 0.55));
    g.add(box(1.6, 0.5, 0.06, M.glass, 0, 1.55, REAR + L + 1.42));
    g.add(box(1.0, 0.14, 1.2, M.pallet, 0, 1.18, REAR + L / 2));
    g.add(box(0.95, 0.7, 1.1, M.carton[0], 0, 1.6, REAR + L / 2));
    for (const z of [REAR + 0.7, REAR + L + 1.0]) for (const x of [-0.85, 0.85]) wheel(x, z, 0.38);
    return g;
  }
  if (cls === 'carreta') {
    const bodyH = 2.9;
    g.add(box(2.55, bodyH, L, box_, 0, 0.9, REAR + L / 2));
    g.add(box(2.4, 0.3, L - 0.4, M.steel, 0, 0.6, REAR + L / 2));
    g.add(box(2.57, 0.35, L + 0.02, cab, 0, 1.6, REAR + L / 2));
    // cavalo mecânico à frente, com a quinta roda sob o semirreboque
    const cz = REAR + L + 1.3;
    g.add(box(2.2, 2.4, 2.3, cab, 0, 0.9, cz));
    g.add(box(2.0, 0.9, 0.06, M.glass, 0, 2.15, cz + 1.17));
    g.add(box(2.1, 0.5, 3.2, M.dark, 0, 0.55, cz - 0.6));
    for (const z of [REAR + 1.2, REAR + 2.4, REAR + 3.6]) for (const x of [-1.1, 1.1]) wheel(x, z);
    for (const z of [cz - 0.9, cz + 0.6]) for (const x of [-1.1, 1.1]) wheel(x, z);
    return g;
  }
  // rígidos: o baú e a cabine fazem parte do mesmo chassi
  const small = cls === 'vuc';
  const bodyH = small ? 2.3 : cls === 'toco' ? 2.6 : 2.8;
  const bodyW = small ? 2.15 : 2.45;
  g.add(box(bodyW, bodyH, L, box_, 0, 0.95, REAR + L / 2));
  g.add(box(bodyW - 0.2, 0.3, L, M.steel, 0, 0.62, REAR + L / 2));
  g.add(box(bodyW + 0.02, 0.3, L + 0.02, cab, 0, 1.5, REAR + L / 2));
  const cabLen = small ? 1.7 : 2.1;
  const cabH = small ? 1.9 : 2.2;
  const cz = REAR + L + cabLen / 2 + 0.1;
  g.add(box(bodyW - 0.15, cabH, cabLen, cab, 0, 0.95, cz));
  g.add(box(bodyW - 0.4, 0.8, 0.06, M.glass, 0, 1.85, cz + cabLen / 2 + 0.01));
  const r = small ? 0.42 : 0.5;
  const front = cz + cabLen / 2 - 0.5;
  for (const x of [-bodyW / 2 + 0.15, bodyW / 2 - 0.15]) wheel(x, front, r);
  if (cls === 'truque') for (const z of [REAR + 1.2, REAR + 2.4]) for (const x of [-1.1, 1.1]) wheel(x, z, r); // eixo traseiro duplo
  else for (const x of [-bodyW / 2 + 0.15, bodyW / 2 - 0.15]) wheel(x, REAR + 1.2, r);
  return g;
}

/* ---- equipamentos sem elevação ---- */

export interface MoverVis extends ForkliftVis {
  /** operário que acompanha a paleteira manual */
  operator?: WorkerVis;
  /** plataforma que sobe (AMR) */
  lift?: THREE.Object3D;
}

const M2 = {
  jack: mat(0xd1342f),
  truckBlue: mat(0x1d6fd1),
  battery: mat(0x2b3138),
  amr: mat(0x14b8a6),
  amrTop: mat(0x0f766e),
  led: new THREE.MeshBasicMaterial({ color: 0x4ade80 }),
  lidar: mat(0x111827),
};

/** paleteira manual: dois garfos baixos, bomba hidráulica, timão e o operário caminhando atrás */
export function buildPalletJack(): MoverVis {
  const g = new THREE.Group();
  const forks = new THREE.Group();
  forks.add(box(1.1, 0.06, 0.16, M.steel, 0.55, 0.08, 0.26));
  forks.add(box(1.1, 0.06, 0.16, M.steel, 0.55, 0.08, -0.26));
  forks.add(box(0.2, 0.16, 0.68, M2.jack, -0.05, 0.12, 0));
  g.add(forks);
  g.add(box(0.14, 0.9, 0.14, M2.jack, -0.12, 0.55, 0)); // coluna da bomba
  const tiller = box(0.9, 0.05, 0.05, M.dark, -0.55, 1.05, 0);
  tiller.rotation.z = -0.4;
  g.add(tiller);
  const wheels: THREE.Mesh[] = [];
  for (const [x, z] of [[1.0, 0.26], [1.0, -0.26], [-0.05, 0.3], [-0.05, -0.3]]) {
    const w = cyl(0.07, 0.1, M.tire, x, 0.07, z, true);
    wheels.push(w);
    g.add(w);
  }
  const carry = new THREE.Group();
  carry.add(box(1.0, 0.14, 1.2, M.pallet, 0.55, 0.2, 0));
  carry.add(box(0.95, 0.9, 1.1, M.carton[1], 0.55, 0.34, 0));
  carry.visible = false;
  g.add(carry);
  const operator = buildWorker('worker');
  operator.group.position.set(-1.15, 0, 0);
  g.add(operator.group);
  return { group: g, carry, forks, wheels, operator };
}

/** transpaleteira elétrica: corpo com bateria, plataforma/timão de comando e garfos longos */
export function buildPalletTruck(): MoverVis {
  const g = new THREE.Group();
  g.add(box(0.7, 0.55, 0.7, M2.battery, -0.1, 0.4, 0));
  g.add(box(0.72, 0.06, 0.72, M2.truckBlue, -0.1, 0.7, 0));
  g.add(box(0.5, 0.05, 0.65, M.dark, -0.6, 0.1, 0)); // plataforma do operador
  const tiller = box(0.1, 0.95, 0.1, M2.truckBlue, -0.45, 0.65, 0.2);
  tiller.rotation.z = -0.25;
  g.add(tiller);
  g.add(box(0.3, 0.1, 0.5, M.dark, -0.6, 1.1, 0.2)); // cabeçote de comando
  const light = box(0.1, 0.1, 0.1, M2.led, -0.1, 0.82, 0);
  g.add(light);
  const forks = new THREE.Group();
  forks.add(box(1.5, 0.07, 0.17, M.steel, 0.85, 0.09, 0.28));
  forks.add(box(1.5, 0.07, 0.17, M.steel, 0.85, 0.09, -0.28));
  g.add(forks);
  const wheels: THREE.Mesh[] = [];
  for (const [x, z] of [[1.55, 0.28], [1.55, -0.28], [-0.1, 0.3], [-0.1, -0.3]]) {
    const w = cyl(0.09, 0.12, M.tire, x, 0.09, z, true);
    wheels.push(w);
    g.add(w);
  }
  const carry = new THREE.Group();
  carry.add(box(1.0, 0.14, 1.2, M.pallet, 0.9, 0.2, 0));
  carry.add(box(0.95, 0.9, 1.1, M.carton[1], 0.9, 0.34, 0));
  carry.visible = false;
  g.add(carry);
  return { group: g, carry, forks, wheels };
}

/** AMR: plataforma baixa que entra sob o palete e o ergue; sensor a laser na frente e faixa luminosa */
export function buildAmr(): MoverVis {
  const g = new THREE.Group();
  g.add(box(1.5, 0.28, 0.95, M2.amr, 0, 0.2, 0));
  g.add(box(1.52, 0.04, 0.97, M2.led, 0, 0.36, 0)); // faixa de LED
  g.add(box(0.2, 0.18, 0.4, M2.lidar, 0.78, 0.3, 0)); // sensor frontal
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), M2.lidar);
  dome.position.set(0.8, 0.46, 0);
  g.add(dome);
  const lift = new THREE.Group();
  lift.add(box(1.3, 0.06, 0.85, M2.amrTop, 0, 0.37, 0));
  g.add(lift);
  const carry = new THREE.Group();
  carry.add(box(1.0, 0.14, 1.2, M.pallet, 0, 0.5, 0));
  carry.add(box(0.95, 0.9, 1.1, M.carton[1], 0, 0.64, 0));
  carry.visible = false;
  lift.add(carry);
  const wheels: THREE.Mesh[] = [];
  for (const [x, z] of [[0.5, 0.5], [0.5, -0.5], [-0.5, 0.5], [-0.5, -0.5]]) {
    const w = cyl(0.12, 0.1, M.tire, x, 0.12, z, true);
    wheels.push(w);
    g.add(w);
  }
  return { group: g, carry, forks: lift as THREE.Group, wheels, lift };
}

export function makeLabel(text: string, scale = 1, color = '#e5e7eb', bg = 'rgba(15,23,42,0.75)'): THREE.Sprite {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const fs = 44;
  ctx.font = `600 ${fs}px sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 28;
  c.width = w;
  c.height = fs + 22;
  ctx.font = `600 ${fs}px sans-serif`;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(0, 0, c.width, c.height, 14);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 14, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set((c.width / c.height) * 0.9 * scale, 0.9 * scale, 1);
  sp.renderOrder = 10;
  return sp;
}
