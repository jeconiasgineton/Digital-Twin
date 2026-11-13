import type { Pt } from '../math/spatial';
import { sampleDist } from '../math/rng';
import {
  getPort, type CheckStep, type DecideStep, type ItemKind, type LiftStep, type MoveStep, type PlaceRef, type ProcessDef, type ResourceKind,
  type RetrieveStep, type SeparateStep, type Step,
} from '../model/process';
import { trailerDepthM } from '../model/receiving';
import { Countdown, type Pool, type PoolItem, type Process, type VehicleGate } from './engine';
import type { SimModel } from './model';
import { SLOT_OCCUPIED, slotAddr, slotSide, type Agent, type DockItem, type RackRT } from './world';

/**
 * Intérprete de processos personalizados. Cada função implementa UMA ação genérica e não sabe se está sendo usada
 * para descarga, triagem ou guarda: o que importa é o item, o local de origem/destino, os recursos e os tempos.
 */

export interface PlaceState {
  ref: PlaceRef;
  pt: Pt;
  /** libera o espaço reservado (stage, rua…) quando o item sai do local */
  hold?: () => void;
}

export interface Dest {
  rack: RackRT;
  slot: number;
  side: 0 | 1;
  aisle?: string;
  ap: Pt;
  level: number;
  mode: 'put' | 'take';
}

export interface LoadCtx {
  dock: DockItem;
  tDock: number;
  /** posição do palete no baú (0 = mais perto da porta) e comprimento do baú */
  idx: number;
  trailerM: number;
  unloaded: Countdown;
  /** senha de acesso ao veículo (um equipamento por vez) */
  gate?: VehicleGate;
  ticked: boolean;
  measured: boolean;
}

/** o item que percorre o processo */
export interface Load {
  kind: ItemKind;
  /** caixas/fardos dentro do item */
  count: number;
  skuIdx: number;
  cls: 0 | 1 | 2;
  damaged: boolean;
  damagedCartons: number;
  /** item original do gatilho (os derivados de Separar/Recuperar não contam como novos paletes) */
  root: boolean;
  place: PlaceState;
  dest?: Dest;
  ctx: LoadCtx;
  /** passou por um endereço transitório (armazenagem faseada) */
  viaTransit?: boolean;
  /** índice da amostra de conferência (para somar o tempo de triagem) */
  cycleIdx?: number;
}

const FALLBACK_STAGE_OFFSET = 2.5;

const poolsOf = (m: SimModel, kinds: ResourceKind[]): Pool<Agent>[] =>
  kinds.map((k) => (k === 'worker' ? m.workers : k === 'checker' ? m.checkers : m.eqPools[k]));

/** o recurso disponível entre os permitidos (sem nenhum com unidades, a empilhadeira cobre) */
const pickPool = (m: SimModel, kinds: ResourceKind[]) => m.choosePool(poolsOf(m, kinds));

/** tempo do manuseio: por item quando o item é caixa/fardo */
const handlingTime = (m: SimModel, load: Load, d: Parameters<SimModel['sum']>[0]) => (load.kind === 'pallet' ? sampleDist(m.rngSvc, d) : m.sum(d, Math.max(1, load.count)));

/** reserva espaço no local de destino (esperando se estiver cheio) e devolve o ponto de trabalho */
function* reserveSpace(m: SimModel, load: Load, ref: PlaceRef): Generator<any, PlaceState, any> {
  const ctx = load.ctx;
  const measured = ctx.measured;
  switch (ref.kind) {
    case 'stage': {
      if (!m.stageSlots) return { ref, pt: { x: ctx.dock.inner.x, z: ctx.dock.inner.z - FALLBACK_STAGE_OFFSET } };
      const t0 = m.sim.now;
      const slot: PoolItem = yield m.stageSlots.request(load.place.pt);
      if (measured) m.stageWait.push((m.sim.now - t0) / 60);
      m.stageInUse++;
      m.stageMax = Math.max(m.stageMax, m.stageInUse);
      return { ref, pt: { x: slot.x, z: slot.z }, hold: () => { m.stageSlots!.release(slot); m.stageInUse--; } };
    }
    case 'transit': {
      const pool = (load.dest?.aisle ? m.transitPools.get(load.dest.aisle) : undefined) ?? [...m.transitPools.values()][0];
      if (!pool) return { ref, pt: load.dest?.ap ?? load.place.pt };
      const t0 = m.sim.now; // rua cheia: espera liberar espaço
      const slot: PoolItem = yield pool.request(load.place.pt);
      if (measured) m.transitWait.push((m.sim.now - t0) / 60);
      m.transitInUse++;
      m.transitMax = Math.max(m.transitMax, m.transitInUse);
      load.viaTransit = true;
      return { ref, pt: { x: slot.x, z: slot.z }, hold: () => { pool.release(slot as never); m.transitInUse--; } };
    }
    case 'triage': {
      const { area, overflow } = m.chooseTriage();
      if (overflow && measured) m.c.triageOverflow++;
      if (area && !overflow) area.occupied++;
      return { ref, pt: area ? area.pt : load.place.pt };
    }
    case 'dock':
    case 'trailer':
      return { ref, pt: ctx.dock.inner };
    case 'rack':
      return { ref, pt: load.dest?.ap ?? load.place.pt };
    case 'area': {
      const el = m.world.layout.elements.find((e) => e.id === ref.areaId);
      return { ref, pt: el ? { x: el.x, z: el.z } : load.place.pt };
    }
    default:
      return { ref, pt: load.place.pt };
  }
}

