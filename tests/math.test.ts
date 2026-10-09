import { describe, expect, it } from 'vitest';
import { Rng } from '../src/math/rng';
import { erlangB, erlangC, ggcMetrics, sizeServers } from '../src/math/queueing';
import { normCdf, normInv, poissonQuantile, tCrit95, mean, sd } from '../src/math/stats';
import { Pool, Sim, type PoolItem } from '../src/sim/engine';
import { astar, buildNavGrid, cellOf, dijkstraField, pathLength } from '../src/math/spatial';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';

describe('estatística', () => {
  it('normal inv/cdf', () => {
    expect(normInv(0.975)).toBeCloseTo(1.95996, 3);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(tCrit95(19)).toBeCloseTo(2.093, 2);
    expect(poissonQuantile(100, 0.95)).toBeGreaterThanOrEqual(116);
  });
  it('distribuições têm a média esperada', () => {
    const r = new Rng(1);
    const xs = Array.from({ length: 40000 }, () => r.triangular(10, 20, 60));
    expect(mean(xs)).toBeCloseTo(30, 0);
    const ys = Array.from({ length: 40000 }, () => r.lognormal(50, 20));
    expect(mean(ys)).toBeCloseTo(50, 0);
    expect(sd(ys)).toBeCloseTo(20, 0);
  });
});

describe('filas', () => {
  it('Erlang B/C valores de referência', () => {
    expect(erlangB(10, 5)).toBeCloseTo(0.01838, 4);
    expect(erlangC(10, 8)).toBeCloseTo(0.4092, 3);
  });
  it('M/M/c: espera média analítica ≈ simulada pelo motor DES', () => {
    const lambda = 0.9; // chegadas/s
    const meanS = 3; // s, c=4 => rho=0.675
    const c = 4;
    const sim = new Sim();
    const rng = new Rng(7);
    const items: PoolItem[] = Array.from({ length: c }, (_, i) => ({ id: i, x: 0, z: 0, busy: false, busyTime: 0, busySince: 0, downTime: 0 }));
    const pool = new Pool(sim, items);
    sim.spawn(function* () {
      for (let i = 0; i < 200000; i++) {
        yield rng.exp(1 / lambda);
        sim.spawn(function* () {
          const it: PoolItem = yield pool.request();
          yield rng.exp(meanS);
          pool.release(it);
        });
      }
    });
    sim.runUntil(150000);
    pool.finalize();
    const wq = mean(pool.waits);
    const th = ggcMetrics(c, lambda, meanS, 1).wq;
    expect(Math.abs(wq - th) / th).toBeLessThan(0.08);
    expect(pool.utilization(150000)).toBeCloseTo(0.675, 1);
  });
  it('dimensionamento devolve o menor c que atende às metas', () => {
    const s = sizeServers({ lambda: 0.5, meanS: 20, scvS: 0.5, targetUtil: 0.85, waitTarget: 300, confidence: 0.95 });
    expect(s.servers).toBeGreaterThanOrEqual(12);
    expect(s.metrics.rho).toBeLessThanOrEqual(0.85);
    const less = ggcMetrics(s.servers - 1, 0.5, 20, 0.5);
    expect(less.rho > 0.85 || less.pWaitExceeds(300) > 0.05).toBe(true);
  });
});

describe('navegação', () => {
  it('A* e Dijkstra concordam e racks bloqueiam o caminho reto', () => {
    const layout = generateLayout(defaultLayoutParams());
    const g = buildNavGrid(layout);
    const a = cellOf(g, { x: 3, z: 3 });
    const b = cellOf(g, { x: layout.floor.width - 3, z: layout.floor.depth - 3 });
    const p = astar(g, a, b)!;
    expect(p).not.toBeNull();
    const L = pathLength(g, p);
    const f = dijkstraField(g, a);
    expect(f.dist[b]).toBeCloseTo(L, 1);
    expect(L).toBeGreaterThan(Math.hypot(layout.floor.width - 6, layout.floor.depth - 6) - 1);
  });
});
