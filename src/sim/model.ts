import type { Layout, ReplicationResult, RunKpis, Scenario, HourSeries } from '../model/types';
import { Rng, sampleDist } from '../math/rng';
import { mean, percentile } from '../math/stats';
import type { Pt } from '../math/spatial';
import { Pool, type PoolItem, Countdown, Sim, type Process } from './engine';
import { type Agent, type ConveyorRT, type DockItem, type RackRT, type World, buildWorld } from './world';
export type { World };

/** Interface opcional para animação 3D. */
export interface Tracer {
  move(a: Agent, t0: number, t1: number, pts: Pt[], carrying: boolean): void;
  truckQueued(id: number, kind: 'in' | 'out', t: number): void;
  truckDocked(id: number, kind: 'in' | 'out', dockIdx: number, t: number): void;
  truckLeft(id: number, kind: 'in' | 'out', t: number): void;
}

const MTTR = 1800; // reparo médio (s)

/** tempo de deslocamento com aceleração/desaceleração constantes e velocidade-limite v */
export function travelTime(d: number, v: number, a: number): number {
  if (d <= 0 || v <= 0) return 0;
  const dAcc = (v * v) / a; // distância gasta para acelerar + frear
  return d >= dAcc ? d / v + v / a : 2 * Math.sqrt(d / a);
}

interface Counters {
  palletsIn: number;
  palletsOut: number;
  orders: number;
  lines: number;
  cartons: number;
  trucksIn: number;
  trucksOut: number;
  inReq: number;
  outReq: number;
  stockouts: number;
  overflow: number;
  ordersArrived: number;
  palletsRequested: number;
  palletsDone: number;
}

export class SimModel {
  readonly sim = new Sim();
  readonly world: World;
  readonly forklifts: Pool<Agent>;
  readonly workers: Pool<Agent>;
  readonly checkers: Pool<Agent>;
  readonly dockIn: Pool<DockItem>;
  readonly dockOut: Pool<DockItem>;
  readonly convPools: Pool<ConveyorRT>[];
  readonly packPool: Pool<PoolItem>;
  readonly agents: Agent[] = [];
  readonly horizon: number;
  readonly warm: number;
  readonly c: Counters = {
    palletsIn: 0, palletsOut: 0, orders: 0, lines: 0, cartons: 0, trucksIn: 0, trucksOut: 0, inReq: 0, outReq: 0,
    stockouts: 0, overflow: 0, ordersArrived: 0, palletsRequested: 0, palletsDone: 0,
  };
  readonly dockWaitIn: number[] = [];
  readonly dockWaitOut: number[] = [];
  readonly turnIn: number[] = [];
  readonly turnOut: number[] = [];
  readonly orderCycle: number[] = [];
  readonly putawayLead: number[] = [];
  readonly hourly: HourSeries[] = [];
  readonly occSeries: { t: number; occ: number }[] = [];
  /** contadores por hora absoluta de simulação */
  private hourCounts: { in: number; out: number; ord: number }[] = [];
  private rngArr: Rng;
  private rngSvc: Rng;
  private rngRoute: Rng;
  private skuW: number[];
  private skuCls: (0 | 1 | 2)[];
  private truckSeq = 0;
  private pickBands: RackRT[][];

