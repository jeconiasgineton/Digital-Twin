import { describe, expect, it } from 'vitest';
import { analyzeCapacity } from '../src/analysis/capacity';
import { defaultScenario } from '../src/model/defaults';
import { defaultExpedition, makeExpStep } from '../src/model/expedition';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { SimModel } from '../src/sim/model';
import type { Layout, Scenario } from '../src/model/types';

const layout: Layout = generateLayout(defaultLayoutParams());
const k = (v: number) => ({ kind: 'constant' as const, a: v });
const row = (sc: Scenario, key: string, l = layout) => analyzeCapacity(sc, l).rows.find((r) => r.key === key);
const flat = (n: number) => new Array(24).fill(n);

const pickBase = (): Scenario => {
  const sc = defaultScenario();
  sc.days = 1;
  sc.warmupHours = 0;
  sc.inboundTrucksPerHour = flat(0);
  sc.outboundTrucksPerHour = flat(0);
  sc.ordersPerHour = flat(20);
  sc.initialOccupancy = 0.5;
  sc.picking.mode = 'pallet';
  sc.workers.count = 12;
  sc.workers.availability = 1;
  return sc;
};
const expBase = (): Scenario => {
  const sc = defaultScenario();
  sc.days = 1;
  sc.warmupHours = 0;
  sc.ordersPerHour = flat(0);
  sc.inboundTrucksPerHour = flat(0);
  sc.initialOccupancy = 0.6;
  sc.forklifts.count = 10;
  sc.forklifts.availability = 1;
  sc.checkers.count = 3;
  sc.checkers.availability = 1;
  sc.workers.count = 12;
  sc.workers.availability = 1;
  sc.picking.full = { ordersPerHour: 12, palletsPerOrder: { mean: 4, sd: 0 }, abc: { a: 0.7, b: 0.2, c: 0.1 }, mode: 'direct', step1With: ['palletTruck', 'palletJack', 'amr'] };
  sc.arrivalsOut = { ...sc.arrivalsOut, mode: 'poisson', delayProb: 0 };
  sc.outboundTrucksPerHour = flat(0);
  sc.vehicleTypes = [];
  sc.expedition = { ...defaultExpedition(), mode: 'standard', palletsPerLoad: 8 };
  return sc;
};

describe('análise analítica: separação por palete', () => {
  it('o tempo por rota do separador fica próximo do medido na simulação (rota escolhida)', () => {
    const sc = pickBase();
    const a = row(sc, 'worker')!;
    const k2 = new SimModel(sc, layout, 5).runAll().kpis;
    const sim = sc.picking.route === 'u' ? k2.pickRouteTimeU : k2.pickRouteTimeZigzag;
    expect(a.meanServiceSec / 60).toBeGreaterThan(sim * 0.7);
    expect(a.meanServiceSec / 60).toBeLessThan(sim * 1.4);
  });
  it('zigue-zague e U mudam o tempo por rota e a nota mostra os dois', () => {
    const u = pickBase();
    u.picking.route = 'u';
    const z = pickBase();
    z.picking.route = 'zigzag';
    const ru = row(u, 'worker')!;
    const rz = row(z, 'worker')!;
    expect(ru.meanServiceSec).not.toBeCloseTo(rz.meanServiceSec, 0);
    expect(ru.note).toMatch(/em U \d+ s × zigue-zague \d+ s/);
  });
  it('furos de estoque aumentam o tempo do separador', () => {
    const sc = pickBase();
    const sem = row(sc, 'worker')!.meanServiceSec;
    sc.picking.stockout = { ...sc.picking.stockout, mode: 'pct', pct: 0.3, delay: k(300) };
    expect(row(sc, 'worker')!.meanServiceSec).toBeGreaterThan(sem + 100);
  });
  it('mais separadores por pedido dividem a rota: tempo menor por rota', () => {
    const um = pickBase();
    const tres = pickBase();
    tres.picking.pickersPerOrder = 3;
    expect(row(tres, 'worker')!.meanServiceSec).toBeLessThan(row(um, 'worker')!.meanServiceSec);
  });
  it('mais pedidos por hora pedem mais operários', () => {
    const a = pickBase();
    const b = pickBase();
    b.ordersPerHour = flat(80);
    expect(row(b, 'worker')!.requiredAvg).toBeGreaterThan(row(a, 'worker')!.requiredAvg);
  });
  it('o legado continua com a análise de antes (sem linhas de expedição)', () => {
    const sc = defaultScenario();
    const keys = analyzeCapacity(sc, layout).rows.map((r) => r.key);
    expect(keys).not.toContain('supply');
    expect(keys).not.toContain('stageOut');
  });
});