/** Movimentar: leva o item do local atual a outro com o recurso disponível */
function* doMove(m: SimModel, load: Load, st: MoveStep): Process {
  const from = load.place;
  const fromKind = st.from.kind === 'here' ? from.ref.kind : st.from.kind;
  const dest = yield* reserveSpace(m, load, st.to); // reserva antes de pegar recurso: não trava a frota esperando espaço
  const pool = pickPool(m, st.with);
  if (fromKind === 'trailer' && load.ctx.gate) {
    const turn = load.ctx.gate.before(load.ctx.idx);
    if (turn) yield turn; // vez no veículo
  }
  const ag: Agent = yield* m.takeEq(pool, from.pt);
  yield m.go(ag, from.pt, false);
  if (fromKind === 'trailer') yield* m.inVehicle(load.ctx.dock, ag, m.sc.receiving.trailerDepth ? trailerDepthM(load.ctx.idx, load.ctx.trailerM) : 0, handlingTime(m, load, st.handling), load.ctx.measured, load.ctx.gate, load.ctx.idx);
  else yield handlingTime(m, load, st.handling);
  from.hold?.();
  from.hold = undefined;
  if (fromKind === 'trailer' && !load.ctx.ticked) {
    load.ctx.ticked = true;
    load.ctx.unloaded.tick(); // o item saiu do veículo: libera o caminhão quando todos saírem
  }
  yield m.go(ag, dest.pt, true);
  ag.tasks++;
  m.giveEq(pool, ag);
  load.place = dest;
}

/** subida e descida do garfo até o nível + o tempo de posicionamento configurado no bloco */
const liftTime = (m: SimModel, level0: number, st: LiftStep) => (2 * level0 * m.sc.levelHeight) / Math.max(0.05, m.sc.liftSpeed) + sampleDist(m.rngSvc, st.handling);

/** Elevar: leva o palete do local atual à posição do endereço e o eleva (put) / retira da posição (take) */
function* doLift(m: SimModel, load: Load, st: LiftStep): Process {
  const d = load.dest;
  if (!d) return;
  const pool = pickPool(m, st.with);
  const ag: Agent = yield* m.takeEq(pool, load.place.pt);
  yield m.go(ag, load.place.pt, false);
  load.place.hold?.();
  load.place.hold = undefined;
  if (st.direction === 'put') {
    yield m.go(ag, d.ap, true);
    yield liftTime(m, d.level, st);
    d.rack.slots[d.slot] = SLOT_OCCUPIED;
    d.rack.occupied++;
    if (m.measuring) {
      m.c.palletsIn++;
      m.hourBucket().in++;
    }
    if (load.ctx.measured) {
      m.stored++;
      if (load.viaTransit) m.phased++;
      m.putawayLead.push((m.sim.now - load.ctx.tDock) / 60);
    }
    load.place = { ref: { kind: 'rack' }, pt: d.ap };
  } else {
    yield m.go(ag, d.ap, false);
    yield liftTime(m, d.level, st);
    load.place = { ref: { kind: 'rack' }, pt: d.ap };
  }
  ag.tasks++;
  m.giveEq(pool, ag);
}