  constructor(readonly sc: Scenario, layout: Layout, seed: number, readonly tracer?: Tracer, world?: World) {
    const root = new Rng(seed);
    this.rngArr = root.fork('arrivals');
    this.rngSvc = root.fork('service');
    this.rngRoute = root.fork('routing');
    this.world = world ?? buildWorld(layout, sc);
    this.horizon = sc.days * sc.shiftHours * 3600;
    this.warm = Math.min(sc.warmupHours * 3600, this.horizon * 0.5);
    const w = this.world;
    const sim = this.sim;

    // ---- frota ----
    const mk = (kind: Agent['kind'], n: number, spec: Scenario['forklifts'], idBase: number): Pool<Agent> => {
      const items: Agent[] = [];
      const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      for (let i = 0; i < n; i++) {
        const a: Agent = {
          id: idBase + i, kind, x: w.home.x + (i % cols) * 1.6, z: w.home.z + Math.floor(i / cols) * 1.6,
          busy: false, busyTime: 0, busySince: 0, downTime: 0, speedEmpty: spec.speedEmpty, speedLoaded: spec.speedLoaded, km: 0, tasks: 0,
        };
        items.push(a);
        this.agents.push(a);
      }
      return new Pool(sim, items);
    };
    this.forklifts = mk('forklift', sc.forklifts.count, sc.forklifts, 0);
    this.workers = mk('worker', sc.workers.count, sc.workers, 1000);
    this.checkers = mk('checker', sc.checkers.count, sc.checkers, 2000);
    for (const p of [this.forklifts, this.workers, this.checkers]) p.statsFrom = this.warm;
    this.dockIn = new Pool(sim, w.docksIn);
    this.dockOut = new Pool(sim, w.docksOut);
    this.dockIn.statsFrom = this.dockOut.statsFrom = this.warm;
    this.convPools = w.conveyors.map((cv) => {
      const p = new Pool(sim, [cv]);
      p.statsFrom = this.warm;
      return p;
    });
    const stationItems: PoolItem[] = w.stations.map((s, i) => ({ id: i, x: s.x, z: s.z, busy: false, busyTime: 0, busySince: 0, downTime: 0 }));
    this.packPool = new Pool(sim, stationItems);
    this.packPool.statsFrom = this.warm;

    // ---- SKU / ABC ----
    const skus = sc.skus.length ? sc.skus : [{ sku: 'A', description: '', cls: 'A' as const, share: 0.7, cartonsPerPallet: 60 }, { sku: 'B', description: '', cls: 'B' as const, share: 0.2, cartonsPerPallet: 60 }, { sku: 'C', description: '', cls: 'C' as const, share: 0.1, cartonsPerPallet: 60 }];
    this.skuW = skus.map((s) => Math.max(0, s.share));
    this.skuCls = skus.map((s) => (s.cls === 'A' ? 0 : s.cls === 'B' ? 1 : 2));
    const sorted = [...w.pickRacks].sort((a, b) => a.rank - b.rank);
    const n = sorted.length;
    this.pickBands = [sorted.slice(0, Math.max(1, Math.round(n * 0.34))), sorted.slice(Math.round(n * 0.2), Math.max(Math.round(n * 0.6), 1) + 1), sorted];
    if (!this.pickBands[1].length) this.pickBands[1] = sorted;

    // ---- estoque inicial ----
    for (const r of w.racks) {
      const f = sc.initialOccupancy * (0.9 + 0.2 * this.rngRoute.next());
      r.stock = Math.min(r.capacity, Math.round(r.capacity * f));
    }

    // ---- processos ----
    const startFail = (pool: Pool<Agent>, avail: number) => {
      if (avail >= 0.999 || avail <= 0) return;
      const mtbf = (MTTR * avail) / (1 - avail);
      const rng = root.fork('fail' + pool.items[0]?.kind);
      for (const it of pool.items) {
        sim.spawn(function* () {
          for (;;) {
            yield rng.exp(mtbf);
            pool.fail(it, rng.exp(MTTR));
          }
        });
      }
    };
    startFail(this.forklifts, sc.forklifts.availability);
    startFail(this.workers, sc.workers.availability);
    startFail(this.checkers, sc.checkers.availability);

    sim.spawn(this.arrivals(sc.inboundTrucksPerHour, () => this.inboundTruck()));
    sim.spawn(this.arrivals(sc.outboundTrucksPerHour, () => this.outboundTruck()));
    sim.spawn(this.arrivals(sc.ordersPerHour, () => this.order()));
    sim.spawn(this.sampler());
  }

  /* ---------------- utilidades ---------------- */

  private go(ag: Agent, to: Pt, carrying: boolean): number {
    const from = { x: ag.x, z: ag.z };
    const d = this.world.nav.distance(from, to);
    const v = carrying ? ag.speedLoaded : ag.speedEmpty;
    const t = travelTime(d, v, this.sc.accel);
    if (this.sim.now >= this.warm) ag.km += d / 1000;
    if (this.tracer && d > 0.05) this.tracer.move(ag, this.sim.now, this.sim.now + t, this.world.nav.route(from, to), carrying);
    ag.x = to.x;
    ag.z = to.z;
    return t;
  }

  private sum(d: Scenario['ops']['pickCarton'], n: number): number {
    const k = Math.min(n, 25);
    let s = 0;
    for (let i = 0; i < k; i++) s += sampleDist(this.rngSvc, d);
    return n > k ? (s / k) * n : s;
  }

