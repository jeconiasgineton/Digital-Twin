import * as THREE from 'three';
import type { Layout, Scenario } from '../model/types';
import type { Pt } from '../math/spatial';
import { SimModel, type Tracer } from '../sim/model';
import { type Agent, DOCK_DEPTH, TRUCK_SPOT, buildWorld } from '../sim/world';
import { buildForklift, buildTruck, buildWorker, type ForkliftVis, type WorkerVis } from './entities';
import type { SceneView } from './scene';

const DEG = Math.PI / 180;

interface Seg {
  t0: number;
  t1: number;
  pts: Pt[];
  cum: number[];
  total: number;
  carrying: boolean;
}

interface AgentVis {
  agent: Agent;
  segs: Seg[];
  heading: number;
  pos: Pt;
  carrying: boolean;
  moving: boolean;
  fk?: ForkliftVis;
  wk?: WorkerVis;
  obj: THREE.Object3D;
  phase: number;
}

interface TruckVis {
  id: number;
  kind: 'in' | 'out';
  state: 'queued' | 'docked' | 'leaving';
  dockIdx: number;
  t: number;
  from: Pt;
  mesh: THREE.Group;
}

/** Reprodução ao vivo da simulação: o motor DES avança até o tempo de reprodução e os agentes são interpolados nas rotas calculadas. */
export class Playback implements Tracer {
  model!: SimModel;
  simTime = 0;
  speed = 60;
  playing = false;
  private agents = new Map<number, AgentVis>();
  private trucks = new Map<number, TruckVis>();
  private group = new THREE.Group();
  private heat?: { tex: THREE.CanvasTexture; ctx: CanvasRenderingContext2D; data: Float32Array; w: number; h: number; mesh: THREE.Mesh; canvas: HTMLCanvasElement; dirty: boolean; max: number };
  heatOn = false;
  private stockTimer = 0;
  private heatTimer = 0;
  onUpdate?: () => void;

  constructor(private view: SceneView) {
    view.dynamic.add(this.group);
  }

  /** (re)inicia a simulação a partir do cenário e layout atuais */
  reset(sc: Scenario, layout: Layout, seed?: number) {
    this.clear();
    const live: Scenario = { ...sc, warmupHours: 0, days: Math.max(sc.days, 2) };
    this.model = new SimModel(live, layout, seed ?? sc.seed, this);
    this.simTime = 0;
    this.view.levelHeight = sc.levelHeight;
    const w = this.model.world;
    // agentes
    for (const a of this.model.agents) this.createAgent(a);
    this.setupHeat(layout);
    this.syncStock(true);
    this.model.runUntil(0);
    this.updateVisuals(0);
    this.onUpdate?.();
  }

  private clear() {
    for (const v of this.agents.values()) this.group.remove(v.obj);
    for (const t of this.trucks.values()) this.group.remove(t.mesh);
    this.agents.clear();
    this.trucks.clear();
    if (this.heat) {
      this.view.overlay.remove(this.heat.mesh);
      this.heat = undefined;
    }
  }

  private createAgent(a: Agent) {
    let obj: THREE.Object3D;
    let fk: ForkliftVis | undefined;
    let wk: WorkerVis | undefined;
    if (a.kind === 'forklift') {
      fk = buildForklift();
      obj = fk.group;
    } else {
      wk = buildWorker(a.kind === 'checker' ? 'checker' : 'worker');
      obj = wk.group;
    }
    const v: AgentVis = { agent: a, segs: [], heading: 0, pos: { x: a.x, z: a.z }, carrying: false, moving: false, fk, wk, obj, phase: Math.random() * 6 };
    this.agents.set(a.id, v);
    obj.position.set(a.x, 0, a.z);
    this.group.add(obj);
  }

  /* ----- Tracer ----- */
  move(a: Agent, t0: number, t1: number, pts: Pt[], carrying: boolean) {
    const v = this.agents.get(a.id);
    if (!v || pts.length < 2) return;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    v.segs.push({ t0, t1: Math.max(t1, t0 + 0.01), pts, cum, total: cum[cum.length - 1], carrying });
    if (this.heatOn && this.heat) this.stamp(pts);
  }
  truckQueued(id: number, kind: 'in' | 'out', t: number) {
    const mesh = buildTruck(kind);
    mesh.visible = true;
    this.group.add(mesh);
    this.trucks.set(id, { id, kind, state: 'queued', dockIdx: -1, t, from: { x: 0, z: 0 }, mesh });
  }
  truckDocked(id: number, kind: 'in' | 'out', dockIdx: number, t: number) {
    const tr = this.trucks.get(id);
    if (!tr) return;
    tr.from = this.queuePos(tr, this.queueIndex(tr));
    tr.state = 'docked';
    tr.dockIdx = dockIdx;
    tr.t = t;
  }
  truckLeft(id: number, _kind: 'in' | 'out', t: number) {
    const tr = this.trucks.get(id);
    if (!tr) return;
    tr.state = 'leaving';
    tr.t = t;
  }