/** Endereçar: define o endereço pela regra de armazenagem (reserva/retira a posição) */
function doAddress(m: SimModel, load: Load, mode: 'put' | 'take'): boolean {
  if (mode === 'put') {
    const rack = m.chooseRackPut(load.cls, load.place.pt);
    if (!rack) {
      if (load.ctx.measured) m.c.overflow++;
      return false;
    }
    const slot = m.reserveSlot(rack);
    const a = slotAddr(rack, slot);
    const side = slotSide(rack, slot);
    load.dest = { rack, slot, side, aisle: rack.faceAisle[side], ap: m.accessPoint(rack, a.bay, side), level: a.level, mode };
    return true;
  }
  const rack = m.chooseRackGet(load.cls);
  if (!rack) {
    if (load.ctx.measured) m.c.stockouts++;
    return false;
  }
  const slot = m.takeSlot(rack);
  const a = slotAddr(rack, slot);
  const side = slotSide(rack, slot);
  const ap = m.accessPoint(rack, a.bay, side);
  load.dest = { rack, slot, side, aisle: rack.faceAisle[side], ap, level: a.level, mode };
  load.place = { ref: { kind: 'rack' }, pt: ap };
  return true;
}

/** Conferir: tempo de conferência e chance de avaria (aumenta o tempo) */
function* doCheck(m: SimModel, load: Load, st: CheckStep): Process {
  const t0 = m.sim.now;
  const pool = pickPool(m, st.with);
  const ag: Agent = yield* m.takeEq(pool, load.place.pt);
  yield m.go(ag, load.place.pt, false);
  const damaged = m.rngDmg.next() < st.damagePct;
  let t = sampleDist(m.rngSvc, st.time);
  let nBad = 0;
  if (damaged) {
    t *= Math.max(1, st.damagedFactor);
    const frac = Math.min(1, Math.max(0, sampleDist(m.rngDmg, st.damagedFraction)));
    nBad = Math.min(load.count, Math.max(1, Math.round(frac * load.count)));
  }
  yield t;
  m.giveEq(pool, ag);
  load.damaged = damaged;
  load.damagedCartons = nBad;
  if (load.ctx.measured) {
    m.c.checked++;
    load.cycleIdx = m.checkCycle.push((m.sim.now - t0) / 60) - 1;
    if (damaged) {
      m.c.damaged++;
      m.c.damagedCartons += nBad;
      if (nBad >= load.count) m.c.wholeTriage++;
    }
  }
}

/** Separar: o que está bom segue; as caixas avariadas vão para um segundo palete (novo item) */
function* doSeparate(m: SimModel, def: ProcessDef, load: Load, st: SeparateStep): Generator<any, 'good' | 'bad', any> {
  if (!load.damaged || load.damagedCartons <= 0) return 'good';
  if (load.damagedCartons >= load.count) return 'bad'; // nenhuma caixa boa: o palete inteiro segue como avariado
  const n = load.damagedCartons;
  const t0 = m.sim.now;
  const pool = pickPool(m, st.with);
  const ag: Agent = yield* m.takeEq(pool, load.place.pt);
  yield m.go(ag, load.place.pt, false);
  yield m.sum(st.perItem, n); // repaletização: tempo por caixa movida
  m.giveEq(pool, ag);
  if (load.ctx.measured && load.cycleIdx !== undefined) m.checkCycle[load.cycleIdx] += (m.sim.now - t0) / 60;
  const child: Load = {
    kind: 'pallet', count: n, skuIdx: load.skuIdx, cls: load.cls, damaged: true, damagedCartons: n, root: false,
    place: { ref: load.place.ref, pt: load.place.pt }, ctx: load.ctx,
  };
  load.count -= n;
  load.damaged = false;
  load.damagedCartons = 0;
  if (st.nextBad) m.sim.spawn(runProcess(m, def, child, st.nextBad));
  return 'good';
}