  private get measuring() {
    return this.sim.now >= this.warm;
  }

  private hourBucket() {
    const h = Math.floor(this.sim.now / 3600);
    while (this.hourCounts.length <= h) this.hourCounts.push({ in: 0, out: 0, ord: 0 });
    return this.hourCounts[h];
  }

  private pickSku(): { idx: number; cls: 0 | 1 | 2 } {
    const i = this.rngRoute.pick(this.skuW);
    return { idx: i, cls: this.skuCls[i] };
  }

  /** endereçamento de guarda (putaway) */
  private chooseRackPut(cls: 0 | 1 | 2, from: Pt): RackRT | null {
    const w = this.world;
    const free = (r: RackRT) => r.capacity - r.stock;
    const pol = this.sc.slotting;
    let cands: RackRT[] = [];
    if (pol === 'abc') cands = w.zones[cls].filter((r) => free(r) > 0);
    if (!cands.length) cands = w.racks.filter((r) => free(r) > 0);
    if (!cands.length) return null;
    if (pol === 'nearest') {
      let best = cands[0];
      let bd = Infinity;
      for (const r of cands) {
        const d = this.world.nav.distance(from, r.access[Math.floor(r.bays / 2)][0]);
        if (d < bd) {
          bd = d;
          best = r;
        }
      }
      return best;
    }
    return cands[this.rngRoute.pick(cands.map(free))];
  }

  private chooseRackGet(cls: 0 | 1 | 2): RackRT | null {
    const w = this.world;
    let cands = w.zones[cls].filter((r) => r.stock > 0);
    if (!cands.length || this.sc.slotting === 'random') cands = w.racks.filter((r) => r.stock > 0);
    if (!cands.length) return null;
    return cands[this.rngRoute.pick(cands.map((r) => r.stock))];
  }

  private liftTime(r: RackRT): number {
    const level = 1 + this.rngRoute.int(r.levels);
    const h = (level - 1) * this.sc.levelHeight;
    return (2 * h) / Math.max(0.05, this.sc.liftSpeed) + sampleDist(this.rngSvc, this.sc.ops.putawayPosition);
  }

  private accessPoint(r: RackRT): Pt {
    const bay = this.rngRoute.int(r.bays);
    return r.access[bay][this.rngRoute.int(2)];
  }

  private busyTotal(pool: Pool<any>): number {
    let b = 0;
    for (const it of pool.items) {
      b += it.busyTime;
      if (it.busy) b += Math.max(0, this.sim.now - Math.max(it.busySince, this.warm));
    }
    return b;
  }

  /* ---------------- processos ---------------- */

  private arrivals(rates: number[], spawn: () => Process): () => Process {
    const self = this;
    return function* () {
      const sc = self.sc;
      const totalHours = sc.days * sc.shiftHours;
      for (let k = 0; k < totalHours; k++) {
        const rate = (rates[(sc.startHour + (k % sc.shiftHours)) % 24] ?? 0) * sc.demandFactor;
        const hourEnd = (k + 1) * 3600;
        if (rate <= 0) {
          yield Math.max(0, hourEnd - self.sim.now);
          continue;
        }
        for (;;) {
          const gap = self.rngArr.exp(3600 / rate);
          if (self.sim.now + gap >= hourEnd) {
            yield Math.max(0, hourEnd - self.sim.now);
            break;
          }
          yield gap;
          self.sim.spawn(spawn());
        }
      }
    };
  }

  private palletsPerTruck(spec: Scenario['palletsPerTruckIn']): number {
    const n = Math.round(this.rngSvc.normal(spec.mean, spec.sd));
    return Math.min(Math.max(1, n), Math.max(1, spec.max));
  }

