import { amrChargeHours } from '../model/equipment';
import { checkStats } from '../model/receiving';
import { effectiveSteps, type ExpPerson, type ExpStep } from '../model/expedition';
import { pickProfile } from './pickprofile';
import { arrivalProfile, vehicleMeans } from '../model/traffic';
import type { EquipmentKind, EquipmentSpec, Layout, Scenario } from '../model/types';
import { distMean, distScv } from '../math/rng';
import { ggcMetrics, little, safetyStock, sizeServers } from '../math/queueing';
import { normInv, poissonQuantile, poissonSf } from '../math/stats';
import { travelTime } from '../sim/model';
import { type World, buildWorld, meanTravel } from '../sim/world';

type Pt = { x: number; z: number };

export interface ResourceRow {
  key: string;
  name: string;
  unit: string;
  current: number;
  /** nº recomendado para a demanda média das horas operacionais */
  requiredAvg: number;
  /** nº recomendado para a hora de pico */
  requiredPeak: number;
  demandPerHourAvg: number;
  demandPerHourPeak: number;
  /** capacidade máxima sustentável com o nº atual (por hora) */
  capacityPerHour: number;
  rhoAvg: number;
  rhoPeak: number;
  waitP95MinPeak: number;
  meanServiceSec: number;
  note: string;
  status: 'ok' | 'atencao' | 'critico';
}

export interface StorageReport {
  positions: number;
  expectedPallets: number; // Little: λ·W
  expectedOccupancy: number;
  pOverflow: number;
  positionsForServiceLevel: number;
  safetyStockPallets: number;
  dailyInPallets: number;
  dailyOutPallets: number;
  netDailyDrift: number;
  daysToFull: number; // < 0: nunca
}

export interface CapacityReport {
  rows: ResourceRow[];
  storage: StorageReport;
  travel: { dockToRackIn: number; rackToDockOut: number; rackToInduction: number };
  assumptions: string[];
}

const statusOf = (rho: number, target: number): ResourceRow['status'] => (rho <= target ? 'ok' : rho < 1 ? 'atencao' : 'critico');