/** Recuperar: retira caixas/fardos do item atual e cria um novo item com elas */
function* doRetrieve(m: SimModel, def: ProcessDef, load: Load, st: RetrieveStep): Process {
  const q = st.quantity;
  const n = Math.min(load.count, q.mode === 'all' ? load.count : q.mode === 'count' ? Math.max(1, Math.round(q.value)) : Math.max(1, Math.round(q.value * load.count)));
  if (n <= 0) return;
  const pool = pickPool(m, st.with);
  const ag: Agent = yield* m.takeEq(pool, load.place.pt);
  yield m.go(ag, load.place.pt, false);
  yield m.sum(st.perItem, n);
  m.giveEq(pool, ag);
  load.count -= n;
  const child: Load = {
    kind: st.item, count: n, skuIdx: load.skuIdx, cls: load.cls, damaged: false, damagedCartons: 0, root: false,
    place: { ref: load.place.ref, pt: load.place.pt }, ctx: load.ctx,
  };
  if (st.extracted) m.sim.spawn(runProcess(m, def, child, st.extracted));
}

/** Paletizar / Despaletizar: converte entre palete e caixas/fardos (tempo por item) */
function* doConvert(m: SimModel, load: Load, st: Extract<Step, { type: 'palletize' | 'depalletize' }>): Process {
  const pool = pickPool(m, st.with);
  const ag: Agent = yield* m.takeEq(pool, load.place.pt);
  yield m.go(ag, load.place.pt, false);
  yield m.sum(st.perItem, Math.max(1, load.count));
  m.giveEq(pool, ag);
  load.kind = st.type === 'palletize' ? 'pallet' : st.item;
}

function decide(m: SimModel, load: Load, st: DecideStep): boolean {
  switch (st.condition) {
    case 'damaged': return load.damaged;
    case 'wholeDamaged': return load.damaged && load.damagedCartons >= load.count;
    case 'countAbove': return load.count > st.value;
    default: return m.rngDmg.next() < st.value;
  }
}

function finish(m: SimModel, load: Load) {
  load.ctx.gate?.entered(load.ctx.idx); // garante que o próximo palete não fique esperando uma vez que nunca chegou
  load.place.hold?.();
  load.place.hold = undefined;
  if (!load.ctx.ticked) {
    load.ctx.ticked = true;
    load.ctx.unloaded.tick();
  }
  if (load.root) m.c.palletsDone++;
}

/** executa o processo para um item, do bloco `fromId` (ou do Início) até o Fim */
export function* runProcess(m: SimModel, def: ProcessDef, load: Load, fromId?: string): Process {
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const start = def.steps.find((s) => s.type === 'start');
  let cur: Step | undefined = byId.get(fromId ?? getPort(start ?? ({} as Step), 'next') ?? '');
  let guard = 0;
  while (cur && guard++ < 400) {
    const s: Step = cur;
    const go = (id?: string) => (id ? byId.get(id) : undefined);
    switch (s.type) {
      case 'start': cur = go(s.next); break;
      case 'move': yield* doMove(m, load, s); cur = go(s.next); break;
      case 'lift': yield* doLift(m, load, s); cur = go(s.next); break;
      case 'address': cur = doAddress(m, load, s.mode) ? go(s.next) : go(s.nextNone); break;
      case 'check': yield* doCheck(m, load, s); cur = go(s.next); break;
      case 'separate': {
        const r: 'good' | 'bad' = yield* doSeparate(m, def, load, s);
        cur = r === 'good' ? go(s.next) : go(s.nextBad);
        break;
      }
      case 'retrieve': yield* doRetrieve(m, def, load, s); cur = go(s.next); break;
      case 'palletize':
      case 'depalletize': yield* doConvert(m, load, s); cur = go(s.next); break;
      case 'decide': cur = decide(m, load, s) ? go(s.next) : go(s.nextNo); break;
      case 'wait': yield sampleDist(m.rngSvc, s.time); cur = go(s.next); break;
      case 'end': cur = undefined; break;
    }
  }
  finish(m, load);
}

/** cria o item de um palete que acabou de docar e inicia o processo personalizado */
export function startPalletProcess(m: SimModel, def: ProcessDef, dock: DockItem, tDock: number, idx: number, trailerM: number, unloaded: Countdown, gate?: VehicleGate): Process {
  const sk = m.pickSku();
  const measured = tDock >= m.warm;
  m.c.palletsRequested++;
  if (measured) m.c.inReq++;
  const load: Load = {
    kind: 'pallet', count: m.skuCartons[sk.idx] ?? 1, skuIdx: sk.idx, cls: sk.cls, damaged: false, damagedCartons: 0, root: true,
    place: { ref: { kind: 'trailer' }, pt: dock.inner },
    ctx: { dock, tDock, idx, trailerM, unloaded, gate, ticked: false, measured },
  };
  return runProcess(m, def, load);
}