  private *inboundTruck(): Process {
    const id = ++this.truckSeq;
    const tArr = this.sim.now;
    this.tracer?.truckQueued(id, 'in', tArr);
    const dock: DockItem = yield this.dockIn.request();
    const tDock = this.sim.now;
    this.tracer?.truckDocked(id, 'in', dock.idx, tDock);
    if (tArr >= this.warm) this.dockWaitIn.push((tDock - tArr) / 60);
    yield sampleDist(this.rngSvc, this.sc.ops.dockTurnover);
    const n = this.palletsPerTruck(this.sc.palletsPerTruckIn);
    const unloaded = new Countdown(this.sim, n);
    for (let i = 0; i < n; i++) this.sim.spawn(this.inboundPallet(dock, unloaded, tDock));
    yield unloaded.signal;
    this.dockIn.release(dock);
    this.tracer?.truckLeft(id, 'in', this.sim.now);
    if (tArr >= this.warm) {
      this.turnIn.push((this.sim.now - tArr) / 60);
      this.c.trucksIn++;
    }
  }

  private *inboundPallet(dock: DockItem, unloaded: Countdown, tDock: number): Process {
    const sc = this.sc;
    const c = this.c;
    const cls = this.pickSku().cls;
    c.palletsRequested++;
    if (tDock >= this.warm) c.inReq++;
    let fk: Agent = yield this.forklifts.request(dock.inner);
    yield this.go(fk, dock.inner, false);
    yield sampleDist(this.rngSvc, sc.ops.unloadPallet);
    unloaded.tick();
    if (sc.checkers.count > 0) {
      // deposita na área de conferência, libera empilhadeira; conferente verifica; nova tarefa de guarda
      const stage = { x: dock.inner.x, z: dock.inner.z - 2.5 };
      yield this.go(fk, stage, true);
      this.forklifts.release(fk);
      const ck: Agent = yield this.checkers.request(stage);
      yield this.go(ck, stage, false);
      yield sampleDist(this.rngSvc, sc.ops.checkPallet);
      this.checkers.release(ck);
      fk = yield this.forklifts.request(stage);
      yield this.go(fk, stage, false);
    }
    const rack = this.chooseRackPut(cls, dock.inner);
    if (!rack) {
      if (tDock >= this.warm) c.overflow++;
      c.palletsDone++;
      this.forklifts.release(fk);
      return;
    }
    rack.stock++;
    const ap = this.accessPoint(rack);
    yield this.go(fk, ap, true);
    yield this.liftTime(rack);
    fk.tasks++;
    this.forklifts.release(fk);
    c.palletsDone++;
    if (this.measuring) {
      c.palletsIn++;
      this.hourBucket().in++;
    }
    if (tDock >= this.warm) this.putawayLead.push((this.sim.now - tDock) / 60);
  }

  private *outboundTruck(): Process {
    const id = ++this.truckSeq;
    const tArr = this.sim.now;
    this.tracer?.truckQueued(id, 'out', tArr);
    const dock: DockItem = yield this.dockOut.request();
    const tDock = this.sim.now;
    this.tracer?.truckDocked(id, 'out', dock.idx, tDock);
    if (tArr >= this.warm) this.dockWaitOut.push((tDock - tArr) / 60);
    yield sampleDist(this.rngSvc, this.sc.ops.dockTurnover);
    const n = this.palletsPerTruck(this.sc.palletsPerTruckOut);
    const loaded = new Countdown(this.sim, n);
    for (let i = 0; i < n; i++) this.sim.spawn(this.outboundPallet(dock, loaded, tDock));
    yield loaded.signal;
    this.dockOut.release(dock);
    this.tracer?.truckLeft(id, 'out', this.sim.now);
    if (tArr >= this.warm) {
      this.turnOut.push((this.sim.now - tArr) / 60);
      this.c.trucksOut++;
    }
  }

  private *outboundPallet(dock: DockItem, loaded: Countdown, tDock: number): Process {
    const c = this.c;
    if (tDock >= this.warm) c.outReq++;
    const cls = this.pickSku().cls;
    const rack = this.chooseRackGet(cls);
    if (!rack) {
      if (tDock >= this.warm) c.stockouts++;
      loaded.tick();
      return;
    }
    rack.stock--;
    c.palletsRequested++;
    const ap = this.accessPoint(rack);
    const fk: Agent = yield this.forklifts.request(ap);
    yield this.go(fk, ap, false);
    yield this.liftTime(rack);
    yield this.go(fk, dock.inner, true);
    yield sampleDist(this.rngSvc, this.sc.ops.loadPallet);
    fk.tasks++;
    this.forklifts.release(fk);
    loaded.tick();
    c.palletsDone++;
    if (this.measuring) {
      c.palletsOut++;
      this.hourBucket().out++;
    }
  }