  private queueIndex(tr: TruckVis): number {
    let k = 0;
    for (const o of this.trucks.values()) if (o.kind === tr.kind && o.state === 'queued' && o.id < tr.id) k++;
    return k;
  }

  private dockOf(tr: TruckVis) {
    const docks = tr.kind === 'in' ? this.model.world.docksIn : this.model.world.docksOut;
    return docks[tr.dockIdx] ?? docks[0];
  }

  private outward(el: { rot: number }): Pt {
    // direção local +z em mundo
    return { x: -Math.sin(el.rot * DEG), z: Math.cos(el.rot * DEG) };
  }

  private queuePos(tr: TruckVis, k: number): Pt {
    const docks = tr.kind === 'in' ? this.model.world.docksIn : this.model.world.docksOut;
    if (!docks.length) return { x: 0, z: 0 };
    const d = docks[k % docks.length];
    const row = Math.floor(k / docks.length);
    const o = this.outward(d.el);
    const dist = TRUCK_SPOT + 26 + row * 16;
    return { x: d.el.x + o.x * dist, z: d.el.z + o.z * dist };
  }

  /* ----- mapa de calor ----- */
  private setupHeat(layout: Layout) {
    const W = layout.floor.width;
    const D = layout.floor.depth;
    const res = 0.5;
    const w = Math.ceil(W / res);
    const h = Math.ceil(D / res);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.LinearFilter;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.9 }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(W / 2, 0.06, D / 2);
    mesh.visible = this.heatOn;
    mesh.renderOrder = 2;
    this.view.overlay.add(mesh);
    this.heat = { tex, ctx, data: new Float32Array(w * h), w, h, mesh, canvas, dirty: false, max: 1 };
  }

  setHeat(on: boolean) {
    this.heatOn = on;
    if (this.heat) this.heat.mesh.visible = on;
  }

  private stamp(pts: Pt[]) {
    const H = this.heat!;
    const res = 0.5;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / res));
      for (let k = 0; k <= n; k++) {
        const x = a.x + ((b.x - a.x) * k) / n;
        const z = a.z + ((b.z - a.z) * k) / n;
        const cx = Math.floor(x / res);
        const cz = Math.floor(z / res);
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            const ix = cx + dx;
            const iz = cz + dz;
            if (ix < 0 || iz < 0 || ix >= H.w || iz >= H.h) continue;
            const v = (H.data[iz * H.w + ix] += dx === 0 && dz === 0 ? 1 : 0.35);
            if (v > H.max) H.max = v;
          }
      }
    }
    H.dirty = true;
  }

  private paintHeat() {
    const H = this.heat;
    if (!H || !H.dirty) return;
    const img = H.ctx.createImageData(H.w, H.h);
    for (let i = 0; i < H.data.length; i++) {
      const t = Math.min(1, Math.sqrt(H.data[i] / H.max));
      if (t <= 0.02) continue;
      // azul -> verde -> amarelo -> vermelho
      const r = Math.round(255 * Math.min(1, Math.max(0, 2 * t - 0.4)));
      const g = Math.round(255 * Math.min(1, t < 0.5 ? 2 * t : 2 - 2 * t + 0.2));
      const b = Math.round(255 * Math.max(0, 1 - 2.2 * t));
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = Math.round(220 * Math.min(1, t * 2));
    }
    H.ctx.putImageData(img, 0, 0);
    H.tex.needsUpdate = true;
    H.dirty = false;
  }

  /* ----- laço de reprodução ----- */

  tick(dt: number) {
    if (!this.model) return;
    if (this.playing) {
      const target = this.simTime + dt * this.speed;
      // limita trabalho por quadro (eventos) para manter a UI fluida
      const step = Math.max(1, Math.ceil((target - this.simTime) / 30));
      let t = this.simTime;
      const t0 = performance.now();
      while (t < target && performance.now() - t0 < 12) {
        t = Math.min(target, t + step);
        this.model.runUntil(t);
      }
      this.simTime = t;
      this.view.conveyorTimeScale = Math.min(1, 12 / Math.max(1, this.speed)) * 1.5;
    }
    this.updateVisuals(dt);
    this.stockTimer += dt;
    if (this.stockTimer > 0.4) {
      this.stockTimer = 0;
      this.syncStock();
      this.onUpdate?.();
    }
    this.heatTimer += dt;
    if (this.heatTimer > 0.8 && this.heatOn) {
      this.heatTimer = 0;
      this.paintHeat();
    }
  }

  private syncStock(force = false) {
    for (const r of this.model.world.racks) this.view.setRackStock(r.el.id, r.stock);
    void force;
  }

  private updateVisuals(dt: number) {
    const t = this.simTime;
    for (const v of this.agents.values()) {
      while (v.segs.length > 1 && v.segs[0].t1 <= t) {
        const s = v.segs.shift()!;
        v.pos = s.pts[s.pts.length - 1];
      }
      const s = v.segs[0];
      let moving = false;
      if (s && t >= s.t0 && t < s.t1) {
        const u = (t - s.t0) / (s.t1 - s.t0);
        // perfil trapezoidal suave (aceleração/frenagem) – smoothstep
        const e = u * u * (3 - 2 * u) * 0.55 + u * 0.45;
        const d = e * s.total;
        let i = 1;
        while (i < s.cum.length - 1 && s.cum[i] < d) i++;
        const a = s.pts[i - 1];
        const b = s.pts[i];
        const f = (d - s.cum[i - 1]) / Math.max(1e-6, s.cum[i] - s.cum[i - 1]);
        v.pos = { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
        const hd = Math.atan2(b.z - a.z, b.x - a.x);
        v.heading = this.lerpAngle(v.heading, hd, Math.min(1, dt * 8 + (this.playing ? 0 : 1)));
        moving = true;
        v.carrying = s.carrying;
      } else if (s && t >= s.t1) {
        v.pos = s.pts[s.pts.length - 1];
        v.segs.shift();
      } else if (!s) {
        // parado: mantém última posição
      }
      v.moving = moving;
      v.obj.position.set(v.pos.x, 0, v.pos.z);
      v.obj.rotation.y = -v.heading;
      if (v.fk) {
        const carrying = v.carrying && moving;
        v.fk.carry.visible = carrying;
        v.fk.forks.position.y = carrying ? 0.15 : 0;
        for (const w of v.fk.wheels) if (moving) w.rotation.z += dt * 6;
      } else if (v.wk) {
        const sw = moving ? Math.sin(t * 6 + v.phase) * 0.6 : 0;
        v.wk.legL.rotation.z = sw;
        v.wk.legR.rotation.z = -sw;
        v.wk.armL.rotation.z = v.carrying && moving ? -1.1 : -sw * 0.8;
        v.wk.armR.rotation.z = v.carrying && moving ? -1.1 : sw * 0.8;
        v.wk.carry.visible = v.carrying && moving;
      }
    }
    // caminhões
    let kIn = 0;
    let kOut = 0;
    const qOrder = [...this.trucks.values()].sort((a, b) => a.id - b.id);
    for (const tr of qOrder) {
      const docks = tr.kind === 'in' ? this.model.world.docksIn : this.model.world.docksOut;
      if (!docks.length) continue;
      let p: Pt;
      let rot: number;
      if (tr.state === 'queued') {
        const k = tr.kind === 'in' ? kIn++ : kOut++;
        p = this.queuePos(tr, k);
        rot = docks[k % docks.length].el.rot;
      } else {
        const d = this.dockOf(tr);
        const o = this.outward(d.el);
        rot = d.el.rot;
        if (tr.state === 'docked') {
          const u = Math.min(1, Math.max(0, (t - tr.t) / 25));
          const e = u * u * (3 - 2 * u);
          p = { x: tr.from.x + (d.outer.x - tr.from.x) * e, z: tr.from.z + (d.outer.z - tr.from.z) * e };
        } else {
          const u = (t - tr.t) / 40;
          if (u >= 1) {
            this.group.remove(tr.mesh);
            this.trucks.delete(tr.id);
            continue;
          }
          const e = u * u;
          p = { x: d.outer.x + o.x * 70 * e, z: d.outer.z + o.z * 70 * e };
        }
      }
      tr.mesh.position.set(p.x, 0, p.z);
      tr.mesh.rotation.y = -rot * DEG;
    }
  }

  private lerpAngle(a: number, b: number, f: number) {
    let d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return a + d * f;
  }

  /** hora do dia formatada para o relógio da simulação */
  clockString(): { day: number; hhmm: string } {
    const sc = this.model.sc;
    const shiftS = sc.shiftHours * 3600;
    const day = Math.floor(this.simTime / shiftS) + 1;
    const inDay = this.simTime % shiftS;
    const h = (sc.startHour + Math.floor(inDay / 3600)) % 24;
    const m = Math.floor((inDay % 3600) / 60);
    return { day, hhmm: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
  }

  dispose() {
    this.clear();
    this.view.dynamic.remove(this.group);
  }
}

export { DOCK_DEPTH, buildWorld };
