import type { Layout, Scenario } from '../model/types';
import { distMean, distScv } from '../math/rng';
import { ggcMetrics, little, safetyStock, sizeServers } from '../math/queueing';
import { normInv, poissonQuantile, poissonSf } from '../math/stats';
import { travelTime } from '../sim/model';
import { type World, buildWorld, meanTravel } from '../sim/world';

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
  const tin = op(sc.inboundTrucksPerHour);
  const tout = op(sc.outboundTrucksPerHour);
  const ord = op(sc.ordersPerHour);
  const bIn = sc.palletsPerTruckIn;
  const bOut = sc.palletsPerTruckOut;
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
  const stageEx = sc.checkers.count > 0 ? tvL(2.5) + 2 * 3 : 0;

  // tarefa de entrada: vazio até doca (≈ dist média), descarga, [conferência], guarda
  const sIn = tvE(dIn) + distMean(ops.unloadPallet) + stageEx + tvL(dIn) + lift;
  const sOut = tvE(dOut) + lift + tvL(dOut) + distMean(ops.loadPallet);
  const lamIn = { avg: pIn.avg / 3600, peak: pIn.peak / 3600 };
  const lamOut = { avg: pOut.avg / 3600, peak: pOut.peak / 3600 };
  const mixS = (a: { avg: number; peak: number }, b: { avg: number; peak: number }, key: 'avg' | 'peak') => {
    const l = a[key] + b[key];
    return l > 0 ? (a[key] * sIn + b[key] * sOut) / l : sIn;
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
  rows.push(mkRow('forklift', 'Empilhadeiras', 'unid.', fk.count, fk.availability, lamIn.avg + lamOut.avg, lamIn.peak + lamOut.peak, mixS(lamIn, lamOut, 'avg'), mixS(lamIn, lamOut, 'peak'), scvF, ca2Eff,
    `Tarefa média ${mixS(lamIn, lamOut, 'avg').toFixed(0)} s (entrada ${sIn.toFixed(0)} s, saída ${sOut.toFixed(0)} s); chegadas em lote (IDC≈${ca2F.toFixed(1)}).`));

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
  const dockSIn = distMean(ops.dockTurnover) + (bIn.mean * (tvE(dIn) + distMean(ops.unloadPallet))) / cEffIn;
  const cEffOut = Math.max(1, Math.min(bOut.mean, fk.count * fk.availability * 0.5));
  const dockSOut = distMean(ops.dockTurnover) + (bOut.mean * sOut) / cEffOut;
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

  /* ---- armazenagem ---- */
  const lamPalletDay = pIn.daily; // paletes/dia que entram
  const L = little.L(lamPalletDay, sc.dwellDays); // Little: L = λ·W
  const positions = w.totalCapacity;
  const z = normInv(sc.serviceLevel);
  // variância diária de saída (Poisson composto): λ·E[B²] por dia
  const dailyOutVar = tout.daily * (bOut.sd ** 2 + bOut.mean ** 2);
  const ss = safetyStock(z, Math.sqrt(dailyOutVar), Math.sqrt(Math.max(1, sc.dwellDays / 4)));
  const need = poissonQuantile(Math.max(L, 0), sc.serviceLevel);
  const drift = pIn.daily - pOut.daily;
  const stockNow = sc.initialOccupancy * positions;
  const storage: StorageReport = {
    positions,
    expectedPallets: L,
    expectedOccupancy: positions ? L / positions : 0,
    pOverflow: poissonSf(Math.max(L, 0), positions),
    positionsForServiceLevel: Math.ceil(need + ss),
    safetyStockPallets: ss,
    dailyInPallets: pIn.daily,
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
    ],
  };
}