  private *order(): Process {
    const sc = this.sc;
    const c = this.c;
    const w = this.world;
    const tArr = this.sim.now;
    c.ordersArrived++;
    const nLines = 1 + this.rngSvc.poisson(Math.max(0, sc.linesPerOrder.mean - 1));
    const stops: { p: Pt; cartons: number }[] = [];
    let totalCartons = 0;
    for (let i = 0; i < nLines; i++) {
      const cls = this.pickSku().cls;
      const band = this.pickBands[cls];
      const rack = band[this.rngRoute.int(band.length)];
      const cartons = Math.max(1, Math.round(this.rngSvc.lognormal(sc.cartonsPerLine.mean, sc.cartonsPerLine.sd)));
      stops.push({ p: this.accessPoint(rack), cartons });
      totalCartons += cartons;
    }
    // ordena paradas por proximidade (vizinho mais próximo) para modelar roteirização do picking
    const wk: Agent = yield this.workers.request(stops[0].p);
    const route: typeof stops = [];
    let cur: Pt = { x: wk.x, z: wk.z };
    const rest = [...stops];
    while (rest.length) {
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < rest.length; i++) {
        const d = Math.abs(rest[i].p.x - cur.x) + Math.abs(rest[i].p.z - cur.z);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      cur = rest[bi].p;
      route.push(rest.splice(bi, 1)[0]);
    }
    for (const s of route) {
      yield this.go(wk, s.p, false);
      yield this.sum(sc.ops.pickCarton, s.cartons);
    }
    if (w.conveyors.length) {
      let bi = 0;
      let bd = Infinity;
      w.conveyors.forEach((cv, i) => {
        const d = w.nav.distance({ x: wk.x, z: wk.z }, cv.start);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      const cv = w.conveyors[bi];
      yield this.go(wk, cv.start, true);
      const cp = this.convPools[bi];
      const item: ConveyorRT = yield cp.request();
      yield (totalCartons * sc.conveyorSpacing) / cv.speed; // tempo de indução (headway)
      cp.release(item);
      wk.tasks++;
      this.workers.release(wk);
      yield cv.el.length / cv.speed; // transporte
    } else {
      const dk = w.docksOut[0]?.inner ?? w.home;
      yield this.go(wk, dk, true);
      yield totalCartons * 1.5;
      wk.tasks++;
      this.workers.release(wk);
    }
    if (this.packPool.items.length) {
      const st: PoolItem = yield this.packPool.request();
      yield sampleDist(this.rngSvc, sc.ops.packOrder);
      this.packPool.release(st);
    }
    if (tArr >= this.warm) {
      this.orderCycle.push((this.sim.now - tArr) / 60);
      c.orders++;
      c.lines += nLines;
      c.cartons += totalCartons;
    }
    if (this.measuring) this.hourBucket().ord++;
  }

  private *sampler(): Process {
    const total = this.world.totalCapacity || 1;
    let prevT = this.warm;
    let prevF = 0;
    let prevW = 0;
    let nextOcc = 0;
    for (let t = 900; t <= this.horizon + 1; t += 900) {
      yield t - this.sim.now;
      const stock = this.world.racks.reduce((s, r) => s + r.stock, 0);
      if (this.sim.now >= this.warm || this.occSeries.length === 0 || this.sim.now >= nextOcc) this.occSeries.push({ t: this.sim.now, occ: stock / total });
      if (t % 3600 === 0 && this.sim.now > this.warm) {
        const bf = this.busyTotal(this.forklifts);
        const bw = this.busyTotal(this.workers);
        const span = this.sim.now - prevT;
        const hb = this.hourCounts[Math.floor((this.sim.now - 1) / 3600)] ?? { in: 0, out: 0, ord: 0 };
        this.hourly.push({
          hour: Math.floor((this.sim.now - 1) / 3600),
          palletsIn: hb.in,
          palletsOut: hb.out,
          orders: hb.ord,
          utilForklift: this.forklifts.items.length ? (bf - prevF) / (span * this.forklifts.items.length) : 0,
          utilWorker: this.workers.items.length ? (bw - prevW) / (span * this.workers.items.length) : 0,
          queueForklift: this.forklifts.queueLength,
        });
        prevT = this.sim.now;
        prevF = bf;
        prevW = bw;
      }
    }
  }

  /* ---------------- execução / resultados ---------------- */

  runUntil(t: number) {
    this.sim.runUntil(t);
  }

  runAll(): ReplicationResult {
    this.sim.runUntil(this.horizon);
    return this.result();
  }

  result(): ReplicationResult {
    const sc = this.sc;
    const c = this.c;
    const end = this.horizon;
    for (const p of [this.forklifts, this.workers, this.checkers, this.dockIn, this.dockOut, this.packPool, ...this.convPools] as Pool<any>[]) p.finalize();
    const hours = Math.max(1e-9, (end - this.warm) / 3600);
    const days = hours / sc.shiftHours;
    const wmean = (w: number[]) => mean(w) / 60;
    const wp95 = (w: number[]) => percentile(w, 0.95) / 60;
    const convUtil = this.convPools.length ? mean(this.convPools.map((p) => p.utilization(end))) : 0;
    const fleetCost = sc.forklifts.count * sc.forklifts.costPerHour + sc.workers.count * sc.workers.costPerHour + sc.checkers.count * sc.checkers.costPerHour;
    const totalCost = fleetCost * hours;
    const moved = c.palletsIn + c.palletsOut;
    const kms = (p: Pool<Agent>) => (p.items.length ? mean(p.items.map((a) => a.km)) : 0);
    const stockNow = this.world.racks.reduce((s, r) => s + r.stock, 0);
    const occ = this.occSeries.filter((o) => o.t >= this.warm).map((o) => o.occ);
    const kpis: RunKpis = {
      palletsInPerDay: c.palletsIn / days,
      palletsOutPerDay: c.palletsOut / days,
      ordersPerDay: c.orders / days,
      linesPerDay: c.lines / days,
      cartonsPerDay: c.cartons / days,
      trucksInPerDay: c.trucksIn / days,
      trucksOutPerDay: c.trucksOut / days,
      utilForklift: this.forklifts.utilization(end),
      utilWorker: this.workers.utilization(end),
      utilChecker: this.checkers.utilization(end),
      utilDockIn: this.dockIn.utilization(end),
      utilDockOut: this.dockOut.utilization(end),
      utilConveyor: convUtil,
      waitForkliftMean: wmean(this.forklifts.waits),
      waitForkliftP95: wp95(this.forklifts.waits),
      waitWorkerMean: wmean(this.workers.waits),
      waitWorkerP95: wp95(this.workers.waits),
      dockWaitIn: mean(this.dockWaitIn),
      dockWaitInP95: percentile(this.dockWaitIn, 0.95),
      dockWaitOut: mean(this.dockWaitOut),
      dockWaitOutP95: percentile(this.dockWaitOut, 0.95),
      truckTurnaroundIn: mean(this.turnIn),
      truckTurnaroundOut: mean(this.turnOut),
      orderCycleMean: mean(this.orderCycle),
      orderCycleP95: percentile(this.orderCycle, 0.95),
      putawayLeadMean: mean(this.putawayLead),
      occupancyMean: occ.length ? mean(occ) : stockNow / (this.world.totalCapacity || 1),
      occupancyMax: occ.length ? Math.max(...occ) : 0,
      stockoutRate: c.outReq ? c.stockouts / (c.outReq * 1) : 0,
      overflowRate: c.inReq ? c.overflow / c.inReq : 0,
      palletsPerForkliftHour: sc.forklifts.count ? moved / (sc.forklifts.count * hours) : 0,
      linesPerWorkerHour: sc.workers.count ? c.lines / (sc.workers.count * hours) : 0,
      kmPerForklift: kms(this.forklifts) / days,
      kmPerWorker: kms(this.workers) / days,
      costPerPallet: moved ? totalCost / moved : 0,
      totalCost,
      backlogOrders: 0,
      backlogPallets: Math.max(0, c.palletsRequested - c.palletsDone),
    };
    kpis.backlogOrders = this.workers.queueLength; // pedidos ainda aguardando operário ao final
    return {
      kpis,
      hourly: this.hourly,
      samples: { orderCycle: this.orderCycle, forkliftWait: this.forklifts.waits.map((w) => w / 60), putawayLead: this.putawayLead, truckTurn: [...this.turnIn, ...this.turnOut] },
      occupancySeries: this.occSeries,
    };
  }
}
