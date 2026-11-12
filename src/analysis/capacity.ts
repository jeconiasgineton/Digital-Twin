import { amrChargeHours } from '../model/equipment';
import { checkStats } from '../model/receiving';
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
  const bOut = { ...sc.palletsPerTruckOut, mean: vOut.pallets };
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
  const fkUnloadT = shareFkUnload * (unloadT + tvE(depthM) + tvL(depthM));

  // tarefa de entrada da empilhadeira: vazio até o palete, [descarga + baú], [stage], guarda (direta ou etapa 2)
  const putawayLeg = phased ? tvE(dTR) + tvL(dTR) : tvE(dIn) + tvL(dIn);
  const step1ByFork = phased && !step1Movers ? tvE(dST) + tvL(dST) : 0;
  const sIn = putawayLeg + fkUnloadT + stageEx + step1ByFork + lift;
  const sOut = tvE(dOut) + lift + tvL(dOut) + distMean(ops.loadPallet);
  const lamIn = { avg: pIn.avg / 3600, peak: pIn.peak / 3600 };
  const triageByFork = staged && cs.pDamaged > 0 && moverUnits === 0; // sem paleteira/transpaleteira/AMR a empilhadeira leva as avarias
  const sTri = tvE(dStageTri) + tvL(dStageTri);
  const lamOut = { avg: pOut.avg / 3600, peak: pOut.peak / 3600 };
  const triLoad = (key: 'avg' | 'peak') => (triageByFork ? lamIn[key] * cs.pDamaged : 0);
  const mixS = (a: { avg: number; peak: number }, b: { avg: number; peak: number }, key: 'avg' | 'peak') => {
    const l = a[key] + b[key] + triLoad(key);
    return l > 0 ? (a[key] * sIn + b[key] * sOut + triLoad(key) * sTri) / l : sIn;
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
  rows.push(mkRow('forklift', 'Empilhadeiras', 'unid.', fk.count, fk.availability, lamIn.avg + lamOut.avg + triLoad('avg'), lamIn.peak + lamOut.peak + triLoad('peak'), mixS(lamIn, lamOut, 'avg'), mixS(lamIn, lamOut, 'peak'), scvF, ca2Eff,
    `Tarefa média ${mixS(lamIn, lamOut, 'avg').toFixed(0)} s (entrada ${sIn.toFixed(0)} s, saída ${sOut.toFixed(0)} s); chegadas em lote (IDC≈${ca2F.toFixed(1)}).${phased ? ' Armazenagem faseada: a empilhadeira faz a etapa 2' + (step1Movers ? '' : ' e também a etapa 1 (sem equipamento de etapa 1)') + '.' : ''}${shareFkUnload < 1 ? ` ${(100 * (1 - shareFkUnload)).toFixed(0)}% da descarga é feita por outros equipamentos.` : ''}${triageByFork ? ' Inclui o transporte das avarias à triagem.' : ''}`));

  // workers (picking): serviço por pedido
  const nLines = sc.linesPerOrder.mean;
  const cartons = sc.cartonsPerLine.mean;
  const wk = sc.workers;
  const walkTime = (d: number) => d / Math.max(0.1, wk.speedEmpty);
  const pickT = distMean(ops.pickCarton) * cartons * nLines;
  const walkT = walkTime(dInd) * 1 + walkTime(dInd * 0.6) * Math.max(0, nLines - 1) + walkTime(dInd);
  const induct_t = w.conveyors.length ? (cartons * nLines * sc.conveyorSpacing) / (w.conveyors[0].speed || 0.6) : cartons * nLines * 1.5;
  const sOrd = pickT + walkT + induct_t;
  const scvO = Math.max(0.15, (distScv(ops.pickCarton) / Math.max(1, cartons * nLines)) + 0.25);
  rows.push(mkRow('worker', 'Operários (picking)', 'pessoas', wk.count, wk.availability, ord.avg / 3600, ord.peak / 3600, sOrd, sOrd, scvO, 1,
    `Pedido médio: ${nLines.toFixed(1)} linhas × ${cartons.toFixed(1)} caixas; ${sOrd.toFixed(0)} s por pedido (picking ${pickT.toFixed(0)} s + deslocamento ${walkT.toFixed(0)} s).`));

  // docas
  const cEffIn = Math.max(1, Math.min(bIn.mean, fk.count * fk.availability * 0.5));
  const dockSIn = vIn.dockSec + (bIn.mean * (tvE(dIn) + distMean(ops.unloadPallet) + tvE(depthM) + tvL(depthM))) / cEffIn;
  const cEffOut = Math.max(1, Math.min(bOut.mean, fk.count * fk.availability * 0.5));
  const dockSOut = vOut.dockSec + (bOut.mean * sOut) / cEffOut;
  rows.push(mkRow('dockIn', 'Docas de recebimento', 'docas', w.docksIn.length, 1, tin.avg / 3600, tin.peak / 3600, dockSIn, dockSIn, 0.3, 1, `Ocupação por caminhão ≈ ${(dockSIn / 60).toFixed(0)} min (manobra + descarga com ${cEffIn.toFixed(1)} empilhadeiras efetivas).`));
  rows.push(mkRow('dockOut', 'Docas de expedição', 'docas', w.docksOut.length, 1, tout.avg / 3600, tout.peak / 3600, dockSOut, dockSOut, 0.3, 1, `Ocupação por caminhão ≈ ${(dockSOut / 60).toFixed(0)} min.`));

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
  const lamTot = (l: { avg: number; peak: number }, key: 'avg' | 'peak') => l[key] + lamOut[key] + triLoad(key);
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
  if (staged) {
    const sChk = Math.max(1, cs.serviceMean);
    rows.push(mkRow('checker', 'Conferentes', 'pessoas', sc.checkers.count, sc.checkers.availability, lamIn.avg, lamIn.peak, sChk, sChk, Math.max(0.05, cs.serviceScv), idcIn,
      `Estimativa: ${sChk.toFixed(0)} s por palete (conferência ${distMean(ops.checkPallet).toFixed(0)} s${cs.pDamaged > 0 ? `; ${(cs.pDamaged * 100).toFixed(1)}% avariados com +${((sc.receiving.damagedCheckFactor - 1) * 100).toFixed(0)}% de tempo e triagem de ~${cs.meanBadPartial.toFixed(0)} caixas × ${distMean(ops.triageCarton).toFixed(0)} s` : ''}).`));
    chkM = ggcMetrics(Math.max(sc.checkers.count, 0.0001), lamIn.avg / sc.checkers.availability, sChk, Math.max(0.05, cs.serviceScv), idcIn);
  }

  // equipamentos sem elevação: etapa 1 da faseada, transporte das avarias e descarga (quando permitida)
  if (moverUnits > 0) {
    const shareMoverUnload = 1 - shareFkUnload;
    const classes: { lam: number; lamPk: number; s: number }[] = [];
    if (phased && step1Movers) classes.push({ lam: lamIn.avg * (1 - cs.pDamaged * cs.pWhole), lamPk: lamIn.peak * (1 - cs.pDamaged * cs.pWhole), s: tvEm(dST) + tvLm(dST) });
    if (staged && cs.pDamaged > 0) classes.push({ lam: lamIn.avg * cs.pDamaged, lamPk: lamIn.peak * cs.pDamaged, s: tvEm(dStageTri) + tvLm(dStageTri) });
    if (shareMoverUnload > 0) classes.push({ lam: lamIn.avg * shareMoverUnload, lamPk: lamIn.peak * shareMoverUnload, s: unloadT + tvEm(depthM) + tvLm(depthM) + tvEm(2.5) + tvLm(2.5) });
    const lamA = classes.reduce((a, c) => a + c.lam, 0);
    const lamP = classes.reduce((a, c) => a + c.lamPk, 0);
    if (lamA > 0) {
      const sA = classes.reduce((a, c) => a + c.lam * c.s, 0) / lamA;
      const sP = lamP > 0 ? classes.reduce((a, c) => a + c.lamPk * c.s, 0) / lamP : sA;
      const parts = [phased && step1Movers ? 'etapa 1' : '', staged && cs.pDamaged > 0 ? 'avarias → triagem' : '', shareMoverUnload > 0 ? 'descarga' : ''].filter(Boolean).join(' + ');
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

  // endereços transitórios (faseada): do depósito na rua até a empilhadeira pegar
  if (phased && w.transits.length) {
    const lamS = (key: 'avg' | 'peak') => lamIn[key] * (1 - cs.pDamaged * cs.pWhole);
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
      'Chegadas de caminhões e pedidos: processo de Poisson não homogêneo (taxa por hora).',
      'Paletes por caminhão: normal truncada → chegadas de paletes em lote (Poisson composto); dispersão IDC = E[B²]/E[B].',
      'Espera em fila: aproximação de Allen–Cunneen para G/G/c com cauda exponencial (P(Wq>t)).',
      'Estoque: pelo teorema de Little (L=λ·W) e modelo M/G/∞ (Poisson) para a probabilidade de estouro de posições.',
      'Distâncias: grade de navegação com obstáculos (racks/paredes) via Dijkstra/A*; velocidade com aceleração constante.',
      `Disponibilidade dos recursos aplicada à carga (λ/A).`,
      'Recebimento (estimativa): o tempo de conferência + triagem por palete é amostrado das mesmas distribuições da simulação (semente fixa); paletes avariados inteiros não entram no estoque; sem equipamento sem elevação, a empilhadeira leva as avarias à triagem.',
      'Descarga (estimativa): a parcela feita por empilhadeira é proporcional ao número de unidades permitidas; a distância dentro do baú usa a profundidade média por tipo de veículo.',
      'Armazenagem faseada (estimativa): a empilhadeira faz a etapa 2 (do transitório ao endereço) e, sem equipamento de etapa 1, também a etapa 1; os transitórios são tratados em conjunto, sem desequilíbrio entre ruas.',
      'Stage, transitórios e triagem: ocupação por Little (L=λ·W) com folga de lote (IDC) no dimensionamento; a triagem acumula até a coleta periódica.',
      'AMR (estimativa): o tempo em carga/setup (ciclo a cada fração da autonomia + cargas por calendário) é descontado da disponibilidade; vagas de carga pela média e pelo pico (calendário junta todos).',
    ],
  };
}
