import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { runExperiment } from '../src/sim/runner';
import { SimModel } from '../src/sim/model';

describe('simulação', () => {
  it('roda um cenário completo e produz KPIs coerentes', () => {
    const sc = defaultScenario();
    sc.replications = 3;
    sc.days = 2;
    const layout = generateLayout(defaultLayoutParams());
    const t0 = Date.now();
    const r = runExperiment(sc, layout);
    console.log('tempo ms', Date.now() - t0);
    const k = r.kpis;
    console.log(JSON.stringify(Object.fromEntries(Object.entries(k).map(([a, b]) => [a, +b.mean.toFixed(3)])), null, 1));
    expect(k.palletsInPerDay.mean).toBeGreaterThan(100);
    expect(k.utilForklift.mean).toBeGreaterThan(0);
    expect(k.utilForklift.mean).toBeLessThanOrEqual(1);
    expect(k.ordersPerDay.mean).toBeGreaterThan(100);
  });
  it('é determinístico para a mesma semente', () => {
    const sc = defaultScenario();
    sc.days = 1;
    const layout = generateLayout(defaultLayoutParams());
    const a = new SimModel(sc, layout, 5).runAll().kpis;
    const b = new SimModel(sc, layout, 5).runAll().kpis;
    expect(a).toEqual(b);
  });
});

describe('cenários de borda', () => {
  const base = () => {
    const sc = defaultScenario();
    sc.days = 1;
    sc.warmupHours = 2;
    return sc;
  };
  it('com conferentes, sem esteiras e sem estações', () => {
    const sc = base();
    sc.checkers.count = 2;
    const layout = generateLayout({ ...defaultLayoutParams(), conveyors: 0, stations: 0, rackRows: 3, baysPerRow: 10 });
    const k = new SimModel(sc, layout, 1).runAll().kpis;
    expect(k.utilChecker).toBeGreaterThan(0);
    expect(k.ordersPerDay).toBeGreaterThan(0);
  });
  it('estoque inicial vazio gera rupturas na expedição', () => {
    const sc = base();
    sc.initialOccupancy = 0;
    sc.inboundTrucksPerHour = new Array(24).fill(0);
    const layout = generateLayout({ ...defaultLayoutParams(), rackRows: 3, baysPerRow: 10 });
    const k = new SimModel(sc, layout, 1).runAll().kpis;
    expect(k.stockoutRate).toBeGreaterThan(0.9);
  });
  it('galpão pequeno lota: falta de posições', () => {
    const sc = base();
    sc.initialOccupancy = 0.95;
    sc.outboundTrucksPerHour = new Array(24).fill(0);
    const layout = generateLayout({ ...defaultLayoutParams(), rackRows: 1, baysPerRow: 4, levels: 2 });
    const k = new SimModel(sc, layout, 1).runAll().kpis;
    expect(k.overflowRate).toBeGreaterThan(0.5);
  });
  it('sem recursos configurados não trava (fila cresce)', () => {
    const sc = base();
    sc.forklifts.count = 0;
    sc.workers.count = 0;
    const layout = generateLayout({ ...defaultLayoutParams(), rackRows: 3, baysPerRow: 10 });
    const k = new SimModel(sc, layout, 1).runAll().kpis;
    expect(k.palletsInPerDay).toBe(0);
    expect(k.backlogOrders).toBeGreaterThan(100); // pedidos se acumulam na fila
  });
});
