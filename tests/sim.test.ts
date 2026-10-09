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
