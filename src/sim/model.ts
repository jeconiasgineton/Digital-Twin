import type { ArrivalSpec, EquipmentKind, FleetSpec, Layout, ReplicationResult, RunKpis, Scenario, HourSeries, VehicleType, PeopleRole } from '../model/types';
import { trailerDepthM } from '../model/receiving';
import { auxLoad, runProcess, startPalletProcess } from './workflow';
import type { PickRouteParams, ProcessDef, ResourceKind, TaskStep } from '../model/process';
import { effectiveSteps, type BoardStep, type ConferenceStep, type CustomizeStep, type ExpPerson, type ExpStep, type ReconcileStep } from '../model/expedition';
import { planRoute, routeTravelSec, splitAmongPickers, type AisleInfo, type PickPos, type Stop } from '../model/picking';
import { toLocal, toWorld } from '../math/spatial';
import { buildPickPositions } from './pickpos';
import { amrChargeHours } from '../model/equipment';
import { PEOPLE_ROLES, breakMinutesPerDay, effectiveVehicles, loadPallets, offsetInShift, shareFor, waveOf } from '../model/traffic';
import { Rng, distMean as distMeanOf, sampleDist } from '../math/rng';
import { mean, percentile } from '../math/stats';
import type { Pt } from '../math/spatial';
import { Pool, type PoolItem, Countdown, Sim, Store, VehicleGate, type Process } from './engine';
import { type Agent, type AreaRT, type ConveyorRT, type DockItem, type RackRT, SLOT_FREE, SLOT_OCCUPIED, SLOT_RESERVED, type World, buildWorld, findSlot, slotAddr, slotLabel, slotSide } from './world';
export type { World };

/** Interface opcional para animação 3D. */
export interface Tracer {
  move(a: Agent, t0: number, t1: number, pts: Pt[], carrying: boolean): void;
  truckQueued(id: number, kind: 'in' | 'out', t: number, veh?: { name?: string; lengthM: number }): void;
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
  scheduled: number; // veículos agendados/fixos gerados (base do % de atrasos)
  delayed: number;
  delaySec: number;
  waitOverIn: number;
  waitOverOut: number;
  checked: number;
  damaged: number;
  damagedCartons: number;
  wholeTriage: number;
  triageOverflow: number;
}