/** Análise analítica (filas M/G/c, Allen–Cunneen, Poisson composto, Little, M/G/∞) – instantânea, sem simulação. */
export function analyzeCapacity(sc: Scenario, layout: Layout, world?: World): CapacityReport {
  const w = world ?? buildWorld(layout, sc);
  const { ops } = sc;
  const op = (h: number[]) => {
    const rates: number[] = [];
    for (let k = 0; k < sc.shiftHours; k++) rates.push((h[(sc.startHour + k) % 24] ?? 0) * sc.demandFactor);
    return { avg: rates.reduce((s, v) => s + v, 0) / Math.max(1, rates.length), peak: Math.max(0, ...rates), daily: rates.reduce((s, v) => s + v, 0) };
  };
  const tin = op(arrivalProfile(sc, 'in'));
  const tout = op(arrivalProfile(sc, 'out'));
  const ord = op(sc.ordersPerHour);
  const vIn = vehicleMeans(sc, 'in');
  const vOut = vehicleMeans(sc, 'out');
  const bIn = { ...sc.palletsPerTruckIn, mean: vIn.pallets };
  const expOn = sc.expedition.mode !== 'basic';
  const bOut = expOn ? { mean: vOut.pallets, sd: 0, max: vOut.pallets } : { ...sc.palletsPerTruckOut, mean: vOut.pallets };
  const pIn = { avg: tin.avg * bIn.mean, peak: tin.peak * bIn.mean, daily: tin.daily * bIn.mean };
  const pOut = { avg: tout.avg * bOut.mean, peak: tout.peak * bOut.mean, daily: tout.daily * bOut.mean };

  /* ---- distâncias ---- */
  const dockInPts = w.docksIn.map((d) => d.inner);
  const dockOutPts = w.docksOut.map((d) => d.inner);
  const mid = (r: { access: { x: number; z: number }[][]; bays: number }) => r.access[Math.floor(r.bays / 2)][0];
  const dIn = dockInPts.length ? meanTravel(w, dockInPts, (r) => mid(r)) : 0;
  const dOut = dockOutPts.length ? meanTravel(w, dockOutPts, (r) => mid(r)) : 0;
  const induct = w.conveyors.map((c) => c.start);
  const dInd = induct.length ? meanTravel({ ...w, racks: w.pickRacks }, induct, (r) => mid(r)) : dockOutPts.length ? meanTravel({ ...w, racks: w.pickRacks }, dockOutPts, (r) => mid(r)) : 0;

  const fk = sc.forklifts;
  const meanLevels = w.racks.length ? w.racks.reduce((s, r) => s + r.levels * r.capacity, 0) / Math.max(1, w.totalCapacity) : 4;
  const lift = (2 * ((meanLevels - 1) / 2) * sc.levelHeight) / Math.max(0.05, sc.liftSpeed) + distMean(ops.putawayPosition);
  const tvE = (d: number) => travelTime(d, fk.speedEmpty, sc.accel);
  const tvL = (d: number) => travelTime(d, fk.speedLoaded, sc.accel);
  const staged = sc.checkers.count > 0;
  const phased = sc.storage.mode === 'phased';
  const stageEx = staged ? tvL(2.5) + 2 * 3 : 0;

  /* ---- novos processos: avarias, equipamentos de descarga/etapa 1, AMR ---- */
  const cs = staged ? checkStats(sc) : { pDamaged: 0, pWhole: 0, meanBadPartial: 0, serviceMean: 0, serviceScv: 0, cartonsPerPallet: 0 };
  const unitsOf = (k: EquipmentKind) => (k === 'forklift' ? fk.count : sc.equipment.find((e) => e.kind === k)?.count ?? 0);
  const moverSpecs: EquipmentSpec[] = sc.equipment.filter((e) => e.count > 0);
  const moverUnits = moverSpecs.reduce((n, e) => n + e.count, 0);
  const amrSpec = moverSpecs.find((e) => e.kind === 'amr');
  const amrCycleMin = amrSpec?.amr ? amrSpec.amr.chargeMin + amrSpec.amr.setupMin : 0;
  const amrWorkMin = amrSpec?.amr ? amrSpec.amr.chargeTriggerFraction * amrSpec.amr.autonomyMin : 0;
  const amrCalendarShare = amrSpec?.amr ? (amrChargeHours(sc, amrSpec.amr).length * amrCycleMin) / Math.max(1, sc.shiftHours * 60) : 0;
  /** fração do tempo do AMR em carga/setup: a bateria só gasta enquanto ele trabalha (utilização × ciclo / autonomia útil) */
  const amrShareAt = (util: number) => (amrSpec?.amr ? Math.min(0.9, (util * amrCycleMin) / Math.max(1e-9, amrWorkMin) + amrCalendarShare) : 0);
  let amrChargeShare = amrCalendarShare;
  const wAvg = (f: (e: EquipmentSpec) => number) => (moverUnits ? moverSpecs.reduce((a, e) => a + e.count * f(e), 0) / moverUnits : 0);
  const mvSpeedE = wAvg((e) => e.speedEmpty);
  const mvSpeedL = wAvg((e) => e.speedLoaded);
  const mvAvailAt = (share: number) => wAvg((e) => e.availability * (e.kind === 'amr' ? 1 - share : 1));
  const tvEm = (d: number) => travelTime(d, mvSpeedE || fk.speedEmpty, sc.accel);
  const tvLm = (d: number) => travelTime(d, mvSpeedL || fk.speedLoaded, sc.accel);
  // quem descarrega o baú: a fração das unidades permitidas que é empilhadeira
  const allowed = sc.receiving.unloadWith.filter((k) => unitsOf(k) > 0);
  const allowedUnits = allowed.reduce((n, k) => n + unitsOf(k), 0);
  const shareFkUnload = allowedUnits > 0 ? (allowed.includes('forklift') ? fk.count / allowedUnits : 0) : 1; // sem unidade permitida: a simulação usa empilhadeira
  const step1Movers = phased && sc.storage.step1With.some((k) => k !== 'forklift' && unitsOf(k) > 0);
  const unloadT = distMean(ops.unloadPallet);
  const depthM = sc.receiving.trailerDepth ? vIn.depthM : 0;

  // distâncias dos novos pontos (só quando o processo está ligado)
  const avgDist = (from: Pt[], to: Pt[]) => {
    if (!from.length || !to.length) return 0;
    let t = 0;
    let n = 0;
    for (const a of from.slice(0, 12)) for (const b of to.slice(0, 12)) {
      t += w.nav.distance(a, b);
      n++;
    }
    return n ? t / n : 0;
  };
  const keyAll = (pts: Pt[]) => pts.forEach((p) => w.nav.key(p));
  const stagePts = staged && w.stages.length ? w.stages.map((x) => x.pt) : dockInPts;
  const transitPts = w.transits.map((x) => x.pt);
  const triagePts = w.triages.map((x) => x.pt);
  if (phased) keyAll(transitPts);
  if (staged) keyAll(stagePts);
  const dTR = phased && transitPts.length ? meanTravel(w, transitPts, (r) => mid(r)) : dIn; // transitório → rack
  const dST = phased && transitPts.length ? avgDist(stagePts, transitPts) : 0; // stage/doca → transitório
  const dStageTri = triagePts.length ? avgDist(stagePts, triagePts) : 0;

  /* ---- separação por palete, palete full e expedição por etapas ---- */
  const pk = sc.picking;
  const pickOn = pk.mode === 'pallet';
  const fp = pk.full;
  const fullOn = fp.ordersPerHour > 0;
  const stageOut = pk.loadFrom === 'stage' || expOn;
  const exSteps: ExpStep[] = expOn ? effectiveSteps(sc.expedition) : [];
  const stagePtOut: Pt = w.stagesOut[0]?.pt ?? w.docksOut[0]?.inner ?? w.home;
  if (pickOn || fullOn || stageOut) keyAll([stagePtOut]);
  const dRS = (pickOn || fullOn || stageOut) && w.racks.length ? meanTravel(w, [stagePtOut], (r) => mid(r)) : 0; // rack → stage de expedição
  const dSD = stageOut ? avgDist([stagePtOut], dockOutPts) : 0; // stage de expedição → doca
  const fullPhased = fullOn && fp.mode === 'phased' && transitPts.length > 0;
  if (fullPhased) keyAll(transitPts);
  const dTS = fullPhased ? avgDist(transitPts, [stagePtOut]) : 0; // transitório → stage de expedição
  const prof = pickOn ? pickProfile(sc, layout, w) : null;
  const fullPal = fullOn ? fp.ordersPerHour * sc.demandFactor * Math.max(1, fp.palletsPerOrder.mean) : 0; // paletes full por hora
  const pickPal = { avg: prof ? ord.avg * prof.palletsPerOrder : 0, peak: prof ? ord.peak * prof.palletsPerOrder : 0 }; // paletes de picking por hora
  const supply = { avg: pickPal.avg + fullPal, peak: pickPal.peak + fullPal }; // paletes que chegam ao stage de expedição
  const demandPal = { avg: pOut.avg, peak: pOut.peak }; // paletes pedidos pelos caminhões de saída
  /** fluxo que de fato passa pelo stage: o menor entre a oferta e a demanda (sem oferta, usa a demanda para dimensionar o que falta) */
  const flow = (k: 'avg' | 'peak') => (!stageOut ? 0 : supply[k] > 0 ? Math.min(supply[k], demandPal[k]) : demandPal[k]);
  const nLoad = Math.max(1, vOut.pallets);
  const boardStep = exSteps.find((x) => x.type === 'board');
  const loadKinds: EquipmentKind[] = boardStep && boardStep.type === 'board' ? boardStep.with : expOn ? ['forklift'] : pk.loadWith;
  const loadAllowed = loadKinds.filter((k) => unitsOf(k) > 0);
  const loadUnits = loadAllowed.reduce((n, k) => n + unitsOf(k), 0);
  const shareFkLoad = stageOut ? (loadUnits > 0 ? (loadAllowed.includes('forklift') ? fk.count / loadUnits : 0) : 1) : 1;
  const bpp = prof?.boxesPerPallet ?? pk.palletLimit.mean; // caixas por palete de picking
  const fullShare = supply.avg > 0 ? fullPal / supply.avg : 0;
  /** tempo de conferência de um palete na expedição (mistura de full e picking) */
  const confSec = (() => {
    const c = exSteps.find((x) => x.type === 'conference');
    return c && c.type === 'conference' ? fullShare * distMean(c.fullTime) + (1 - fullShare) * distMean(c.perBox) * bpp : 0;
  })();
  const poolOf = (r: ExpPerson) => (r === 'checker' ? sc.checkers : sc.workers);
  /** n tarefas em paralelo conforme as pessoas do pool (sem pool o tempo passa livre) */
  const parSec = (n: number, sec: number, r: ExpPerson) => {
    if (n <= 0) return 0;
    const cnt = poolOf(r).count * poolOf(r).availability;
    const servers = cnt > 0 ? Math.max(1, Math.min(n, cnt)) : n;
    return Math.max(sec, (n / servers) * sec);
  };
  /** classes de trabalho das pessoas na expedição: { quem, taxa (1/s) por palete ou por carga, tempo (s) } */
  type Cls = { lam: { avg: number; peak: number }; s: number };
  const ldRate = { avg: flow('avg') / nLoad / 3600, peak: flow('peak') / nLoad / 3600 };
  const palRate = { avg: flow('avg') / 3600, peak: flow('peak') / 3600 };
  const expClasses = (r: ExpPerson): Cls[] => {
    const out: Cls[] = [];
    const mul = (x: { avg: number; peak: number }, f: number) => ({ avg: x.avg * f, peak: x.peak * f });
    for (const st of exSteps) {
      if (st.type === 'board' || st.resource !== r) continue;
      switch (st.type) {
        case 'conference': out.push({ lam: palRate, s: confSec }); break;
        case 'reconcile': out.push({ lam: ldRate, s: distMean(st.time) + st.divergencePct * distMean(st.correctionTime) }); break;
        case 'customize': out.push({ lam: mul(ldRate, nLoad * st.pickPct), s: distMean(st.time) }); break;
        default: out.push({ lam: ldRate, s: distMean(st.time) });
      }
    }
    return out.filter((c) => c.lam.avg > 0 && c.s > 0);
  };
  const aggCls = (cs: Cls[]) => {
    const la = cs.reduce((a, c) => a + c.lam.avg, 0);
    const lp = cs.reduce((a, c) => a + c.lam.peak, 0);
    return { la, lp, sa: la > 0 ? cs.reduce((a, c) => a + c.lam.avg * c.s, 0) / la : 0, sp: lp > 0 ? cs.reduce((a, c) => a + c.lam.peak * c.s, 0) / lp : 0 };
  };
  const fkUnloadT = shareFkUnload * (unloadT + tvE(depthM) + tvL(depthM));

  // tarefa de entrada da empilhadeira: vazio até o palete, [descarga + baú], [stage], guarda (direta ou etapa 2)
  const putawayLeg = phased ? tvE(dTR) + tvL(dTR) : tvE(dIn) + tvL(dIn);
  const step1ByFork = phased && !step1Movers ? tvE(dST) + tvL(dST) : 0;
  const sIn = putawayLeg + fkUnloadT + stageEx + step1ByFork + lift;
  const depthOutM = sc.receiving.trailerDepth ? vOut.depthM : 0;
  const sOutRack = tvE(dOut) + lift + tvL(dOut) + distMean(ops.loadPallet) + tvE(depthOutM) + tvL(depthOutM); // inclui a ida e volta dentro do baú
  const sOutStage = tvE(dSD) + tvL(dSD) + distMean(ops.loadPallet) + tvE(depthOutM) + tvL(depthOutM); // carga a partir do stage de expedição
  const sOut = stageOut ? sOutStage : sOutRack;
  const lamIn = { avg: pIn.avg / 3600, peak: pIn.peak / 3600 };
  const triageByFork = staged && cs.pDamaged > 0 && moverUnits === 0; // sem paleteira/transpaleteira/AMR a empilhadeira leva as avarias
  const sTri = tvE(dStageTri) + tvL(dStageTri);
  const lamOut = stageOut ? { avg: (flow('avg') * shareFkLoad) / 3600, peak: (flow('peak') * shareFkLoad) / 3600 } : { avg: pOut.avg / 3600, peak: pOut.peak / 3600 };
  // palete full: a empilhadeira retira do endereço e leva ao stage (faseada: baixa no transitório e outro equipamento leva ao stage)
  const fullMovers = fullPhased && fp.step1With.some((k) => k !== 'forklift' && unitsOf(k) > 0);
  const sFull = fullPhased ? tvE(dTR) + lift + tvL(dTR) + (fullMovers ? 0 : tvE(dTS) + tvL(dTS)) : tvE(dRS) + lift + tvL(dRS);
  const lamFull = { avg: fullPal / 3600, peak: fullPal / 3600 };
  const triLoad = (key: 'avg' | 'peak') => (triageByFork ? lamIn[key] * cs.pDamaged : 0);
  const mixS = (a: { avg: number; peak: number }, b: { avg: number; peak: number }, key: 'avg' | 'peak') => {
    const l = a[key] + b[key] + triLoad(key) + lamFull[key];
    return l > 0 ? (a[key] * sIn + b[key] * sOut + triLoad(key) * sTri + lamFull[key] * sFull) / l : sIn;
  };
  // variabilidade do serviço (aprox.): soma de variâncias das componentes estocásticas
  const varS = distScv(ops.unloadPallet) * distMean(ops.unloadPallet) ** 2 + distScv(ops.putawayPosition) * distMean(ops.putawayPosition) ** 2 + distScv(ops.loadPallet) * distMean(ops.loadPallet) ** 2 + (0.35 * (tvE(dIn) + tvL(dIn))) ** 2;
  const scvF = varS / Math.max(1, mixS(lamIn, lamOut, 'avg') ** 2);
  // dispersão de chegadas de paletes (processo de Poisson composto): IDC = E[B²]/E[B]
  const idc = (b: { mean: number; sd: number }) => (b.mean > 0 ? (b.sd ** 2 + b.mean ** 2) / b.mean : 1);
  const ca2F = (() => {
    const l = lamIn.avg + lamOut.avg || 1;
    return (lamIn.avg * idc(bIn) + lamOut.avg * idc(bOut)) / l;
  })();
  // empilhadeiras em modo "chegadas em lote": o tempo de espera cresce com o lote; limitamos a ca2 para refletir paralelismo
  const ca2Eff = ca2F;
  const wt = sc.targetWaitP95Min * 60;
  const mkRow = (
    key: string, name: string, unit: string, current: number, avail: number, lamAvg: number, lamPeak: number, sAvg: number, sPeak: number, scv: number, ca2: number, note: string,
  ): ResourceRow => {
    const szA = sizeServers({ lambda: lamAvg, meanS: sAvg, scvS: scv, availability: avail, targetUtil: sc.targetUtilization, waitTarget: wt, confidence: sc.serviceLevel, ca2 });
    const szP = sizeServers({ lambda: lamPeak, meanS: sPeak, scvS: scv, availability: avail, targetUtil: sc.targetUtilization, waitTarget: wt, confidence: sc.serviceLevel, ca2 });
    const mA = ggcMetrics(Math.max(current, 0.0001), lamAvg / avail, sAvg, scv, ca2);
    const mP = ggcMetrics(Math.max(current, 0.0001), lamPeak / avail, sPeak, scv, ca2);
    return {
      key, name, unit, current, requiredAvg: szA.servers, requiredPeak: szP.servers,
      demandPerHourAvg: lamAvg * 3600, demandPerHourPeak: lamPeak * 3600,
      capacityPerHour: sPeak > 0 ? ((current * avail) / sPeak) * 3600 : 0,
      rhoAvg: mA.rho, rhoPeak: mP.rho, waitP95MinPeak: mP.stable ? mP.waitQuantile(0.95) / 60 : Infinity,
      meanServiceSec: sAvg, note, status: statusOf(mP.rho, sc.targetUtilization),
    };
  };
  const rows: ResourceRow[] = [];
  rows.push(mkRow('forklift', 'Empilhadeiras', 'unid.', fk.count, fk.availability, lamIn.avg + lamOut.avg + triLoad('avg') + lamFull.avg, lamIn.peak + lamOut.peak + triLoad('peak') + lamFull.peak, mixS(lamIn, lamOut, 'avg'), mixS(lamIn, lamOut, 'peak'), scvF, ca2Eff,
    `Tarefa média ${mixS(lamIn, lamOut, 'avg').toFixed(0)} s (entrada ${sIn.toFixed(0)} s, saída ${sOut.toFixed(0)} s${stageOut ? ', carregando a partir do stage' : ''}${fullOn ? `, palete full ${sFull.toFixed(0)} s` : ''}); chegadas em lote (IDC≈${ca2F.toFixed(1)}).${phased ? ' Armazenagem faseada: a empilhadeira faz a etapa 2' + (step1Movers ? '' : ' e também a etapa 1 (sem equipamento de etapa 1)') + '.' : ''}${shareFkUnload < 1 ? ` ${(100 * (1 - shareFkUnload)).toFixed(0)}% da descarga é feita por outros equipamentos.` : ''}${triageByFork ? ' Inclui o transporte das avarias à triagem.' : ''}`));

  // operários: picking (legado por pedido ou por palete com rota) + etapas da expedição feitas por operários
  const nLines = sc.linesPerOrder.mean;
  const cartons = sc.cartonsPerLine.mean;
  const wk = sc.workers;
  const walkTime = (d: number) => d / Math.max(0.1, wk.speedEmpty);
  const pickT = distMean(ops.pickCarton) * cartons * nLines;
  const walkT = walkTime(dInd) * 1 + walkTime(dInd * 0.6) * Math.max(0, nLines - 1) + walkTime(dInd);
  const induct_t = w.conveyors.length ? (cartons * nLines * sc.conveyorSpacing) / (w.conveyors[0].speed || 0.6) : cartons * nLines * 1.5;
  const sOrd = pickT + walkT + induct_t;
  const scvO = Math.max(0.15, (distScv(ops.pickCarton) / Math.max(1, cartons * nLines)) + 0.25);
  const wCls: Cls[] = [];
  if (pickOn && prof) wCls.push({ lam: { avg: (ord.avg * prof.partsPerOrder) / 3600, peak: (ord.peak * prof.partsPerOrder) / 3600 }, s: prof.partSec });
  else if (!pickOn) wCls.push({ lam: { avg: ord.avg / 3600, peak: ord.peak / 3600 }, s: sOrd });
  const wExp = expClasses('worker');
  wCls.push(...wExp);
  const wAgg = aggCls(wCls);
  {
    const pickTxt = pickOn && prof
      ? `Picking por palete: ${prof.boxesPerOrder.toFixed(0)} caixas por pedido em ${prof.partsPerOrder.toFixed(1)} rota(s), ${prof.partSec.toFixed(0)} s por rota (${pk.route === 'u' ? 'em U' : 'zigue-zague'}; em U ${prof.uPartSec.toFixed(0)} s × zigue-zague ${prof.zPartSec.toFixed(0)} s), ${prof.palletsPerOrder.toFixed(1)} palete(s) por pedido`
      : !pickOn ? `Pedido médio: ${nLines.toFixed(1)} linhas × ${cartons.toFixed(1)} caixas; ${sOrd.toFixed(0)} s por pedido (picking ${pickT.toFixed(0)} s + deslocamento ${walkT.toFixed(0)} s)` : 'Picking por palete sem endereços de coleta';
    rows.push(mkRow('worker', pickOn ? 'Operários (separação / expedição)' : 'Operários (picking)', 'pessoas', wk.count, wk.availability, wAgg.la, wAgg.lp, wAgg.sa, wAgg.sp || wAgg.sa, pickOn ? 0.35 : scvO, 1,
      `${pickTxt}${wExp.length ? `; expedição: ${wExp.map((c) => `${(c.lam.avg * 3600).toFixed(1)}/h × ${c.s.toFixed(0)} s`).join(', ')}` : ''}.`));
  }

  // docas
  const cEffIn = Math.max(1, Math.min(bIn.mean, fk.count * fk.availability * 0.5));
  const insideIn = distMean(ops.unloadPallet) + tvE(depthM) + tvL(depthM);
  // com exclusividade só um equipamento trabalha dentro do veículo: a parte de dentro é serial; a aproximação se sobrepõe
  const dockSIn = sc.vehicleExclusive ? vIn.dockSec + tvE(dIn) + bIn.mean * insideIn : vIn.dockSec + (bIn.mean * (tvE(dIn) + insideIn)) / cEffIn;
  const cEffOut = Math.max(1, Math.min(bOut.mean, fk.count * fk.availability * 0.5));
  const insideOut = distMean(ops.loadPallet) + tvE(depthOutM) + tvL(depthOutM);
  // carga a partir do stage: espera pela carga completa (se a separação é mais lenta que os caminhões) + etapas da expedição + embarque
  const loadReady = stageOut && supply.avg > 0 && supply.avg < demandPal.avg ? (nLoad * 3600) / supply.avg : 0;
  let expPre = 0; // etapas antes do embarque (os paletes continuam no stage)
  let expClose = 0; // registro, lacre e tarefas depois de embarcar
  for (const st of exSteps) {
    if (st.type === 'conference') expPre += st.timing === 'later' ? parSec(Math.round(nLoad), confSec, st.resource) : 0;
    else if (st.type === 'reconcile') expPre += distMean(st.time) + st.divergencePct * distMean(st.correctionTime);
    else if (st.type === 'customize') expPre += parSec(Math.round(nLoad * st.pickPct), distMean(st.time), st.resource);
    else if (st.type !== 'board') expClose += distMean(st.time);
  }
  const expDock = expPre + expClose;
  const boardLeg = stageOut ? tvE(dSD) + tvL(dSD) : tvE(dOut) + lift + tvL(dOut);
  const dockSOut = (sc.vehicleExclusive ? vOut.dockSec + boardLeg + bOut.mean * insideOut : vOut.dockSec + (bOut.mean * sOut) / cEffOut) + loadReady + expDock;
  rows.push(mkRow('dockIn', 'Docas de recebimento', 'docas', w.docksIn.length, 1, tin.avg / 3600, tin.peak / 3600, dockSIn, dockSIn, 0.3, 1, `Ocupação por caminhão ≈ ${(dockSIn / 60).toFixed(0)} min (manobra + descarga com ${cEffIn.toFixed(1)} empilhadeiras efetivas).`));
  rows.push(mkRow('dockOut', 'Docas de expedição', 'docas', w.docksOut.length, 1, tout.avg / 3600, tout.peak / 3600, dockSOut, dockSOut, 0.3, 1, `Ocupação por caminhão ≈ ${(dockSOut / 60).toFixed(0)} min${stageOut ? ` (carga de ${nLoad.toFixed(0)} paletes: ${loadReady > 0 ? `espera pelos paletes separados ${(loadReady / 60).toFixed(0)} min + ` : ''}etapas ${(expDock / 60).toFixed(0)} min + embarque)` : ''}.`));

  // esteiras (capacidade em caixas/h)
  if (w.conveyors.length) {
    const cartonsHourAvg = (ord.avg * nLines * cartons);
    const cartonsHourPeak = (ord.peak * nLines * cartons);
    const capH = w.conveyors.reduce((s, c) => s + (3600 * c.speed) / sc.conveyorSpacing, 0);
    rows.push({
      key: 'conveyor', name: 'Esteiras', unit: 'esteiras', current: w.conveyors.length, requiredAvg: Math.ceil(cartonsHourAvg / (capH / w.conveyors.length) / sc.targetUtilization) || 0,
      requiredPeak: Math.ceil(cartonsHourPeak / (capH / w.conveyors.length) / sc.targetUtilization) || 0, demandPerHourAvg: cartonsHourAvg, demandPerHourPeak: cartonsHourPeak,
      capacityPerHour: capH, rhoAvg: cartonsHourAvg / capH, rhoPeak: cartonsHourPeak / capH, waitP95MinPeak: 0, meanServiceSec: sc.conveyorSpacing / (w.conveyors[0].speed || 0.6),
      note: `Vazão = v/passo = ${(3600 * w.conveyors[0].speed / sc.conveyorSpacing).toFixed(0)} caixas/h por esteira.`, status: statusOf(cartonsHourPeak / capH, sc.targetUtilization),
    });
  }

  /* ---- recebimento, armazenagem faseada e AMR (estimativas) ---- */
  const lamTot = (l: { avg: number; peak: number }, key: 'avg' | 'peak') => l[key] + lamOut[key] + triLoad(key) + lamFull[key];
  const fkM = (key: 'avg' | 'peak') => ggcMetrics(Math.max(fk.count, 0.0001), lamTot(lamIn, key) / fk.availability, mixS(lamIn, lamOut, key), scvF, ca2Eff);
  const wqFk = (key: 'avg' | 'peak') => {
    const m = fkM(key);
    return Number.isFinite(m.wq) ? m.wq : 3600; // fila instável: limita em 1 h
  };
  const z = normInv(sc.serviceLevel);
  /** linha de "capacidade de espaço": L = λ·W (Little), com dispersão de lote (IDC) para o dimensionamento */
  const spaceRow = (key: string, name: string, unit: string, current: number, lamAvg: number, lamPeak: number, wAvg: number, wPeak: number, idcF: number, batchPeak: number, note: string): ResourceRow => {
    const Lavg = lamAvg * wAvg;
    const Lpeak = lamPeak * wPeak;
    const need = (L: number) => Math.ceil(L + z * Math.sqrt(Math.max(0, L) * Math.max(1, idcF)));
    const reqPeak = Math.max(Lpeak > 0 ? need(Lpeak) : 0, Math.ceil(batchPeak));
    const rhoPeak = current > 0 ? reqPeak / current : Infinity;
    return {
      key, name, unit, current, requiredAvg: Lavg > 0 ? need(Lavg) : 0, requiredPeak: reqPeak,
      demandPerHourAvg: lamAvg * 3600, demandPerHourPeak: lamPeak * 3600, capacityPerHour: wPeak > 0 ? (current / wPeak) * 3600 : 0,
      rhoAvg: current > 0 ? Lavg / current : Infinity, rhoPeak, waitP95MinPeak: 0, meanServiceSec: wAvg, note: `Estimativa: ${note}`,
      status: statusOf(rhoPeak, sc.targetUtilization),
    };
  };
  const idcIn = idc(bIn);
  // pior caso de lote: um caminhão despeja ~B paletes de uma vez; enquanto o lote escoa, chegam outros caminhões (limitado pelas docas)
  const Bq = bIn.mean + z * bIn.sd;
  const trucksPeakPerSec = tin.peak / 3600;
  const concurrent = (drainSec: number) => Math.min(Math.max(1, w.docksIn.length), 1 + trucksPeakPerSec * drainSec);

  // conferentes: conferência + triagem por palete (avaria aumenta o tempo)
  let chkM: ReturnType<typeof ggcMetrics> | null = null;
  const chkExp = staged ? expClasses('checker') : [];
  if (staged) {
    const sChk = Math.max(1, cs.serviceMean);
    const cAgg = aggCls([{ lam: lamIn, s: sChk }, ...chkExp]);
    const scvC = chkExp.length ? 0.5 : Math.max(0.05, cs.serviceScv);
    rows.push(mkRow('checker', 'Conferentes', 'pessoas', sc.checkers.count, sc.checkers.availability, cAgg.la, cAgg.lp, cAgg.sa, cAgg.sp, scvC, idcIn,
      `Estimativa: recebimento ${sChk.toFixed(0)} s por palete (conferência ${distMean(ops.checkPallet).toFixed(0)} s${cs.pDamaged > 0 ? `; ${(cs.pDamaged * 100).toFixed(1)}% avariados com +${((sc.receiving.damagedCheckFactor - 1) * 100).toFixed(0)}% de tempo e triagem de ~${cs.meanBadPartial.toFixed(0)} caixas × ${distMean(ops.triageCarton).toFixed(0)} s` : ''})${chkExp.length ? `; expedição: ${chkExp.map((c) => `${(c.lam.avg * 3600).toFixed(1)}/h × ${c.s.toFixed(0)} s`).join(', ')}` : ''}.`));
    chkM = ggcMetrics(Math.max(sc.checkers.count, 0.0001), cAgg.la / sc.checkers.availability, cAgg.sa, scvC, idcIn);
  }

  // equipamentos sem elevação: etapa 1 da faseada, transporte das avarias e descarga (quando permitida)
  if (moverUnits > 0) {
    const shareMoverUnload = 1 - shareFkUnload;
    const classes: { lam: number; lamPk: number; s: number }[] = [];
    if (phased && step1Movers) classes.push({ lam: lamIn.avg * (1 - cs.pDamaged * cs.pWhole), lamPk: lamIn.peak * (1 - cs.pDamaged * cs.pWhole), s: tvEm(dST) + tvLm(dST) });
    if (staged && cs.pDamaged > 0) classes.push({ lam: lamIn.avg * cs.pDamaged, lamPk: lamIn.peak * cs.pDamaged, s: tvEm(dStageTri) + tvLm(dStageTri) });
    if (fullMovers) classes.push({ lam: lamFull.avg, lamPk: lamFull.peak, s: tvEm(dTS) + tvLm(dTS) });
    if (stageOut && shareFkLoad < 1) classes.push({ lam: (flow('avg') * (1 - shareFkLoad)) / 3600, lamPk: (flow('peak') * (1 - shareFkLoad)) / 3600, s: tvEm(dSD) + tvLm(dSD) + distMean(ops.loadPallet) + tvEm(depthOutM) + tvLm(depthOutM) });
    if (shareMoverUnload > 0) classes.push({ lam: lamIn.avg * shareMoverUnload, lamPk: lamIn.peak * shareMoverUnload, s: unloadT + tvEm(depthM) + tvLm(depthM) + tvEm(2.5) + tvLm(2.5) });
    const lamA = classes.reduce((a, c) => a + c.lam, 0);
    const lamP = classes.reduce((a, c) => a + c.lamPk, 0);
    if (lamA > 0) {
      const sA = classes.reduce((a, c) => a + c.lam * c.s, 0) / lamA;
      const sP = lamP > 0 ? classes.reduce((a, c) => a + c.lamPk * c.s, 0) / lamP : sA;
      const parts = [phased && step1Movers ? 'etapa 1' : '', fullMovers ? 'palete full → stage' : '', stageOut && shareFkLoad < 1 ? 'carga do stage' : '', staged && cs.pDamaged > 0 ? 'avarias → triagem' : '', shareMoverUnload > 0 ? 'descarga' : ''].filter(Boolean).join(' + ');
      // 1ª passada (sem carga) estima a utilização; dela sai o tempo do AMR em carga, que reduz a disponibilidade
      const util0 = (lamA * sA) / Math.max(1e-9, moverUnits * mvAvailAt(0));
      amrChargeShare = amrShareAt(Math.min(1, util0));
      const mvAvail = mvAvailAt(amrChargeShare);
      rows.push(mkRow('mover', 'Paleteiras / transpaleteiras / AMR', 'unid.', moverUnits, Math.max(0.05, mvAvail), lamA, lamP, sA, sP, 0.3, idcIn,
        `Estimativa (${parts}): ${sA.toFixed(0)} s por tarefa${amrSpec ? `; AMR gastam ${(amrChargeShare * 100).toFixed(0)}% do tempo em carga/setup (já descontado da disponibilidade)` : ''}.`));
    }
  }

  // stage: paletes no chão entre a descarga e a retirada (Little)
  if (staged && w.stages.length) {
    const sChk = Math.max(1, cs.serviceMean);
    const wqC = (m: ReturnType<typeof ggcMetrics> | null) => (m && Number.isFinite(m.wq) ? m.wq : 3600);
    const wStage = wqC(chkM) + sChk + wqFk('avg') + tvE(2.5);
    const drain = (Bq * sChk) / Math.max(1, sc.checkers.count * sc.checkers.availability);
    rows.push(spaceRow('stage', 'Stage do recebimento', 'paletes', w.stages.reduce((n, x) => n + x.capacity, 0), lamIn.avg, lamIn.peak, wStage, wStage * 1.5, idcIn, Bq * concurrent(drain),
      `cada palete fica ~${(wStage / 60).toFixed(1)} min no stage (fila do conferente ${(wqC(chkM) / 60).toFixed(1)} min + conferência/triagem ${(sChk / 60).toFixed(1)} min + espera pela empilhadeira); o pico considera o lote de ~${Bq.toFixed(0)} paletes de um caminhão (percentil ${(sc.serviceLevel * 100).toFixed(0)}%) mais os que chegam enquanto ele é conferido.`));
  }

  // balanço entre o que a separação entrega ao stage de expedição e o que os caminhões levam
  if (stageOut) {
    const rA = supply.avg > 0 ? demandPal.avg / supply.avg : Infinity;
    const rP = supply.peak > 0 ? demandPal.peak / supply.peak : Infinity;
    const hasSrc = supply.avg > 0;
    rows.push({
      key: 'supply', name: 'Separação × carga de saída', unit: 'paletes/h', current: supply.avg, requiredAvg: Math.ceil(demandPal.avg), requiredPeak: Math.ceil(demandPal.peak),
      demandPerHourAvg: demandPal.avg, demandPerHourPeak: demandPal.peak, capacityPerHour: supply.avg, rhoAvg: rA, rhoPeak: rP, waitP95MinPeak: 0, meanServiceSec: supply.avg > 0 ? 3600 / supply.avg : 0,
      note: !hasSrc ? 'Nenhum palete chega ao stage de expedição: ative a separação por palete e/ou o palete full, senão os caminhões esperam para sempre.'
        : `Entregam ao stage ${supply.avg.toFixed(1)} paletes/h (picking ${pickPal.avg.toFixed(1)} + full ${fullPal.toFixed(1)}); os caminhões levam ${demandPal.avg.toFixed(1)} paletes/h (${tout.avg.toFixed(2)} caminhões/h × ${nLoad.toFixed(0)}). ${rA > 1.05 ? 'A demanda supera a separação: os caminhões esperam a carga.' : rA < 0.8 ? 'A separação supera a carga: o stage acumula paletes.' : 'Fluxos equilibrados.'}`,
      status: !hasSrc || rA > 1.05 ? 'critico' : rA < 0.8 ? 'atencao' : 'ok',
    });
  }

  // stage de expedição: paletes entre a chegada da separação e o embarque (Little)
  if (stageOut && w.stagesOut.length) {
    const form = supply.avg > 0 ? (nLoad * 3600) / supply.avg / 2 : 0; // metade do tempo de formar a carga
    const boardSec = boardLeg + bOut.mean * insideOut;
    const confW = exSteps.some((x) => x.type === 'conference' && x.timing === 'simultaneous') ? confSec * 1.5 : 0;
    const wOut = form + confW + expPre + boardSec / 2;
    const concOut = Math.min(Math.max(1, w.docksOut.length), 1 + (tout.peak / 3600) * dockSOut);
    const capOut = w.stagesOut.reduce((n, x) => n + x.capacity, 0);
    rows.push(spaceRow('stageOut', 'Stage de expedição', 'paletes', capOut, flow('avg') / 3600, flow('peak') / 3600, wOut, wOut * 1.5, 1, nLoad * concOut,
      `cada palete fica ~${(wOut / 60).toFixed(1)} min no stage (formação da carga ${(form / 60).toFixed(1)} min${confW ? ` + conferência ${(confW / 60).toFixed(1)} min` : ''} + etapas antes do embarque ${(expPre / 60).toFixed(1)} min + embarque); o pico garante ${nLoad.toFixed(0)} paletes por carga em até ${concOut.toFixed(1)} carga(s) simultânea(s).`));
  }

  // endereços transitórios (faseada): do depósito na rua até a empilhadeira pegar
  if (phased && w.transits.length) {
    const lamS = (key: 'avg' | 'peak') => lamIn[key] * (1 - cs.pDamaged * cs.pWhole) + (fullPhased ? lamFull[key] : 0);
    const wT = wqFk('avg') + tvE(dTR);
    const drainT = (Bq * (tvE(dTR) + tvL(dTR) + lift)) / Math.max(1, fk.count * fk.availability);
    rows.push(spaceRow('transit', 'Endereços transitórios (ruas)', 'paletes', w.transits.reduce((n, x) => n + x.capacity, 0), lamS('avg'), lamS('peak'), wT, Math.max(wT, wqFk('peak') + tvE(dTR)), idcIn, Bq * (1 - cs.pDamaged * cs.pWhole) * concurrent(drainT),
      `cada palete espera ~${(wT / 60).toFixed(1)} min na rua até a empilhadeira (etapa 2); soma de todas as ruas, sem considerar desequilíbrio entre elas; o pico é o pior caso de lote (todos os paletes do caminhão e dos simultâneos ainda esperando a etapa 2).`));
  }

  // áreas de triagem: acumulam até a coleta periódica
  if (staged && cs.pDamaged > 0 && w.triages.length) {
    const clearH = sc.receiving.triageClearEveryHours > 0 ? sc.receiving.triageClearEveryHours : sc.days * sc.shiftHours;
    const aAvg = lamIn.avg * cs.pDamaged * 3600 * clearH;
    const aPeak = lamIn.peak * cs.pDamaged * 3600 * clearH;
    const cap = w.triages.reduce((n, x) => n + x.capacity, 0);
    rows.push({
      key: 'triage', name: 'Áreas de triagem', unit: 'paletes', current: cap, requiredAvg: Math.ceil(aAvg), requiredPeak: Math.ceil(aPeak),
      demandPerHourAvg: lamIn.avg * cs.pDamaged * 3600, demandPerHourPeak: lamIn.peak * cs.pDamaged * 3600, capacityPerHour: clearH > 0 ? cap / clearH : 0,
      rhoAvg: cap > 0 ? aAvg / cap : Infinity, rhoPeak: cap > 0 ? aPeak / cap : Infinity, waitP95MinPeak: 0, meanServiceSec: clearH * 3600,
      note: `Estimativa: ${(cs.pDamaged * 100).toFixed(1)}% dos paletes viram palete de avarias e se acumulam por ${clearH.toFixed(0)} h até a coleta (${sc.receiving.triageClearEveryHours > 0 ? 'periódica' : 'sem coleta: todo o período simulado'}).`,
      status: statusOf(cap > 0 ? aPeak / cap : Infinity, 1),
    });
  }

  // estação de carga do AMR
  if (amrSpec?.amr && amrSpec.count > 0) {
    const chargers = w.chargers.reduce((n, x) => n + x.capacity, 0);
    const simult = amrSpec.count * amrChargeShare;
    const calendar = amrChargeHours(sc, amrSpec.amr).length > 0;
    const reqAvg = Math.ceil(simult);
    // nº de AMR carregando ao mesmo tempo ~ Binomial(n, fração do tempo em carga): menor k com P(X>k) ≤ 1−nível de serviço
    const binQuantile = (n: number, p: number, level: number) => {
      let c = 0;
      let pk = (1 - p) ** n;
      for (let k = 0; k <= n; k++) {
        c += pk;
        if (c >= level) return k;
        pk *= ((n - k) / (k + 1)) * (p / Math.max(1e-12, 1 - p));
      }
      return n;
    };
    const reqPeak = calendar ? amrSpec.count : Math.max(reqAvg, binQuantile(amrSpec.count, amrChargeShare, sc.serviceLevel));
    rows.push({
      key: 'charger', name: 'Estação de carga dos AMR', unit: 'vagas', current: chargers, requiredAvg: reqAvg, requiredPeak: reqPeak,
      demandPerHourAvg: amrWorkMin > 0 ? (amrSpec.count * 60) / (amrWorkMin + amrCycleMin) : 0, demandPerHourPeak: amrWorkMin > 0 ? (amrSpec.count * 60) / (amrWorkMin + amrCycleMin) : 0,
      capacityPerHour: amrCycleMin > 0 ? (chargers * 60) / amrCycleMin : 0, rhoAvg: chargers > 0 ? simult / chargers : Infinity, rhoPeak: chargers > 0 ? reqPeak / chargers : Infinity,
      waitP95MinPeak: 0, meanServiceSec: amrCycleMin * 60,
      note: `Estimativa: ciclo de ${amrCycleMin.toFixed(0)} min (carga + setup) a cada ${amrWorkMin.toFixed(0)} min de trabalho; em média ${simult.toFixed(1)} AMR carregando ao mesmo tempo${calendar ? '; o calendário de carga em horário fixo pode juntar todos' : ''}.`,
      status: statusOf(chargers > 0 ? reqPeak / chargers : Infinity, 1),
    });
  }

  /* ---- armazenagem ---- */
  const lamPalletDay = pIn.daily * (1 - cs.pDamaged * cs.pWhole); // paletes/dia que entram no estoque (os avariados inteiros vão para a triagem)
  const L = little.L(lamPalletDay, sc.dwellDays); // Little: L = λ·W
  const positions = w.totalCapacity;
  // variância diária de saída (Poisson composto): λ·E[B²] por dia
  const dailyOutVar = tout.daily * (bOut.sd ** 2 + bOut.mean ** 2);
  const ss = safetyStock(z, Math.sqrt(dailyOutVar), Math.sqrt(Math.max(1, sc.dwellDays / 4)));
  const need = poissonQuantile(Math.max(L, 0), sc.serviceLevel);
  const drift = lamPalletDay - pOut.daily;
  const stockNow = sc.initialOccupancy * positions;
  const storage: StorageReport = {
    positions,
    expectedPallets: L,
    expectedOccupancy: positions ? L / positions : 0,
    pOverflow: poissonSf(Math.max(L, 0), positions),
    positionsForServiceLevel: Math.ceil(need + ss),
    safetyStockPallets: ss,
    dailyInPallets: lamPalletDay,
    dailyOutPallets: pOut.daily,
    netDailyDrift: drift,
    daysToFull: drift > 0 ? (positions - stockNow) / drift : -1,
  };

  return {
    rows, storage,
    travel: { dockToRackIn: dIn, rackToDockOut: dOut, rackToInduction: dInd },
    assumptions: [
      ...(sc.useCustomProcesses ? ['⚠ Processo personalizado ativo: esta análise analítica continua modelando o FLUXO PADRÃO (recebimento, armazenagem, separação, palete full e expedição) e não lê os blocos dos processos. Use a simulação Monte Carlo para avaliar o processo personalizado.'] : []),
      'Chegadas de caminhões e pedidos: processo de Poisson não homogêneo (taxa por hora).',
      'Paletes por caminhão: normal truncada → chegadas de paletes em lote (Poisson composto); dispersão IDC = E[B²]/E[B].',
      'Espera em fila: aproximação de Allen–Cunneen para G/G/c com cauda exponencial (P(Wq>t)).',
      'Estoque: pelo teorema de Little (L=λ·W) e modelo M/G/∞ (Poisson) para a probabilidade de estouro de posições.',
      'Distâncias: grade de navegação com obstáculos (racks/paredes) via Dijkstra/A*; velocidade com aceleração constante.',
      `Disponibilidade dos recursos aplicada à carga (λ/A).`,
      'Recebimento (estimativa): o tempo de conferência + triagem por palete é amostrado das mesmas distribuições da simulação (semente fixa); paletes avariados inteiros não entram no estoque; sem equipamento sem elevação, a empilhadeira leva as avarias à triagem.',
      'Veículo (estimativa): com exclusividade só um equipamento (ou operário com paleteira) trabalha dentro do baú por vez, nos dois sentidos; a ocupação da doca soma o trabalho de dentro em série. Paleteira manual leva um operário do pool de operários (a análise não desconta esse operário do dimensionamento de picking).',
      'Descarga (estimativa): a parcela feita por empilhadeira é proporcional ao número de unidades permitidas; a distância dentro do baú usa a profundidade média por tipo de veículo.',
      'Armazenagem faseada (estimativa): a empilhadeira faz a etapa 2 (do transitório ao endereço) e, sem equipamento de etapa 1, também a etapa 1; os transitórios são tratados em conjunto, sem desequilíbrio entre ruas.',
      'Stage, transitórios e triagem: ocupação por Little (L=λ·W) com folga de lote (IDC) no dimensionamento; a triagem acumula até a coleta periódica.',
      'Separação por palete (estimativa): amostra 40 pedidos com semente fixa (mesmas regras de sorteio de caixas, curvas A/B/C e posições da simulação), planeja a rota em U e em zigue-zague, e soma manuseio (leitura + pegar + colocar), deslocamento, viagens de palete cheio ao stage e furos de estoque por rota de um separador; os pedidos são divididos entre os separadores por rua.',
      'Palete full (estimativa): a empilhadeira retira do endereço e leva ao stage (faseada: baixa no transitório e outro equipamento leva ao stage); a taxa é pedidos/h × paletes por pedido × fator de demanda.',
      'Expedição (estimativa): com carga a partir do stage ou expedição por etapas, o fluxo no stage é o menor entre a oferta da separação e a demanda dos caminhões; o conferente/operário recebe, por carga, conferência (por palete), batimento (+ divergência), customização (pickPct × paletes), registro, lacre e tarefas; o embarque usa a distância stage → doca e o trabalho em série dentro do baú; a doca de saída fica ocupada também enquanto espera a carga ficar pronta.',
      'AMR (estimativa): o tempo em carga/setup (ciclo a cada fração da autonomia + cargas por calendário) é descontado da disponibilidade; vagas de carga pela média e pelo pico (calendário junta todos).',
    ],
  };
}