describe('análise analítica: palete full e expedição por etapas', () => {
  it('palete full soma carga na empilhadeira', () => {
    const sc = expBase();
    sc.expedition.mode = 'basic';
    sc.picking.full.ordersPerHour = 0;
    const sem = row(sc, 'forklift')!;
    sc.picking.full.ordersPerHour = 12;
    const com = row(sc, 'forklift')!;
    expect(com.demandPerHourAvg).toBeGreaterThan(sem.demandPerHourAvg + 40);
  });
  it('carga a partir do stage: balanço entre oferta da separação e a demanda dos caminhões', () => {
    const sc = expBase();
    sc.outboundTrucksPerHour = flat(5); // 5 × 8 = 40 paletes/h pedidos, oferta de 48/h
    const ok = row(sc, 'supply')!;
    expect(ok.status).not.toBe('critico');
    sc.outboundTrucksPerHour = flat(20); // 160/h pedidos: a separação não alcança
    const bad = row(sc, 'supply')!;
    expect(bad.status).toBe('critico');
    expect(bad.note).toMatch(/esperam a carga/);
  });
  it('sem fonte de paletes o balanço é crítico', () => {
    const sc = expBase();
    sc.picking.full.ordersPerHour = 0;
    sc.outboundTrucksPerHour = flat(2);
    const r = row(sc, 'supply')!;
    expect(r.status).toBe('critico');
    expect(r.note).toMatch(/Nenhum palete chega/);
  });
  it('as etapas feitas por conferente aumentam a carga de conferentes; o batimento com divergência também', () => {
    const sc = expBase();
    sc.outboundTrucksPerHour = flat(4);
    const base = row(sc, 'checker')!;
    const rec = sc.expedition.steps.find((s) => s.type === 'reconcile');
    if (rec && rec.type === 'reconcile') rec.divergencePct = 1;
    const div = row(sc, 'checker')!;
    expect(div.meanServiceSec).toBeGreaterThan(base.meanServiceSec);
    sc.expedition.mode = 'steps';
    sc.expedition.steps = [makeExpStep('board')];
    const so = row(sc, 'checker')!;
    expect(so.demandPerHourAvg).toBeLessThan(base.demandPerHourAvg + 1e-9);
    expect(so.note).not.toMatch(/expedição:/);
  });
  it('customização em operários: mais paletes de picking por carga, mais carga de operários', () => {
    const sc = expBase();
    sc.outboundTrucksPerHour = flat(4);
    const cust = (p: number) => {
      const s = sc.expedition.steps.find((x) => x.type === 'customize');
      if (s && s.type === 'customize') s.pickPct = p;
      return row(sc, 'worker')!;
    };
    const low = cust(0.1);
    const high = cust(0.9);
    expect(high.demandPerHourAvg).toBeGreaterThan(low.demandPerHourAvg);
    expect(high.requiredAvg).toBeGreaterThanOrEqual(low.requiredAvg);
  });
  it('conferência posterior alonga o tempo da carga na doca de saída', () => {
    const sc = expBase();
    sc.outboundTrucksPerHour = flat(2);
    const conf = () => sc.expedition.steps.find((s) => s.type === 'conference')!;
    const sim = row(sc, 'dockOut')!.meanServiceSec;
    const c = conf();
    if (c.type === 'conference') c.timing = 'later';
    const later = row(sc, 'dockOut')!.meanServiceSec;
    expect(later).toBeGreaterThan(sim);
  });
  it('a doca de saída inclui a espera pela carga quando a separação é mais lenta', () => {
    const sc = expBase();
    sc.outboundTrucksPerHour = flat(20);
    const lento = row(sc, 'dockOut')!;
    expect(lento.note).toMatch(/espera pelos paletes separados/);
  });
  it('capacidade do stage de expedição: linha própria, e ela cresce com o tamanho da carga', () => {
    const sc = expBase();
    sc.outboundTrucksPerHour = flat(4);
    const a = row(sc, 'stageOut')!;
    expect(a).toBeTruthy();
    sc.expedition.palletsPerLoad = 28;
    const b = row(sc, 'stageOut')!;
    expect(b.requiredPeak).toBeGreaterThan(a.requiredPeak);
  });
  it('sem stage de expedição desenhado, não há linha de capacidade do stage', () => {
    const sc = expBase();
    sc.outboundTrucksPerHour = flat(4);
    const l: Layout = { ...layout, elements: layout.elements.filter((e) => !(e.type === 'stage' && e.stageKind === 'out')) };
    expect(row(sc, 'stageOut', l)).toBeUndefined();
  });
  it('a análise concorda com a simulação sobre a ordem de grandeza da utilização das empilhadeiras (palete full → stage)', () => {
    const sc = expBase();
    sc.expedition.mode = 'basic';
    sc.forklifts.count = 3;
    const a = row(sc, 'forklift')!;
    const sim = new SimModel(sc, layout, 3).runAll().kpis.utilForklift;
    expect(a.rhoAvg).toBeGreaterThan(sim * 0.5);
    expect(a.rhoAvg).toBeLessThan(sim * 2 + 0.05);
  });
});