/** palete pronto no stage de expedição */
export interface StageToken {
  slot?: PoolItem;
  origin: 'picking' | 'full';
  boxes: number;
  checked?: boolean;
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
    stockouts: 0, overflow: 0, ordersArrived: 0, palletsRequested: 0, palletsDone: 0, scheduled: 0, delayed: 0, delaySec: 0, waitOverIn: 0, waitOverOut: 0,
    checked: 0, damaged: 0, damagedCartons: 0, wholeTriage: 0, triageOverflow: 0,
  };
  /** pools por tipo de equipamento (empilhadeira = this.forklifts) */
  readonly eqPools: Record<EquipmentKind, Pool<Agent>>;
  /** posições de stage (uma por palete de capacidade); null = layout sem stage (sem limite) */
  stageSlots: Pool<PoolItem> | null = null;
  stageInUse = 0;
  stageMax = 0;
  readonly stageWait: number[] = [];
  readonly checkCycle: number[] = [];
  /** espaço dos endereços transitórios por rua (uma posição por palete de capacidade) */
  transitPools = new Map<string, Pool<PoolItem & { area: AreaRT }>>();
  transitInUse = 0;
  transitMax = 0;
  readonly transitWait: number[] = [];
  phased = 0;
  stored = 0;
  /** AMR: bateria (s de trabalho desde a última carga completa) e ciclo de carga em andamento */
  private amrState = new Map<number, { batt: number; cycling: boolean }>();
  private chargerSlots: Pool<PoolItem> | null = null;
  private amrCharges = 0;
  private amrChargeSec = 0;
  rngDmg: Rng;
  skuCartons: number[] = [];
  /** estatísticas por tipo de veículo (índice = posição em effectiveVehicles) */
  private vStats: { name: string; n: number; dockSec: number; waitSec: number }[] = [];
  private vStatsOut: { name: string; n: number; dockSec: number; waitSec: number }[] = [];
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
  rngSvc: Rng;
  rngRoute: Rng;
  private rngVeh: Rng;
  private rngDelay: Rng;
  private vehIn: VehicleType[];
  private vehOut: VehicleType[];
  private skuW: number[];
  skuCls: (0 | 1 | 2)[];
  private truckSeq = 0;
  private pickBands: RackRT[][];
  /** posições de picking por classe (A, B, C): nível mais baixo das faces de picking */
  private pickPos: PickPos[][] = [[], [], []];
  private aisleInfo = new Map<string, AisleInfo>();
  private emptyAddr = new Set<string>();
  private readonly pickPalletTimes: number[] = [];
  private readonly pickRouteU: number[] = [];
  private readonly pickRouteZ: number[] = [];
  private pickPallets = 0;
  private pickBoxes = 0;
  private pickStockouts = 0;
  private pickStockoutSec = 0;
  rngPick: Rng;
  /** paletes prontos no stage de expedição (carga do caminhão a partir do stage) */
  /** travas de acesso ao baú: uma por doca (um equipamento por vez dentro do veículo) */
  private trailerLocks = new Map<DockItem, Pool<PoolItem>>();
  private readonly lockWait: number[] = [];
  /** equipamentos dentro de cada veículo agora e o máximo simultâneo observado (só para verificação) */
  private insideNow = new Map<DockItem, number>();
  maxInside = 0;
  private pickBusySec = 0;
  readonly stageOutStore: Store<StageToken>;
  private loadFormLock: Pool<PoolItem>;
  /** processos personalizados de separação, palete full e expedição (o primeiro da lista de cada tipo) */
  private customOrder?: ProcessDef;
  private customFull?: ProcessDef;
  private customLoad?: ProcessDef;
  private expSteps: ExpStep[] = [];
  private readonly loadReady: number[] = [];
  private readonly expSpan: Record<'conference' | 'reconcile' | 'customize' | 'board' | 'close', number[]> = { conference: [], reconcile: [], customize: [], board: [], close: [] };
  private expLoads = 0;
  private expDivergent = 0;
  private expCustomized = 0;
  stageOutSlots: Pool<PoolItem> | null = null;
  private stageOutInUse = 0;
  private stageOutMax = 0;
  private readonly expeditionWait: number[] = [];
  private readonly fullOrderTimes: number[] = [];
  private fullOrders = 0;
  private fullPallets = 0;
  private fullNoStock = 0;
  /** endereços da área de picking personalizada que não existem no layout */
  unmatchedPickAddresses = 0;

  constructor(readonly sc: Scenario, layout: Layout, seed: number, readonly tracer?: Tracer, world?: World) {
    const root = new Rng(seed);
    this.rngArr = root.fork('arrivals');
    this.rngSvc = root.fork('service');
    this.rngRoute = root.fork('routing');
    this.rngVeh = root.fork('vehicles');
    this.rngDelay = root.fork('delay');
    this.rngDmg = root.fork('damage');
    this.rngPick = root.fork('picking');
    this.vehIn = effectiveVehicles(sc, 'in');
    this.vehOut = effectiveVehicles(sc, 'out');
    this.vStats = this.vehIn.map((v) => ({ name: v.name, n: 0, dockSec: 0, waitSec: 0 }));
    this.vStatsOut = this.vehOut.map((v) => ({ name: v.name, n: 0, dockSec: 0, waitSec: 0 }));
    this.world = world ?? buildWorld(layout, sc);
    this.horizon = sc.days * sc.shiftHours * 3600;
    this.warm = Math.min(sc.warmupHours * 3600, this.horizon * 0.5);
    const w = this.world;
    const sim = this.sim;

    // ---- frota ----
    const mk = (kind: Agent['kind'], n: number, spec: FleetSpec, idBase: number, eq?: EquipmentKind): Pool<Agent> => {
      const items: Agent[] = [];
      const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      for (let i = 0; i < n; i++) {
        const a: Agent = {
          id: idBase + i, kind, eq, x: w.home.x + (i % cols) * 1.6, z: w.home.z + Math.floor(i / cols) * 1.6,
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
    this.forklifts.items.forEach((a) => (a.eq = 'forklift'));
    this.eqPools = {
      forklift: this.forklifts,
      palletJack: mk('mover', 0, sc.forklifts, 0, 'palletJack'),
      palletTruck: mk('mover', 0, sc.forklifts, 0, 'palletTruck'),
      amr: mk('mover', 0, sc.forklifts, 0, 'amr'),
    };
    sc.equipment.forEach((e, k) => {
      if (e.count > 0) this.eqPools[e.kind] = mk('mover', e.count, e, 3000 + 100 * k, e.kind);
    });
    for (const p of [this.forklifts, this.workers, this.checkers, this.eqPools.palletJack, this.eqPools.palletTruck, this.eqPools.amr]) p.statsFrom = this.warm;
    this.setupAmr();
    for (const [aisle, areas] of w.transitsByAisle) {
      const slots: (PoolItem & { area: AreaRT })[] = [];
      for (const a of areas) for (let i = 0; i < a.capacity; i++) slots.push({ id: slots.length, x: a.pt.x, z: a.pt.z, busy: false, busyTime: 0, busySince: 0, downTime: 0, area: a });
      const p = new Pool(sim, slots);
      p.statsFrom = this.warm;
      this.transitPools.set(aisle, p);
    }
    if (w.stages.length) {
      const slots: PoolItem[] = [];
      for (const st of w.stages) for (let i = 0; i < st.capacity; i++) slots.push({ id: slots.length, x: st.pt.x, z: st.pt.z, busy: false, busyTime: 0, busySince: 0, downTime: 0 });
      this.stageSlots = new Pool(sim, slots);
      this.stageSlots.statsFrom = this.warm;
    }
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
    this.skuCartons = skus.map((s) => Math.max(1, Math.round(s.cartonsPerPallet)));
    this.skuCls = skus.map((s) => (s.cls === 'A' ? 0 : s.cls === 'B' ? 1 : 2));
    const sorted = [...w.pickRacks].sort((a, b) => a.rank - b.rank);
    const n = sorted.length;
    this.pickBands = [sorted.slice(0, Math.max(1, Math.round(n * 0.34))), sorted.slice(Math.round(n * 0.2), Math.max(Math.round(n * 0.6), 1) + 1), sorted];
    if (!this.pickBands[1].length) this.pickBands[1] = sorted;
    this.stageOutStore = new Store<StageToken>(this.sim);
    const loadItem: PoolItem = { id: 0, x: 0, z: 0, busy: false, busyTime: 0, busySince: 0, downTime: 0 };
    this.loadFormLock = new Pool<PoolItem>(this.sim, [loadItem]);
    if (sc.useCustomProcesses) {
      this.customOrder = sc.processes.find((p) => p.trigger === 'order');
      this.customFull = sc.processes.find((p) => p.trigger === 'fullOrder');
      this.customLoad = sc.processes.find((p) => p.trigger === 'outLoad');
    }
    this.expSteps = sc.expedition.mode === 'basic' || this.customLoad ? [] : effectiveSteps(sc.expedition);
    if (this.usesStageOut && w.stagesOut.length) {
      const slots: PoolItem[] = [];
      for (const st of w.stagesOut) for (let i = 0; i < st.capacity; i++) slots.push({ id: slots.length, x: st.pt.x, z: st.pt.z, busy: false, busyTime: 0, busySince: 0, downTime: 0 });
      this.stageOutSlots = new Pool(this.sim, slots);
      this.stageOutSlots.statsFrom = this.warm;
    }
    if (sc.picking.mode === 'pallet' || this.customOrder) this.setupPicking();

    // ---- estoque inicial ----
    for (const r of w.racks) {
      const f = sc.initialOccupancy * (0.9 + 0.2 * this.rngRoute.next());
      const n = Math.min(r.capacity, Math.round(r.capacity * f));
      for (let i = 0; i < n; i++) {
        const s = findSlot(r, SLOT_FREE, this.rngRoute.int(r.slots.length));
        r.slots[s] = SLOT_OCCUPIED;
        r.stock++;
        r.occupied++;
      }
    }

    // ---- processos ----
    const startFail = (pool: Pool<Agent>, avail: number) => {
      if (avail >= 0.999 || avail <= 0) return;
      const mtbf = (MTTR * avail) / (1 - avail);
      const rng = root.fork('fail' + (pool.items[0]?.eq ?? pool.items[0]?.kind));
      for (const it of pool.items) {
        sim.spawn(function* () {
          for (;;) {
            yield rng.exp(mtbf);
            yield pool.fail(it, rng.exp(MTTR)); // espera o retorno antes de sortear a próxima falha
          }
        });
      }
    };
    startFail(this.forklifts, sc.forklifts.availability);
    startFail(this.workers, sc.workers.availability);
    startFail(this.checkers, sc.checkers.availability);
    for (const e of sc.equipment) startFail(this.eqPools[e.kind], e.availability);

    sim.spawn(this.vehicleArrivals(sc.arrivalsIn, sc.inboundTrucksPerHour, () => this.inboundTruck()));
    sim.spawn(this.vehicleArrivals(sc.arrivalsOut, sc.outboundTrucksPerHour, () => this.outboundTruck()));
    if (sc.picking.full.ordersPerHour > 0) sim.spawn(this.arrivals(new Array(24).fill(sc.picking.full.ordersPerHour), () => this.orderFull()));
    this.startBreaks();
    this.startTriageClearing();
    sim.spawn(this.arrivals(sc.ordersPerHour, () => (sc.picking.mode === 'pallet' || this.customOrder ? this.orderPallet() : this.order())));
    sim.spawn(this.sampler());
  }

  /* ---------------- utilidades ---------------- */

  go(ag: Agent, to: Pt, carrying: boolean): number {
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

  sum(d: Scenario['ops']['pickCarton'], n: number): number {
    const k = Math.min(n, 25);
    let s = 0;
    for (let i = 0; i < k; i++) s += sampleDist(this.rngSvc, d);
    return n > k ? (s / k) * n : s;
  }

  get measuring() {
    return this.sim.now >= this.warm;
  }

  hourBucket() {
    const h = Math.floor(this.sim.now / 3600);
    while (this.hourCounts.length <= h) this.hourCounts.push({ in: 0, out: 0, ord: 0 });
    return this.hourCounts[h];
  }

  pickSku(): { idx: number; cls: 0 | 1 | 2 } {
    const i = this.rngRoute.pick(this.skuW);
    return { idx: i, cls: this.skuCls[i] };
  }

  /** endereçamento de guarda (putaway) */
  chooseRackPut(cls: 0 | 1 | 2, from: Pt): RackRT | null {
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

  chooseRackGet(cls: 0 | 1 | 2): RackRT | null {
    const w = this.world;
    let cands = w.zones[cls].filter((r) => r.occupied > 0);
    if (!cands.length || this.sc.slotting === 'random') cands = w.racks.filter((r) => r.occupied > 0);
    if (!cands.length) return null;
    return cands[this.rngRoute.pick(cands.map((r) => r.occupied))];
  }

  /** reserva uma posição livre do rack (palete a caminho); devolve o índice da posição */
  reserveSlot(r: RackRT): number {
    const i = findSlot(r, SLOT_FREE, this.rngRoute.int(r.slots.length));
    r.slots[i] = SLOT_RESERVED;
    r.stock++;
    return i;
  }

  /** retira (libera) uma posição ocupada do rack; devolve o índice da posição */
  takeSlot(r: RackRT): number {
    const i = findSlot(r, SLOT_OCCUPIED, this.rngRoute.int(r.slots.length));
    r.slots[i] = SLOT_FREE;
    r.stock--;
    r.occupied--;
    return i;
  }

  liftTime(level0: number): number {
    const h = level0 * this.sc.levelHeight;
    return (2 * h) / Math.max(0.05, this.sc.liftSpeed) + sampleDist(this.rngSvc, this.sc.ops.putawayPosition);
  }

  accessPoint(r: RackRT, bay = this.rngRoute.int(r.bays), side: 0 | 1 = this.rngRoute.int(2) as 0 | 1): Pt {
    return r.access[bay][side];
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

  /** gera chegadas de veículos conforme o modo: aleatório por hora, intervalo fixo ou agenda (com atrasos) */
  private vehicleArrivals(spec: ArrivalSpec, rates: number[], make: () => Process): () => Process {
    if (spec.mode === 'poisson') return this.arrivals(rates, make);
    const self = this;
    const sc = this.sc;
    const horizon = this.horizon;
    // instantes nominais (s) das chegadas
    const times: number[] = [];
    if (spec.mode === 'fixed') {
      const step = (Math.max(0.1, spec.intervalMin) * 60) / Math.max(0.01, sc.demandFactor);
      for (let t = 0; t < horizon; t += step) times.push(t);
    } else {
      const hours = [...spec.scheduleHours].sort((a, b) => a - b);
      for (let d = 0; d < sc.days; d++)
        for (const h of hours) {
          const off = offsetInShift(sc, h);
          if (off !== null) times.push(d * sc.shiftHours * 3600 + off);
        }
    }
    const delayed = function* (): Process {
      self.c.scheduled++;
      if (spec.delayProb > 0 && self.rngDelay.next() < spec.delayProb) {
        const d = Math.max(0, sampleDist(self.rngDelay, spec.delayMin)) * 60;
        if (self.sim.now >= self.warm) {
          self.c.delayed++;
          self.c.delaySec += d;
        }
        yield d;
      }
      yield* make();
    };
    return function* () {
      for (const t of times) {
        yield Math.max(0, t - self.sim.now);
        self.sim.spawn(delayed());
      }
    };
  }

  private pickVehicle(list: VehicleType[], dir: 'in' | 'out'): { idx: number; v: VehicleType } {
    if (list.length === 1) return { idx: 0, v: list[0] };
    const idx = this.rngVeh.pick(list.map((v) => shareFor(v, dir)));
    return { idx, v: list[idx] };
  }

  /** intervalos das pessoas: cada recurso do grupo para na sua onda, a cada dia, via parada programada */
  private startBreaks() {
    const sc = this.sc;
    const sim = this.sim;
    const amrBreaks = !sc.calendar.amrWorksDuringBreaks;
    const poolsOf = (role: PeopleRole): Pool<Agent>[] =>
      role === 'forklift' ? [this.forklifts] : role === 'worker' ? [this.workers] : role === 'checker' ? [this.checkers]
        : [this.eqPools.palletJack, this.eqPools.palletTruck, ...(amrBreaks ? [this.eqPools.amr] : [])];
    for (const b of sc.calendar.breaks) {
      const off = offsetInShift(sc, b.startHour);
      if (off === null || b.durationMin <= 0) continue;
      for (const role of PEOPLE_ROLES) {
        if (!b.groups.includes(role)) continue;
        const members = poolsOf(role).flatMap((pool) => pool.items.map((it) => ({ pool, it })));
        members.forEach(({ pool, it }, i) => {
          const wave = waveOf(b, i, members.length);
          sim.spawn(function* () {
            for (let d = 0; d < sc.days; d++) {
              const t = d * sc.shiftHours * 3600 + off + wave * b.durationMin * 60;
              yield Math.max(0, t - sim.now);
              yield pool.fail(it, b.durationMin * 60);
            }
          });
        });
      }
    }
  }

  /** paletes de um veículo: normal(média, desvio) limitada pela capacidade do baú */
  private palletsPerTruck(spec: Scenario['palletsPerTruckIn'], capacity: number): number {
    const n = Math.round(this.rngSvc.normal(spec.mean, spec.sd));
    return Math.min(Math.max(1, n), Math.max(1, Math.min(spec.max, capacity)));
  }

  private *inboundTruck(): Process {
    const id = ++this.truckSeq;
    const { idx: vi, v } = this.pickVehicle(this.vehIn, 'in');
    const tArr = this.sim.now;
    this.tracer?.truckQueued(id, 'in', tArr, { name: v.name, lengthM: v.trailerLengthM });
    const dock: DockItem = yield this.dockIn.request();
    const tDock = this.sim.now;
    this.tracer?.truckDocked(id, 'in', dock.idx, tDock);
    const turn = sampleDist(this.rngSvc, v.dockTurnover);
    if (tArr >= this.warm) {
      this.dockWaitIn.push((tDock - tArr) / 60);
      if ((tDock - tArr) / 60 > this.sc.dockWaitThresholdMin) this.c.waitOverIn++;
      const st = this.vStats[vi];
      st.n++;
      st.dockSec += turn;
      st.waitSec += tDock - tArr;
    }
    yield turn;
    const n = this.palletsPerTruck(v.pallets, v.capacityPallets);
    const unloaded = new Countdown(this.sim, n);
    const custom = this.sc.useCustomProcesses ? this.sc.processes.find((p) => p.trigger === 'unloadPallet') : undefined;
    const gate = this.sc.vehicleExclusive ? new VehicleGate(this.sim, n) : undefined;
    for (let i = 0; i < n; i++) this.sim.spawn(custom ? startPalletProcess(this, custom, dock, tDock, i, v.trailerLengthM, unloaded, gate) : this.inboundPallet(dock, unloaded, tDock, i, v.trailerLengthM, gate));
    yield unloaded.signal;
    this.dockIn.release(dock);
    this.tracer?.truckLeft(id, 'in', this.sim.now);
    if (tArr >= this.warm) {
      this.turnIn.push((this.sim.now - tArr) / 60);
      this.c.trucksIn++;
    }
  }

  /** escolhe, entre os pools permitidos, o que tem equipamento ocioso agora (senão o menos congestionado) */
  choosePool(pools: Pool<Agent>[]): Pool<Agent> {
    const ok = pools.filter((p) => p.items.length > 0);
    if (!ok.length) return this.forklifts;
    const idle = ok.find((p) => p.idleCount > 0);
    if (idle) return idle;
    return ok.reduce((b, p) => (p.queueLength / p.items.length < b.queueLength / b.items.length ? p : b));
  }

  private unloadPool(): Pool<Agent> {
    return this.choosePool(this.sc.receiving.unloadWith.map((k) => this.eqPools[k]));
  }

  /** transporte do palete de avarias: paleteira / transpaleteira / AMR; sem nenhum deles, a empilhadeira */
  private moverPool(): Pool<Agent> {
    return this.choosePool([this.eqPools.palletJack, this.eqPools.palletTruck, this.eqPools.amr]);
  }

  /** pega um equipamento; a paleteira manual leva junto um operário do pool de operários (sem operários cadastrados, vai sozinha) */
  *takeEq(pool: Pool<Agent>, near: Pt): Generator<any, Agent, any> {
    const ag: Agent = yield pool.request(near);
    if (ag.eq === 'palletJack' && this.workers.items.length > 0) {
      const wk: Agent = yield this.workers.request(near);
      ag.operator = wk;
    }
    return ag;
  }

  giveEq(pool: Pool<Agent>, ag: Agent) {
    const wk = ag.operator;
    if (wk) {
      wk.x = ag.x;
      wk.z = ag.z;
      ag.operator = undefined;
      this.workers.release(wk);
    }
    pool.release(ag);
  }

  /** trabalho dentro do veículo: entrar, manusear e sair; com exclusividade, um equipamento por vez por veículo */
  *inVehicle(dock: DockItem, ag: Agent, depthM: number, handling: number, measured = true, gate?: VehicleGate, idx = 0): Process {
    if (!this.sc.vehicleExclusive) {
      yield this.inTrailer(ag, depthM);
      yield handling;
      return;
    }
    let lock = this.trailerLocks.get(dock);
    if (!lock) {
      const item: PoolItem = { id: 0, x: dock.inner.x, z: dock.inner.z, busy: false, busyTime: 0, busySince: 0, downTime: 0 };
      lock = new Pool<PoolItem>(this.sim, [item]);
      this.trailerLocks.set(dock, lock);
    }
    const t0 = this.sim.now;
    const it: PoolItem = yield lock.request();
    this.insideNow.set(dock, (this.insideNow.get(dock) ?? 0) + 1);
    this.maxInside = Math.max(this.maxInside, this.insideNow.get(dock)!);
    gate?.entered(idx); // entrou: o próximo palete já pode pedir equipamento
    if (measured && this.sim.now >= this.warm) this.lockWait.push((this.sim.now - t0) / 60);
    yield this.inTrailer(ag, depthM);
    yield handling;
    this.insideNow.set(dock, this.insideNow.get(dock)! - 1);
    lock.release(it);
  }

  /** movimentação dentro do baú (ida vazio, volta carregado) conforme a profundidade do palete */
  inTrailer(ag: Agent, d: number): number {
    if (d <= 0) return 0;
    if (this.sim.now >= this.warm) ag.km += (2 * d) / 1000;
    return travelTime(d, ag.speedEmpty, this.sc.accel) + travelTime(d, ag.speedLoaded, this.sc.accel);
  }

  /** área de triagem: a primeira por prioridade com espaço; se todas lotadas, estoura na última */
  chooseTriage(): { area: AreaRT | null; overflow: boolean } {
    const ts = this.world.triages;
    if (!ts.length) return { area: null, overflow: true };
    const free = ts.find((t) => t.occupied < t.capacity);
    return free ? { area: free, overflow: false } : { area: ts[ts.length - 1], overflow: true };
  }

  /** leva um palete de avarias do stage até a área de triagem (liberando o espaço do stage na retirada) */
  private *triageTransport(from: Pt, slot: PoolItem | undefined, measured: boolean): Process {
    const pool = this.moverPool();
    const mv: Agent = yield* this.takeEq(pool, from);
    yield this.go(mv, from, false);
    if (slot && this.stageSlots) {
      this.stageSlots.release(slot);
      this.stageInUse--;
    }
    const { area, overflow } = this.chooseTriage();
    if (overflow && measured) this.c.triageOverflow++;
    if (area) {
      yield this.go(mv, area.pt, true);
      if (!overflow) area.occupied++; // excedente é contabilizado como estouro, sem inflar a ocupação
    }
    mv.tasks++;
    this.giveEq(pool, mv);
  }

  /**
   * AMR: a bateria desgasta com o tempo de trabalho. Ao consumir a fração configurada da autonomia (padrão 1/2),
   * o AMR termina a tarefa em curso, vai à estação de carga, carrega e faz o setup. Também carrega nos horários
   * do calendário (início/fim de turno e horários específicos).
   */
  private setupAmr() {
    const sc = this.sc;
    const spec = sc.equipment.find((e) => e.kind === 'amr');
    const pool = this.eqPools.amr;
    if (!spec?.amr || !pool.items.length) return;
    const a = spec.amr;
    if (this.world.chargers.length) {
      const slots: PoolItem[] = [];
      for (const ch of this.world.chargers) for (let i = 0; i < ch.capacity; i++) slots.push({ id: slots.length, x: ch.pt.x, z: ch.pt.z, busy: false, busyTime: 0, busySince: 0, downTime: 0 });
      this.chargerSlots = new Pool(this.sim, slots);
      this.chargerSlots.statsFrom = this.warm;
    }
    for (const it of pool.items) this.amrState.set(it.id, { batt: 0, cycling: false });
    const limit = a.chargeTriggerFraction * a.autonomyMin * 60;
    pool.onRelease = (it, dur) => {
      const st = this.amrState.get(it.id)!;
      st.batt += dur;
      if (st.batt >= limit && !st.cycling) {
        this.sim.spawn(this.chargeCycle(it, true));
        return true; // retido: só volta ao serviço depois de carregar
      }
      return false;
    };
    // calendário de carga: horários do dia (início/fim de turno e específicos), todos os dias
    const self = this;
    for (const h of amrChargeHours(sc, a)) {
      const off = (((h - sc.startHour) % 24) + 24) % 24 * 3600;
      if (off > sc.shiftHours * 3600) continue;
      for (const it of pool.items)
        this.sim.spawn(function* () {
          for (let d = 0; d < sc.days; d++) {
            yield Math.max(0, d * sc.shiftHours * 3600 + off - self.sim.now);
            const st = self.amrState.get(it.id)!;
            if (!st.cycling && st.batt > 0) self.sim.spawn(self.chargeCycle(it, false)); // já carregado: nada a fazer
          }
        });
    }
  }

  private *chargeCycle(it: Agent, held: boolean): Process {
    const a = this.sc.equipment.find((e) => e.kind === 'amr')!.amr!;
    const st = this.amrState.get(it.id)!;
    st.cycling = true;
    const pool = this.eqPools.amr;
    if (!held) yield pool.hold(it); // termina a tarefa em curso e só então para
    const t0 = this.sim.now;
    if (this.chargerSlots) {
      const slot: PoolItem = yield this.chargerSlots.request(it); // fila se todas as vagas estiverem ocupadas
      yield this.go(it, { x: slot.x, z: slot.z }, false);
      yield a.chargeMin * 60;
      yield a.setupMin * 60;
      this.chargerSlots.release(slot);
    } else {
      yield (a.chargeMin + a.setupMin) * 60; // sem estação no layout: carrega onde está
    }
    st.batt = 0;
    st.cycling = false;
    if (t0 >= this.warm) {
      this.amrCharges++;
      this.amrChargeSec += this.sim.now - t0;
    }
    pool.resume(it);
  }

  /** @internal só para testes: ocupação dos pools de endereços transitórios */
  transitPoolsForTest(): { size: number; busyCount: number }[] {
    return [...this.transitPools.values()].map((p) => ({ size: p.items.length, busyCount: p.items.filter((i) => i.busy).length }));
  }

  /** coleta/descarte periódico das áreas de triagem */
  private startTriageClearing() {
    const every = this.sc.receiving.triageClearEveryHours * 3600;
    if (every <= 0 || !this.world.triages.length) return;
    const self = this;
    this.sim.spawn(function* () {
      for (;;) {
        yield every;
        for (const t of self.world.triages) t.occupied = 0;
      }
    });
  }

  private *inboundPallet(dock: DockItem, unloaded: Countdown, tDock: number, idx: number, trailerM: number, gate?: VehicleGate): Process {
    const sc = this.sc;
    const c = this.c;
    const rcv = sc.receiving;
    const sk = this.pickSku();
    const cls = sk.cls;
    const measured = tDock >= this.warm;
    c.palletsRequested++;
    if (measured) c.inReq++;
    const staged = sc.checkers.count > 0;

    // 1) reserva espaço no stage ANTES de pegar equipamento (evita travar a frota segurando paletes)
    let stageSlot: PoolItem | undefined;
    if (staged && this.stageSlots) {
      const t0 = this.sim.now;
      stageSlot = yield this.stageSlots.request(dock.inner);
      if (measured) this.stageWait.push((this.sim.now - t0) / 60);
      this.stageInUse++;
      this.stageMax = Math.max(this.stageMax, this.stageInUse);
    }

    // 2) descarga com o equipamento disponível; distância dentro do baú conforme o veículo
    const eqPool = this.unloadPool();
    const turn = gate?.before(idx);
    if (turn) yield turn; // vez no veículo: só pede equipamento quando o palete anterior já entrou
    let eq: Agent = yield* this.takeEq(eqPool, dock.inner);
    yield this.go(eq, dock.inner, false);
    yield* this.inVehicle(dock, eq, rcv.trailerDepth ? trailerDepthM(idx, trailerM) : 0, sampleDist(this.rngSvc, sc.ops.unloadPallet), measured, gate, idx);
    unloaded.tick();

    let from: Pt = dock.inner;
    let held: Agent | undefined; // empilhadeira que já está com o palete (descarga direta, sem conferência e sem faseada)
    if (staged) {
      // 3) deixa o palete no stage; o conferente confere e (se houver avaria) faz a triagem
      const stage: Pt = stageSlot ? { x: stageSlot.x, z: stageSlot.z } : { x: dock.inner.x, z: dock.inner.z - 2.5 };
      from = stage;
      yield this.go(eq, stage, true);
      this.giveEq(eqPool, eq);
      const tCheck0 = this.sim.now;
      const ck: Agent = yield this.checkers.request(stage);
      yield this.go(ck, stage, false);
      const damaged = this.rngDmg.next() < rcv.damagePalletPct;
      let checkT = sampleDist(this.rngSvc, sc.ops.checkPallet);
      let nBad = 0;
      let whole = false;
      const cartons = this.skuCartons[sk.idx] ?? 1;
      if (damaged) {
        checkT *= Math.max(1, rcv.damagedCheckFactor);
        const frac = Math.min(1, Math.max(0, sampleDist(this.rngDmg, rcv.damagedCartonsFraction)));
        nBad = Math.min(cartons, Math.max(1, Math.round(frac * cartons)));
        whole = nBad >= cartons;
        if (!whole) checkT += this.sum(sc.ops.triageCarton, nBad); // repaletiza as caixas avariadas em um segundo palete
      }
      yield checkT;
      this.checkers.release(ck);
      if (measured) {
        c.checked++;
        this.checkCycle.push((this.sim.now - tCheck0) / 60);
        if (damaged) {
          c.damaged++;
          c.damagedCartons += nBad;
          if (whole) c.wholeTriage++;
        }
      }
      if (damaged && whole) {
        // sem nenhuma caixa boa: o palete inteiro vai para a triagem
        yield* this.triageTransport(stage, stageSlot, measured);
        c.palletsDone++;
        return;
      }
      if (damaged) this.sim.spawn(this.triageTransport(stage, undefined, measured)); // 2º palete só com as avariadas
    } else if (eqPool === this.forklifts && sc.storage.mode === 'direct') {
      held = eq; // sem conferência e armazenagem direta: a própria empilhadeira segue para a guarda
    } else {
      // equipamento sem elevação (ou armazenagem faseada): deixa o palete na doca
      this.giveEq(eqPool, eq);
    }
    yield* this.storePallet(from, cls, tDock, measured, held, stageSlot);
  }

  /** endereça (reserva a posição) e guarda o palete: direta (empilhadeira) ou faseada (etapa 1 até a rua + etapa 2 elevação) */
  private *storePallet(from: Pt, cls: 0 | 1 | 2, tDock: number, measured: boolean, held: Agent | undefined, stageSlot: PoolItem | undefined): Process {
    const c = this.c;
    const releaseStage = () => {
      if (stageSlot && this.stageSlots) {
        this.stageSlots.release(stageSlot);
        this.stageInUse--;
      }
    };
    const rack = this.chooseRackPut(cls, from);
    if (!rack) {
      if (measured) c.overflow++;
      c.palletsDone++;
      releaseStage();
      if (held) this.forklifts.release(held);
      return;
    }
    const slot = this.reserveSlot(rack); // o destino (endereço completo, com a rua) é definido aqui
    const addr = slotAddr(rack, slot);
    const side = slotSide(rack, slot);
    const ap = this.accessPoint(rack, addr.bay, side);
    let fk: Agent;
    let viaTransit = false;
    const aisle = rack.faceAisle[side];
    const tpool = aisle ? this.transitPools.get(aisle) : undefined;
    if (this.sc.storage.mode === 'phased' && !held) {
      // etapa 1: equipamento sem elevação leva o palete até um endereço transitório da rua do destino
      let tslot: (PoolItem & { area: AreaRT }) | undefined;
      if (tpool) {
        const t0 = this.sim.now; // rua cheia: a etapa 1 espera até liberar espaço (reserva antes de pegar equipamento)
        tslot = yield tpool.request(from);
        if (measured) this.transitWait.push((this.sim.now - t0) / 60);
        this.transitInUse++;
        this.transitMax = Math.max(this.transitMax, this.transitInUse);
      }
      const step1 = this.step1Pool();
      const mv: Agent = yield* this.takeEq(step1, from);
      yield this.go(mv, from, false);
      releaseStage();
      const drop: Pt = tslot ? { x: tslot.x, z: tslot.z } : ap;
      yield this.go(mv, drop, true);
      mv.tasks++;
      this.giveEq(step1, mv);
      // etapa 2: a empilhadeira recebe o destino final, pega o palete na rua e faz a elevação
      fk = yield this.forklifts.request(drop);
      yield this.go(fk, drop, false);
      if (tslot && tpool) {
        tpool.release(tslot);
        this.transitInUse--;
      }
      viaTransit = true;
    } else if (held) {
      fk = held;
    } else {
      fk = yield this.forklifts.request(from);
      yield this.go(fk, from, false);
      releaseStage();
    }
    yield this.go(fk, ap, true);
    yield this.liftTime(addr.level);
    rack.slots[slot] = SLOT_OCCUPIED;
    rack.occupied++;
    fk.tasks++;
    this.forklifts.release(fk);
    c.palletsDone++;
    if (this.measuring) {
      c.palletsIn++;
      this.hourBucket().in++;
    }
    if (measured) {
      this.stored++;
      if (viaTransit) this.phased++; // conta na conclusão, junto com os guardados (a fração nunca passa de 100%)
      this.putawayLead.push((this.sim.now - tDock) / 60);
    }
  }

  /** etapa 1 da armazenagem faseada: equipamento sem elevação disponível (sem nenhum, a empilhadeira) */
  private step1Pool(): Pool<Agent> {
    return this.choosePool(this.sc.storage.step1With.filter((k) => k !== 'forklift').map((k) => this.eqPools[k]));
  }

  private *outboundTruck(): Process {
    const id = ++this.truckSeq;
    const { idx: vo, v } = this.pickVehicle(this.vehOut, 'out');
    const tArr = this.sim.now;
    this.tracer?.truckQueued(id, 'out', tArr, { name: v.name, lengthM: v.trailerLengthM });
    const dock: DockItem = yield this.dockOut.request();
    const tDock = this.sim.now;
    this.tracer?.truckDocked(id, 'out', dock.idx, tDock);
    if (tArr >= this.warm) {
      this.dockWaitOut.push((tDock - tArr) / 60);
      if ((tDock - tArr) / 60 > this.sc.dockWaitThresholdMin) this.c.waitOverOut++;
    }
    const turnOut = sampleDist(this.rngSvc, v.dockTurnover);
    if (tArr >= this.warm) {
      const so = this.vStatsOut[vo];
      so.n++;
      so.dockSec += turnOut;
      so.waitSec += tDock - tArr;
    }
    yield turnOut;
    if (this.customLoad) {
      yield* this.runLoadProcess(this.customLoad, dock, tDock, v.trailerLengthM, this.customLoadSize(v));
    } else if (this.sc.expedition.mode !== 'basic') {
      yield* this.runExpedition(dock, tDock, v.trailerLengthM, loadPallets(this.sc, v));
    } else {
      const n = this.palletsPerTruck(v.pallets, v.capacityPallets);
      const loaded = new Countdown(this.sim, n);
      const gate = this.sc.vehicleExclusive ? new VehicleGate(this.sim, n) : undefined;
      for (let i = 0; i < n; i++) this.sim.spawn(this.outboundPallet(dock, loaded, tDock, i, n, v.trailerLengthM, gate));
      yield loaded.signal;
    }
    this.dockOut.release(dock);
    this.tracer?.truckLeft(id, 'out', this.sim.now);
    if (tArr >= this.warm) {
      this.turnOut.push((this.sim.now - tArr) / 60);
      this.c.trucksOut++;
    }
  }

  private *outboundPallet(dock: DockItem, loaded: Countdown, tDock: number, idx: number, n: number, trailerM: number, gate?: VehicleGate): Process {
    if (this.loadsFromStage) {
      yield* this.outboundFromStage(dock, loaded, tDock, idx, n, trailerM, gate);
      return;
    }
    const c = this.c;
    if (tDock >= this.warm) c.outReq++;
    const cls = this.pickSku().cls;
    const rack = this.chooseRackGet(cls);
    if (!rack) {
      if (tDock >= this.warm) c.stockouts++;
      gate?.entered(idx); // não entra no veículo: libera a vez do próximo
      loaded.tick();
      return;
    }
    const outIdx = this.takeSlot(rack);
    const addr = slotAddr(rack, outIdx);
    c.palletsRequested++;
    const ap = this.accessPoint(rack, addr.bay, slotSide(rack, outIdx));
    const turnL = gate?.before(idx);
    if (turnL) yield turnL;
    const fk: Agent = yield this.forklifts.request(ap);
    yield this.go(fk, ap, false);
    yield this.liftTime(addr.level);
    yield this.go(fk, dock.inner, true);
    yield* this.inVehicle(dock, fk, this.sc.receiving.trailerDepth ? trailerDepthM(n - 1 - idx, trailerM) : 0, sampleDist(this.rngSvc, this.sc.ops.loadPallet), tDock >= this.warm, gate, idx);
    fk.tasks++;
    this.forklifts.release(fk);
    loaded.tick();
    c.palletsDone++;
    if (this.measuring) {
      c.palletsOut++;
      this.hourBucket().out++;
    }
  }

  /** posições de picking (nível mais baixo) e ruas, com o endereço de cada uma */
  private setupPicking() {
    const r = buildPickPositions(this.world, this.sc);
    this.aisleInfo = r.aisleInfo;
    this.pickPos = r.pickPos;
    this.unmatchedPickAddresses = r.unmatched;
    this.emptyAddr = new Set(this.sc.picking.stockout.addresses);
  }

  /** a carga do caminhão sai do stage de expedição (carga a partir do stage ou expedição por etapas) */
  private get loadsFromStage(): boolean {
    return this.sc.picking.loadFrom === 'stage' || !!this.customOrder || !!this.customFull;
  }

  private get usesStageOut(): boolean {
    return this.loadsFromStage || this.sc.expedition.mode !== 'basic' || !!this.customLoad;
  }

  /** ponto do stage de expedição (ou, na falta, a doca de saída / ponto base) */
  get stageOutPt(): Pt {
    const w = this.world;
    return w.stagesOut[0]?.pt ?? w.docksOut[0]?.inner ?? w.home;
  }

  private pickTravel(order: Stop[], wk: { speedEmpty: number; speedLoaded: number }, from: Pt, back: Pt): number {
    const tt = (d: number, loaded: boolean) => travelTime(d, loaded ? wk.speedLoaded : wk.speedEmpty, this.sc.accel);
    return routeTravelSec(order, from, back, (a, b) => this.world.nav.distance(a, b), tt);
  }

  /** pedido de picking: com processo personalizado, o pedido percorre os blocos; senão, a separação padrão */
  private *orderPallet(): Process {
    const tArr = this.sim.now;
    if (this.customOrder) {
      this.c.ordersArrived++;
      yield* runProcess(this, this.customOrder, auxLoad(this, 'carton', 1, 0, undefined, tArr >= this.warm));
      return;
    }
    yield* this.pickOrderCore(this.sc.picking, tArr);
  }

  /** caixas por pedido e % A/B/C definidos pelo usuário; o pedido é dividido entre os separadores por rua */
  *pickOrderCore(pk: PickRouteParams, tArr: number, counted = false): Process {
    const sc = this.sc;
    const c = this.c;
    if (!counted && !this.customOrder) c.ordersArrived++;
    const boxes = Math.max(1, Math.round(this.rngPick.normal(pk.boxesPerOrder.mean, pk.boxesPerOrder.sd)));
    const tot = Math.max(1e-9, pk.abc.a + pk.abc.b + pk.abc.c);
    const weights = [pk.abc.a / tot, pk.abc.b / tot, pk.abc.c / tot];
    const stops: Stop[] = [];
    let left = boxes;
    while (left > 0) {
      const k = Math.min(left, Math.max(1, Math.round(this.rngPick.lognormal(sc.cartonsPerLine.mean, sc.cartonsPerLine.sd))));
      const cls = this.rngPick.pick(weights);
      const list = this.pickPos[cls];
      const pos = list[this.rngPick.int(list.length)];
      this.world.nav.key(pos.pt); // campo de distância calculado uma vez por ponto
      stops.push({ pos, boxes: k });
      left -= k;
    }
    const stage = this.stageOutPt;
    this.world.nav.key(stage);
    const parts = splitAmongPickers(stops, pk.pickersPerOrder);
    const done = new Countdown(this.sim, parts.length);
    for (const part of parts) this.sim.spawn(this.pickerRoute(part, done, tArr, pk));
    yield done.signal;
    if (tArr >= this.warm) {
      this.orderCycle.push((this.sim.now - tArr) / 60);
      c.orders++;
      c.lines += stops.length;
      c.cartons += boxes;
    }
    if (this.measuring) this.hourBucket().ord++;
  }

  /** leva o palete ao stage de expedição (reservando espaço quando a carga é a partir do stage) e o deixa pronto */
  private *deliverPickPallet(wk: Agent, boxes: number): Process {
    let slot: PoolItem | undefined;
    if (this.stageOutSlots) slot = yield this.stageOutSlots.request({ x: wk.x, z: wk.z });
    yield this.go(wk, slot ? { x: slot.x, z: slot.z } : this.stageOutPt, true);
    this.stageOutArrive(slot, 'picking', boxes);
  }

  /** um palete pronto chegou ao stage de expedição; com conferência simultânea ele só fica disponível depois de conferido */
  stageOutArrive(slot: PoolItem | undefined, origin: 'picking' | 'full', boxes: number) {
    if (!this.usesStageOut) return;
    this.stageOutInUse++;
    this.stageOutMax = Math.max(this.stageOutMax, this.stageOutInUse);
    const tok: StageToken = { slot, origin, boxes };
    const conf = this.expSteps.find((s): s is ConferenceStep => s.type === 'conference');
    if (conf && conf.timing === 'simultaneous' && !this.customLoad) this.sim.spawn(this.conferAtStage(tok, conf));
    else this.stageOutStore.put(tok);
  }

  private tokenPt(tok: StageToken): Pt {
    return tok.slot ? { x: tok.slot.x, z: tok.slot.z } : this.stageOutPt;
  }

  /** tempo de conferência de um palete: fixo se for full, por caixa se for de picking */
  private conferTime(tok: StageToken, st: ConferenceStep): number {
    return tok.origin === 'full' ? sampleDist(this.rngSvc, st.fullTime) : this.sum(st.perBox, Math.max(1, tok.boxes));
  }

  /** conferência simultânea: o conferente confere o palete assim que ele chega ao stage, se estiver livre */
  private *conferAtStage(tok: StageToken, st: ConferenceStep): Process {
    yield* this.personTask(st.resource, this.tokenPt(tok), this.conferTime(tok, st));
    tok.checked = true;
    this.stageOutStore.put(tok);
  }

  /** uma pessoa (conferente ou operário) vai ao ponto e trabalha pelo tempo; sem pessoas cadastradas o tempo passa sem recurso */
  *personTask(res: ExpPerson, near: Pt, dur: number): Process {
    const pool = res === 'checker' ? this.checkers : this.workers;
    if (!pool.items.length) {
      yield dur;
      return;
    }
    const ag: Agent = yield pool.request(near);
    yield this.go(ag, near, false);
    yield dur;
    ag.tasks++;
    pool.release(ag);
  }

  /** conferência posterior (ou o que sobrou sem conferir): todos os paletes da carga, em paralelo conforme os conferentes livres */
  private *conferLoad(tokens: StageToken[], st: ConferenceStep): Process {
    const todo = tokens.filter((t) => !t.checked);
    const done = new Countdown(this.sim, todo.length);
    for (const tok of todo) {
      const self = this;
      this.sim.spawn(function* () {
        yield* self.personTask(st.resource, self.tokenPt(tok), self.conferTime(tok, st));
        tok.checked = true;
        done.tick();
      });
    }
    yield done.signal;
  }

  /** customização: k paletes (sorteados pelo % de picking da carga) são rearranjados por operários no stage */
  private *customizeLoad(n: number, st: CustomizeStep, measured: boolean): Process {
    let k = 0;
    for (let i = 0; i < n; i++) if (this.rngPick.next() < st.pickPct) k++;
    if (measured) this.expCustomized += k;
    const done = new Countdown(this.sim, k);
    for (let i = 0; i < k; i++) {
      const self = this;
      this.sim.spawn(function* () {
        yield* self.personTask(st.resource, self.stageOutPt, sampleDist(self.rngSvc, st.time));
        done.tick();
      });
    }
    yield done.signal;
  }

  /** batimento: o que foi separado é o que está no pedido? (com divergência, há tempo de correção) */
  private *reconcileLoad(st: ReconcileStep, measured: boolean): Process {
    yield* this.personTask(st.resource, this.stageOutPt, sampleDist(this.rngSvc, st.time));
    if (this.rngPick.next() < st.divergencePct) {
      if (measured) this.expDivergent++;
      yield* this.personTask(st.resource, this.stageOutPt, sampleDist(this.rngSvc, st.correctionTime));
    }
  }

  /** embarque: cada palete vai do stage ao interior do veículo (um equipamento por vez dentro; do fundo para a porta) */
  private *boardLoad(dock: DockItem, tokens: StageToken[], trailerM: number, st: BoardStep, tDock: number): Process {
    const n = tokens.length;
    const done = new Countdown(this.sim, n);
    const gate = this.sc.vehicleExclusive ? new VehicleGate(this.sim, n) : undefined;
    const kinds = st.with.length ? st.with : (['forklift'] as const);
    tokens.forEach((tok, i) => this.sim.spawn(this.boardPallet(dock, tok, i, n, trailerM, [...kinds], gate, tDock, done)));
    yield done.signal;
  }

  private *boardPallet(dock: DockItem, tok: StageToken, idx: number, n: number, trailerM: number, kinds: EquipmentKind[], gate: VehicleGate | undefined, tDock: number, done: Countdown): Process {
    const c = this.c;
    const pt = this.tokenPt(tok);
    const turn = gate?.before(idx);
    if (turn) yield turn;
    const pool = this.choosePool(kinds.map((k) => this.eqPools[k]));
    const ag: Agent = yield* this.takeEq(pool, pt);
    yield this.go(ag, pt, false);
    if (tok.slot && this.stageOutSlots) this.stageOutSlots.release(tok.slot);
    this.stageOutInUse--;
    yield this.go(ag, dock.inner, true);
    yield* this.inVehicle(dock, ag, this.sc.receiving.trailerDepth ? trailerDepthM(n - 1 - idx, trailerM) : 0, sampleDist(this.rngSvc, this.sc.ops.loadPallet), tDock >= this.warm, gate, idx);
    ag.tasks++;
    this.giveEq(pool, ag);
    c.palletsDone++;
    if (this.measuring) {
      c.palletsOut++;
      this.hourBucket().out++;
    }
    done.tick();
  }

  /** forma a carga: um caminhão por vez recolhe seus N paletes do stage de expedição (esperando a separação) */
  private *formLoad(n: number, measured: boolean): Generator<any, StageToken[], any> {
    const c = this.c;
    const t0 = this.sim.now;
    const lock: PoolItem = yield this.loadFormLock.request();
    const tokens: StageToken[] = [];
    for (let i = 0; i < n; i++) {
      const r = this.stageOutStore.take();
      yield r.signal;
      tokens.push(r.res.item!);
    }
    this.loadFormLock.release(lock);
    c.palletsRequested += n;
    if (measured) {
      c.outReq += n;
      this.loadReady.push((this.sim.now - t0) / 60);
    }
    return tokens;
  }

  /** paletes da carga no formato de blocos: a capacidade do baú × ocupação, ou a quantidade fixa por carga */
  private customLoadSize(v: VehicleType): number {
    const e = this.sc.expedition;
    return this.sc.vehicleTypes.length ? Math.max(1, Math.round(v.capacityPallets * e.loadOccupancy)) : Math.max(1, Math.round(e.palletsPerLoad));
  }

  /** uma pessoa (ou equipamento) do tipo escolhido vai ao ponto e trabalha pelo tempo; sem recurso cadastrado o tempo passa livre */
  *personWork(kinds: ResourceKind[], near: Pt, dur: number): Process {
    const pools = kinds.map((k) => (k === 'worker' ? this.workers : k === 'checker' ? this.checkers : this.eqPools[k])).filter((p) => p.items.length > 0);
    if (!pools.length) {
      yield dur;
      return;
    }
    const pool = this.choosePool(pools);
    const ag: Agent = yield* this.takeEq(pool, near);
    yield this.go(ag, near, false);
    yield dur;
    ag.tasks++;
    this.giveEq(pool, ag);
  }

  /** uma tarefa de pessoa da expedição em blocos: na carga inteira, em cada palete ou em uma parte dos paletes */
  private *loadTask(st: TaskStep, tokens: StageToken[], dock: DockItem, boarded: boolean, measured: boolean): Process {
    const near = boarded ? dock.inner : this.stageOutPt;
    const self = this;
    if (st.scope === 'eachPallet' || st.scope === 'somePallets') {
      const chosen = st.scope === 'eachPallet' ? tokens : tokens.filter(() => this.rngPick.next() < st.pct);
      if (st.scope === 'somePallets' && measured) this.expCustomized += chosen.length;
      const done = new Countdown(this.sim, chosen.length);
      for (const tok of chosen) {
        this.sim.spawn(function* () {
          const dur = st.perBox && tok.origin === 'picking' ? self.sum(st.perBox, Math.max(1, tok.boxes)) : sampleDist(self.rngSvc, st.time);
          yield* self.personWork(st.with, st.scope === 'eachPallet' ? self.tokenPt(tok) : self.stageOutPt, dur);
          tok.checked = true;
          done.tick();
        });
      }
      yield done.signal;
      return;
    }
    yield* this.personWork(st.with, near, sampleDist(this.rngSvc, st.time));
    if (st.extraPct > 0 && this.rngPick.next() < st.extraPct) {
      if (measured) this.expDivergent++;
      yield* this.personWork(st.with, near, sampleDist(this.rngSvc, st.extraTime));
    }
  }

  /** expedição no formato de blocos: percorre os blocos do processo de carga */
  private *runLoadProcess(def: ProcessDef, dock: DockItem, tDock: number, trailerM: number, n: number): Process {
    const measured = tDock >= this.warm;
    const byId = new Map(def.steps.map((x) => [x.id, x]));
    const go = (id?: string) => (id ? byId.get(id) : undefined);
    let cur = go(def.steps.find((x) => x.type === 'start')?.next);
    let tokens: StageToken[] = [];
    let boarded = false;
    let closeSec = 0;
    const span = (k: keyof SimModel['expSpan'], t: number) => {
      if (measured) this.expSpan[k].push((this.sim.now - t) / 60);
    };
    let guard = 0;
    while (cur && guard++ < 200) {
      const t = this.sim.now;
      switch (cur.type) {
        case 'collect': tokens = yield* this.formLoad(n, measured); cur = go(cur.next); break;
        case 'task': {
          yield* this.loadTask(cur, tokens, dock, boarded, measured);
          if (cur.kpi === 'close') closeSec += this.sim.now - t;
          else span(cur.kpi, t);
          cur = go(cur.next);
          break;
        }
        case 'board':
          if (!boarded && tokens.length) {
            yield* this.boardLoad(dock, tokens, trailerM, { id: cur.id, type: 'board', enabled: true, with: cur.with }, tDock);
            boarded = true;
          }
          span('board', t);
          cur = go(cur.next);
          break;
        case 'wait': yield sampleDist(this.rngSvc, cur.time); cur = go(cur.next); break;
        case 'start': cur = go(cur.next); break;
        default: cur = undefined;
      }
    }
    if (!boarded && tokens.length) yield* this.boardLoad(dock, tokens, trailerM, { id: 'auto', type: 'board', enabled: true, with: ['forklift'] }, tDock);
    if (measured) {
      this.expSpan.close.push(closeSec / 60);
      this.expLoads++;
    }
  }

  /** palete full do processo em blocos: cria o item, percorre os blocos e conta a chegada ao stage */
  private *customFullPallet(tOrder: number, done: Countdown): Process {
    const fp = this.sc.picking.full;
    const tot = Math.max(1e-9, fp.abc.a + fp.abc.b + fp.abc.c);
    const cls = this.rngPick.pick([fp.abc.a / tot, fp.abc.b / tot, fp.abc.c / tot]) as 0 | 1 | 2;
    yield* runProcess(this, this.customFull!, auxLoad(this, 'pallet', this.skuCartons[0] ?? 60, cls, 'full', tOrder >= this.warm));
    done.tick();
  }

  /** o palete full chegou ao stage de expedição (processo em blocos) */
  deliverFull(slot: PoolItem | undefined, measured: boolean) {
    this.stageOutArrive(slot, 'full', 0);
    if (measured) this.fullPallets++;
  }

  /** expedição por etapas: forma a carga (N paletes) e percorre conferir, batimento, customizar, embarcar, registrar e lacrar */
  private *runExpedition(dock: DockItem, tDock: number, trailerM: number, loadSize: number): Process {
    const c = this.c;
    const n = Math.max(1, Math.round(loadSize));
    const measured = tDock >= this.warm;
    const stage = this.stageOutPt;
    // 1) forma a carga: um caminhão por vez recolhe seus N paletes do stage (esperando a separação)
    const tokens: StageToken[] = yield* this.formLoad(n, measured);
    // 2) etapas, na ordem; sem etapa de embarque o app embarca no fim com empilhadeira
    let boarded = false;
    let closeSec = 0;
    const span = (k: keyof SimModel['expSpan'], t: number) => {
      if (measured) this.expSpan[k].push((this.sim.now - t) / 60);
    };
    for (const st of this.expSteps) {
      const t = this.sim.now;
      switch (st.type) {
        case 'conference':
          yield* this.conferLoad(tokens, st);
          if (st.timing === 'later') span('conference', t);
          break;
        case 'reconcile': yield* this.reconcileLoad(st, measured); span('reconcile', t); break;
        case 'customize': yield* this.customizeLoad(n, st, measured); span('customize', t); break;
        case 'board':
          if (!boarded) {
            yield* this.boardLoad(dock, tokens, trailerM, st, tDock);
            boarded = true;
          }
          span('board', t);
          break;
        case 'register':
        case 'seal':
        case 'task':
          yield* this.personTask(st.resource, dock.inner, sampleDist(this.rngSvc, st.time));
          closeSec += this.sim.now - t;
          break;
      }
    }
    if (!boarded) yield* this.boardLoad(dock, tokens, trailerM, { id: 'auto', type: 'board', enabled: true, with: ['forklift'] }, tDock);
    if (measured) {
      this.expSpan.close.push(closeSec / 60);
      this.expLoads++;
    }
    void stage;
  }

  /** um separador:

  /** pedido de palete full: N paletes inteiros retirados do endereço e levados ao stage de expedição */
  private *orderFull(): Process {
    const fp = this.sc.picking.full;
    const tOrder = this.sim.now;
    const n = Math.max(1, Math.round(this.rngPick.normal(fp.palletsPerOrder.mean, fp.palletsPerOrder.sd)));
    const done = new Countdown(this.sim, n);
    for (let i = 0; i < n; i++) this.sim.spawn(this.customFull ? this.customFullPallet(tOrder, done) : this.fullPallet(tOrder, done));
    yield done.signal;
    if (tOrder >= this.warm) {
      this.fullOrders++;
      this.fullOrderTimes.push((this.sim.now - tOrder) / 60);
    }
  }

  private *fullPallet(tOrder: number, done: Countdown): Process {
    const fp = this.sc.picking.full;
    const measured = tOrder >= this.warm;
    const tot = Math.max(1e-9, fp.abc.a + fp.abc.b + fp.abc.c);
    const cls = this.rngPick.pick([fp.abc.a / tot, fp.abc.b / tot, fp.abc.c / tot]) as 0 | 1 | 2;
    const rack = this.chooseRackGet(cls);
    if (!rack) {
      if (measured) this.fullNoStock++;
      done.tick();
      return;
    }
    const idx = this.takeSlot(rack);
    const a = slotAddr(rack, idx);
    const side = slotSide(rack, idx);
    const ap = this.accessPoint(rack, a.bay, side);
    const aisle = rack.faceAisle[side];
    // reservas antes de pegar recursos (não trava a frota esperando espaço)
    let outSlot: PoolItem | undefined;
    if (this.stageOutSlots) outSlot = yield this.stageOutSlots.request(ap);
    const stagePt: Pt = outSlot ? { x: outSlot.x, z: outSlot.z } : this.stageOutPt;
    const tpool = fp.mode === 'phased' ? (aisle ? this.transitPools.get(aisle) : undefined) ?? [...this.transitPools.values()][0] : undefined;
    if (!tpool) {
      // direta: a empilhadeira retira o palete do endereço e o leva ao stage
      const fk: Agent = yield this.forklifts.request(ap);
      yield this.go(fk, ap, false);
      yield this.liftTime(a.level);
      yield this.go(fk, stagePt, true);
      fk.tasks++;
      this.forklifts.release(fk);
    } else {
      // faseada: a empilhadeira baixa o palete na rua; paleteira/transpaleteira/AMR o leva ao stage
      const tslot: PoolItem = yield tpool.request(ap);
      this.transitInUse++;
      this.transitMax = Math.max(this.transitMax, this.transitInUse);
      const fk: Agent = yield this.forklifts.request(ap);
      yield this.go(fk, ap, false);
      yield this.liftTime(a.level);
      yield this.go(fk, { x: tslot.x, z: tslot.z }, true);
      fk.tasks++;
      this.forklifts.release(fk);
      const pool = this.choosePool(fp.step1With.filter((k) => k !== 'forklift').map((k) => this.eqPools[k]));
      const mv: Agent = yield* this.takeEq(pool, { x: tslot.x, z: tslot.z });
      yield this.go(mv, { x: tslot.x, z: tslot.z }, false);
      tpool.release(tslot as never);
      this.transitInUse--;
      yield this.go(mv, stagePt, true);
      mv.tasks++;
      this.giveEq(pool, mv);
    }
    this.stageOutArrive(outSlot, 'full', 0);
    if (measured) this.fullPallets++;
    done.tick();
  }

  /** caminhão de expedição carregando a partir do stage: espera haver palete separado */
  private *outboundFromStage(dock: DockItem, loaded: Countdown, tDock: number, idx: number, n: number, trailerM: number, gate?: VehicleGate): Process {
    const c = this.c;
    if (tDock >= this.warm) c.outReq++;
    c.palletsRequested++;
    const t0 = this.sim.now;
    const req = this.stageOutStore.take();
    yield req.signal;
    const tok = req.res.item!;
    if (tDock >= this.warm) this.expeditionWait.push((this.sim.now - t0) / 60);
    const pt: Pt = tok.slot ? { x: tok.slot.x, z: tok.slot.z } : this.stageOutPt;
    const pool = this.choosePool(this.sc.picking.loadWith.map((k) => this.eqPools[k]));
    const turn = gate?.before(idx);
    if (turn) yield turn;
    const ag: Agent = yield* this.takeEq(pool, pt);
    yield this.go(ag, pt, false);
    if (tok.slot && this.stageOutSlots) this.stageOutSlots.release(tok.slot);
    this.stageOutInUse--;
    yield this.go(ag, dock.inner, true);
    // carrega do fundo para a porta; um equipamento por vez dentro do veículo
    yield* this.inVehicle(dock, ag, this.sc.receiving.trailerDepth ? trailerDepthM(n - 1 - idx, trailerM) : 0, sampleDist(this.rngSvc, this.sc.ops.loadPallet), tDock >= this.warm, gate, idx);
    ag.tasks++;
    this.giveEq(pool, ag);
    loaded.tick();
    c.palletsDone++;
    if (this.measuring) {
      c.palletsOut++;
      this.hourBucket().out++;
    }
  }

  /** um separador: percorre sua rota, lê o endereço, pega e coloca as caixas; ao atingir o limite leva o palete ao stage */
  private *pickerRoute(part: Stop[], done: Countdown, tArr: number, pk: PickRouteParams): Process {
    const empties = new Set(pk.stockout.addresses);
    const stage = this.stageOutPt;
    const wk: Agent = yield this.workers.request(stage);
    const measured = tArr >= this.warm;
    const tBusy0 = this.sim.now;
    const dist = (a: Pt, b: Pt) => this.world.nav.distance(a, b);
    const here: Pt = { x: wk.x, z: wk.z };
    // os dois formatos sobre as mesmas paradas: tempo de rota = manuseio + deslocamento
    const handle = part.length * distMeanOf(pk.scan) + part.reduce((n, s) => n + s.boxes, 0) * (distMeanOf(pk.pick) + distMeanOf(pk.place));
    const uRoute = planRoute('u', part, here, this.aisleInfo, dist);
    const zRoute = planRoute('zigzag', part, here, this.aisleInfo, dist);
    if (measured) {
      this.pickRouteU.push((handle + this.pickTravel(uRoute, wk, here, stage)) / 60);
      this.pickRouteZ.push((handle + this.pickTravel(zRoute, wk, here, stage)) / 60);
    }
    const route = pk.route === 'u' ? uRoute : zRoute;
    const limitOf = () => Math.max(1, Math.round(this.rngPick.normal(pk.palletLimit.mean, pk.palletLimit.sd)));
    let limit = limitOf();
    let onPallet = 0;
    let t0 = -1;
    let lastBoxes = 0;
    const closePallet = () => {
      lastBoxes = onPallet;
      if (measured) {
        this.pickPalletTimes.push((this.sim.now - t0) / 60);
        this.pickPallets++;
        this.pickBoxes += onPallet;
      }
      onPallet = 0;
      t0 = -1;
      limit = limitOf();
    };
    let loaded = false;
    for (let i = 0; i < route.length; i++) {
      const st = route[i];
      yield this.go(wk, st.pos.pt, loaded);
      loaded = true;
      yield sampleDist(this.rngSvc, pk.scan); // ler o código de barras do endereço
      // furo de estoque: endereço vazio ao chegar; espera a reposição
      const empty = pk.stockout.mode === 'positions' ? empties.has(st.pos.label) : pk.stockout.mode === 'pct' ? this.rngPick.next() < pk.stockout.pct : false;
      if (empty) {
        const lost = Math.max(0, sampleDist(this.rngSvc, pk.stockout.delay));
        yield lost;
        if (measured) {
          this.pickStockouts++;
          this.pickStockoutSec += lost;
        }
      }
      let left = st.boxes;
      while (left > 0) {
        const take = Math.min(left, limit - onPallet);
        if (t0 < 0) t0 = this.sim.now; // início do palete: coleta da primeira caixa
        yield this.sum(pk.pick, take) + this.sum(pk.place, take);
        onPallet += take;
        left -= take;
        if (onPallet >= limit) {
          closePallet();
          yield* this.deliverPickPallet(wk, lastBoxes); // palete cheio: leva ao stage de expedição e volta vazio
          if (left > 0 || i < route.length - 1) {
            yield this.go(wk, st.pos.pt, false);
          }
        }
      }
    }
    if (onPallet > 0) {
      closePallet();
      yield* this.deliverPickPallet(wk, lastBoxes);
    }
    wk.tasks++;
    if (measured) this.pickBusySec += this.sim.now - tBusy0;
    this.workers.release(wk);
    done.tick();
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

  /** estatísticas instantâneas para o painel ao vivo */
  snapshot() {
    const now = Math.max(1, this.sim.now - this.warm);
    const u = (p: Pool<any>) => (p.items.length ? this.busyTotal(p) / (now * p.items.length) : 0);
    const stock = this.world.racks.reduce((s, r) => s + r.stock, 0);
    return {
      t: this.sim.now,
      palletsIn: this.c.palletsIn,
      palletsOut: this.c.palletsOut,
      orders: this.c.orders,
      trucksIn: this.c.trucksIn,
      trucksOut: this.c.trucksOut,
      utilForklift: u(this.forklifts),
      utilWorker: u(this.workers),
      utilDockIn: u(this.dockIn),
      utilDockOut: u(this.dockOut),
      queueForklift: this.forklifts.queueLength,
      queueWorker: this.workers.queueLength,
      queueDockIn: this.dockIn.queueLength,
      queueDockOut: this.dockOut.queueLength,
      forkliftsBusy: this.forklifts.items.filter((a) => a.busy).length,
      workersBusy: this.workers.items.filter((a) => a.busy).length,
      occupancy: stock / (this.world.totalCapacity || 1),
      stockouts: this.c.stockouts,
      overflow: this.c.overflow,
    };
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
    const moverPools = [this.eqPools.palletJack, this.eqPools.palletTruck, this.eqPools.amr].filter((p) => p.items.length);
    for (const p of moverPools) p.finalize();
    this.stageSlots?.finalize();
    const moverUnits = moverPools.reduce((n, p) => n + p.items.length, 0);
    const utilMover = moverUnits ? moverPools.reduce((u, p) => u + p.utilization(end) * p.items.length, 0) / moverUnits : 0;
    const breakFk = breakMinutesPerDay(sc, 'forklift');
    const prodFk = Math.max(0.05, 1 - breakFk / 60 / sc.shiftHours); // fração do turno em horas úteis
    const prodWk = Math.max(0.05, 1 - breakMinutesPerDay(sc, 'worker') / 60 / sc.shiftHours);
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
      palletsPerForkliftHour: sc.forklifts.count ? moved / (sc.forklifts.count * hours * prodFk) : 0,
      linesPerWorkerHour: sc.workers.count ? c.lines / (sc.workers.count * hours * prodWk) : 0,
      kmPerForklift: kms(this.forklifts) / days,
      kmPerWorker: kms(this.workers) / days,
      costPerPallet: moved ? totalCost / moved : 0,
      totalCost,
      backlogOrders: 0,
      backlogPallets: Math.max(0, c.palletsRequested - c.palletsDone),
      trucksDelayedPct: c.scheduled ? c.delayed / c.scheduled : 0,
      truckDelayMean: c.delayed ? c.delaySec / c.delayed / 60 : 0,
      dockWaitOverPctIn: this.dockWaitIn.length ? c.waitOverIn / this.dockWaitIn.length : 0,
      dockWaitOverPctOut: this.dockWaitOut.length ? c.waitOverOut / this.dockWaitOut.length : 0,
      productiveHoursPerDay: sc.shiftHours * prodFk,
      breakHoursPerDay: breakFk / 60,
      nonWorkingHoursPerDay: Math.max(0, 24 - sc.shiftHours),
      damagedPalletsPerDay: c.damaged / days,
      damagedPalletPct: c.checked ? c.damaged / c.checked : 0,
      damagedCartonsPerDay: c.damagedCartons / days,
      wholePalletTriagePerDay: c.wholeTriage / days,
      triageOverflowPerDay: c.triageOverflow / days,
      checkCycleMean: mean(this.checkCycle),
      stageWaitMean: mean(this.stageWait),
      stageOccupancyMax: this.stageMax,
      utilMover,
      phasedShare: this.stored ? this.phased / this.stored : 0,
      transitWaitMean: mean(this.transitWait),
      transitOccupancyMax: this.transitMax,
      utilAmr: this.eqPools.amr.items.length ? this.eqPools.amr.utilization(end) : 0,
      amrChargesPerDay: this.amrCharges / days,
      amrChargeShare: this.eqPools.amr.items.length ? this.amrChargeSec / (this.eqPools.amr.items.length * Math.max(1e-9, end - this.warm)) : 0,
      chargerWaitMean: this.chargerSlots ? mean(this.chargerSlots.waits) / 60 : 0,
      pickPalletsPerDay: this.pickPallets / days,
      boxesPerPallet: this.pickPallets ? this.pickBoxes / this.pickPallets : 0,
      pickPalletTimeMean: mean(this.pickPalletTimes),
      pickRouteTimeU: mean(this.pickRouteU),
      pickRouteTimeZigzag: mean(this.pickRouteZ),
      // produtividade pelo tempo trabalhado dos separadores (andar, ler, pegar, colocar, levar ao stage): vem do tempo por caixa
      boxesPerPickerHour: (sc.picking.mode === 'pallet' || !!this.customOrder) && this.pickBusySec > 0 ? c.cartons / (this.pickBusySec / 3600) : 0,
      stockoutPicksPerDay: this.pickStockouts / days,
      stockoutTimeLostPerDay: this.pickStockoutSec / 60 / days,
      fullOrdersPerDay: this.fullOrders / days,
      fullPalletsPerDay: this.fullPallets / days,
      fullOrderTimeMean: mean(this.fullOrderTimes),
      fullNoStockPerDay: this.fullNoStock / days,
      stageOutMax: this.stageOutMax,
      expeditionWaitMean: mean(this.expeditionWait),
      vehicleLockWaitMean: mean(this.lockWait),
      loadReadyMean: mean(this.loadReady),
      expConferMean: mean(this.expSpan.conference),
      expReconcileMean: mean(this.expSpan.reconcile),
      expCustomizeMean: mean(this.expSpan.customize),
      expBoardMean: mean(this.expSpan.board),
      expCloseMean: mean(this.expSpan.close),
      divergentLoadsPct: this.expLoads ? this.expDivergent / this.expLoads : 0,
      customizedPalletsPerLoad: this.expLoads ? this.expCustomized / this.expLoads : 0,
    };
    kpis.backlogOrders = this.workers.queueLength; // pedidos ainda aguardando operário ao final
    return {
      kpis,
      hourly: this.hourly,
      samples: { orderCycle: this.orderCycle, forkliftWait: this.forklifts.waits.map((w) => w / 60), putawayLead: this.putawayLead, truckTurn: [...this.turnIn, ...this.turnOut] },
      occupancySeries: this.occSeries,
      vehicleStats: this.vStats.map((s, i) => {
        const o = this.vStatsOut[i] ?? { n: 0, dockSec: 0, waitSec: 0 };
        return {
          name: s.name, trucks: s.n / days, dockTurnMean: s.n ? s.dockSec / s.n / 60 : 0, dockWaitMean: s.n ? s.waitSec / s.n / 60 : 0,
          trucksOut: o.n / days, dockTurnOutMean: o.n ? o.dockSec / o.n / 60 : 0, dockWaitOutMean: o.n ? o.waitSec / o.n / 60 : 0,
        };
      }),
    };
  }
}
