import type { Aggregated, ExperimentResult, Layout, ReplicationResult, RunKpis, Scenario } from '../model/types';
import { summarize } from '../math/stats';
import { SimModel } from './model';
import { Nav, buildWorld } from './world';

const KEYS = (r: RunKpis) => Object.keys(r) as (keyof RunKpis)[];

export function aggregate(reps: ReplicationResult[]): Aggregated {
  const out = {} as Aggregated;
  for (const k of KEYS(reps[0].kpis)) out[k] = summarize(reps.map((r) => r.kpis[k]));
  return out;
}

/** Monte Carlo: executa N replicações independentes (sementes distintas) e agrega com IC 95%. */
export function runExperiment(sc: Scenario, layout: Layout, onProgress?: (done: number, total: number) => void): ExperimentResult {
  const t0 = Date.now();
  const nav = new Nav(layout);
  const reps: ReplicationResult[] = [];
  for (let i = 0; i < sc.replications; i++) {
    const world = buildWorld(layout, sc, nav);
    const m = new SimModel(sc, layout, sc.seed + i * 7919, undefined, world);
    reps.push(m.runAll());
    onProgress?.(i + 1, sc.replications);
  }
  // série por hora do dia operacional: média entre dias e réplicas (perfil intradiário)
  const shift = Math.max(1, Math.round(sc.shiftHours));
  const hourly = Array.from({ length: shift }, (_, hod) => {
    const pts = reps.flatMap((r) => r.hourly.filter((x) => x.hour % shift === hod));
    const avg = (f: (x: ReplicationResult['hourly'][number]) => number) => (pts.length ? pts.reduce((s, x) => s + f(x), 0) / pts.length : 0);
    return {
      hour: hod,
      palletsIn: avg((x) => x.palletsIn), palletsOut: avg((x) => x.palletsOut), orders: avg((x) => x.orders),
      utilForklift: avg((x) => x.utilForklift), utilWorker: avg((x) => x.utilWorker), queueForklift: avg((x) => x.queueForklift),
    };
  });
  const cap = (a: number[]) => (a.length > 6000 ? a.filter((_, i) => i % Math.ceil(a.length / 6000) === 0) : a);
  const cat = (f: (s: ReplicationResult['samples']) => number[]) => cap(reps.flatMap((r) => f(r.samples)));
  const occLen = Math.min(...reps.map((r) => r.occupancySeries.length));
  const occupancySeries = Array.from({ length: occLen }, (_, i) => ({
    t: reps[0].occupancySeries[i].t,
    occ: reps.reduce((s, r) => s + r.occupancySeries[i].occ, 0) / reps.length,
  }));
  return {
    scenario: sc.name,
    replications: reps.length,
    kpis: aggregate(reps),
    hourly,
    samples: {
      orderCycle: cat((s) => s.orderCycle), forkliftWait: cat((s) => s.forkliftWait),
      putawayLead: cat((s) => s.putawayLead), truckTurn: cat((s) => s.truckTurn),
    },
    occupancySeries,
    elapsedMs: Date.now() - t0,
  };
}

export interface SweepPoint {
  value: number;
  label: string;
  kpis: Aggregated;
  ok: boolean;
}

export type SweepParam = 'forklifts' | 'workers' | 'checkers' | 'demand';

/** Varredura de parâmetros (dimensionamento por simulação / sensibilidade). Usa sementes comuns (CRN). */
export function runSweep(
  base: Scenario, layout: Layout, param: SweepParam, values: number[],
  onProgress?: (done: number, total: number) => void,
): SweepPoint[] {
  const out: SweepPoint[] = [];
  const reps = Math.max(5, Math.min(base.replications, 12));
  values.forEach((v, i) => {
    const sc: Scenario = JSON.parse(JSON.stringify(base));
    sc.replications = reps;
    if (param === 'forklifts') sc.forklifts.count = v;
    if (param === 'workers') sc.workers.count = v;
    if (param === 'checkers') sc.checkers.count = v;
    if (param === 'demand') sc.demandFactor = v;
    const res = runExperiment(sc, layout);
    out.push({ value: v, label: param === 'demand' ? `${Math.round(v * 100)}%` : String(v), kpis: res.kpis, ok: meetsTargets(base, res.kpis, param) });
    onProgress?.(i + 1, values.length);
  });
  return out;
}

/** Atende metas? utilização ≤ meta e espera P95 ≤ meta, para recursos relevantes. */
export function meetsTargets(sc: Scenario, k: Aggregated, param: SweepParam): boolean {
  const wt = sc.targetWaitP95Min;
  const u = sc.targetUtilization;
  const fk = k.utilForklift.mean <= u && k.waitForkliftP95.mean <= wt;
  const wk = sc.workers.count === 0 || (k.utilWorker.mean <= u && k.waitWorkerP95.mean <= wt);
  const docks = k.dockWaitInP95.mean <= wt * 3 && k.dockWaitOutP95.mean <= wt * 3;
  if (param === 'forklifts') return fk;
  if (param === 'workers') return wk;
  if (param === 'checkers') return k.utilChecker.mean <= u;
  return fk && wk && docks && k.backlogOrders.mean < 5 && k.backlogPallets.mean < 20;
}
