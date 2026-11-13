import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { trailerDepthM } from '../src/model/receiving';
import { presetVehicle } from '../src/model/traffic';
import { SimModel } from '../src/sim/model';
import { validate } from '../src/sim/world';
import type { Layout, Scenario } from '../src/model/types';

const mkLayout = (): Layout => generateLayout(defaultLayoutParams());
const base = (): Scenario => {
  const sc = defaultScenario();
  sc.days = 1;
  sc.warmupHours = 0;
  sc.ordersPerHour = new Array(24).fill(0);
  sc.outboundTrucksPerHour = new Array(24).fill(0);
  sc.initialOccupancy = 0.3;
  sc.checkers.count = 4;
  sc.checkers.availability = 1;
  sc.forklifts.availability = 1;
  sc.receiving.damagePalletPct = 0;
  return sc;
};
const run = (sc: Scenario, layout = mkLayout(), seed = 5) => {
  const m = new SimModel(sc, layout, seed);
  const r = m.runAll();
  return { m, k: r.kpis };
};

describe('avarias e triagem', () => {
  it('sem avaria configurada nada vai para a triagem', () => {
    const { m, k } = run(base());
    expect(k.damagedPalletsPerDay).toBe(0);
    expect(m.world.triages.every((t) => t.occupied === 0)).toBe(true);
    expect(k.palletsInPerDay).toBeGreaterThan(100);
  });
  it('avaria por palete: com 100% todos os paletes conferidos têm avaria; caixas = fração × caixas do palete', () => {
    const sc = base();
    sc.receiving.damagePalletPct = 1;
    sc.receiving.damagedCartonsFraction = { kind: 'constant', a: 0.5 };
    sc.skus = [{ sku: 'X', description: '', cls: 'A', share: 1, cartonsPerPallet: 40 }];
    const { k } = run(sc);
    expect(k.damagedPalletPct).toBeCloseTo(1, 9);
    expect(k.damagedCartonsPerDay / k.damagedPalletsPerDay).toBeCloseTo(20, 9);
    expect(k.wholePalletTriagePerDay).toBe(0);
  });
  it('palete sem nenhuma caixa boa vai inteiro para a triagem e não é guardado', () => {
    const a = base();
    const b = base();
    b.receiving.damagePalletPct = 1;
    b.receiving.damagedCartonsFraction = { kind: 'constant', a: 1 };
    const ra = run(a).k;
    const rb = run(b).k;
    expect(rb.wholePalletTriagePerDay).toBeCloseTo(rb.damagedPalletsPerDay, 9);
    expect(rb.palletsInPerDay).toBe(0); // todos desviados para a triagem
    expect(ra.palletsInPerDay).toBeGreaterThan(100);
  });
  it('avaria aumenta o tempo de conferência e a triagem soma tempo por caixa', () => {
    const none = base();
    const dmg = base();
    dmg.receiving.damagePalletPct = 1;
    dmg.receiving.damagedCartonsFraction = { kind: 'constant', a: 0.25 };
    dmg.receiving.damagedCheckFactor = 1;
    dmg.ops.triageCarton = { kind: 'constant', a: 0 };
    const k0 = run(none).k;
    const kSame = run(dmg).k; // fator 1 e triagem 0 s: mesmo tempo
    expect(kSame.checkCycleMean).toBeCloseTo(k0.checkCycleMean, 0);
    dmg.receiving.damagedCheckFactor = 1.5;
    const kFator = run(dmg).k;
    expect(kFator.checkCycleMean).toBeGreaterThan(k0.checkCycleMean * 1.2);
    dmg.ops.triageCarton = { kind: 'constant', a: 8 };
    expect(run(dmg).k.checkCycleMean).toBeGreaterThan(kFator.checkCycleMean + 1);
  });
  it('transbordo: enche a triagem de maior prioridade e passa para a próxima; ao lotar tudo conta estouro', () => {
    const sc = base();
    sc.receiving.damagePalletPct = 1;
    sc.receiving.damagedCartonsFraction = { kind: 'constant', a: 0.3 };
    sc.receiving.triageClearEveryHours = 0;
    const l = mkLayout();
    const tri = l.elements.filter((e) => e.type === 'triage');
    tri[0].capacity = 2;
    tri[0].priority = 2;
    tri[1].capacity = 3;
    tri[1].priority = 1;
    const { m, k } = run(sc, l);
    const [first, second] = m.world.triages;
    expect(first.el.id).toBe(tri[1].id); // prioridade 1
    expect(first.occupied).toBe(3);
    expect(second.occupied).toBe(2);
    expect(k.triageOverflowPerDay).toBeGreaterThan(0);
  });
  it('esvaziar a triagem periodicamente libera espaço', () => {
    const sc = base();
    sc.receiving.damagePalletPct = 1;
    sc.receiving.damagedCartonsFraction = { kind: 'constant', a: 0.3 };
    const l = mkLayout();
    l.elements.filter((e) => e.type === 'triage').forEach((t) => (t.capacity = 5));
    sc.receiving.triageClearEveryHours = 0;
    const kNunca = run(sc, l).k;
    sc.receiving.triageClearEveryHours = 1;
    const kHora = run(sc, l).k;
    expect(kHora.triageOverflowPerDay).toBeLessThan(kNunca.triageOverflowPerDay);
  });
  it('stage com capacidade limita paletes no chão e gera espera', () => {
    const sc = base();
    const l = mkLayout();
    l.elements.find((e) => e.type === 'stage')!.capacity = 2;
    const { k } = run(sc, l);
    expect(k.stageOccupancyMax).toBeLessThanOrEqual(2);
    expect(k.stageWaitMean).toBeGreaterThan(0);
    const big = run(base(), mkLayout()).k;
    expect(big.stageWaitMean).toBeLessThan(k.stageWaitMean);
  });
  it('transporte do palete avariado: paleteira/transpaleteira/AMR quando houver; senão empilhadeira', () => {
    const sc = base();
    sc.receiving.damagePalletPct = 0.5;
    const semMover = run(sc).k;
    expect(semMover.utilMover).toBe(0);
    sc.equipment[0].count = 2; // paleteira manual
    sc.equipment[1].count = 1; // transpaleteira
    const comMover = run(sc).k;
    expect(comMover.utilMover).toBeGreaterThan(0);
  });
});

describe('descarga e baú', () => {
  it('distância no baú: 2 paletes por fileira de 1,2 m, limitada ao comprimento', () => {
    expect(trailerDepthM(0, 14)).toBeCloseTo(0.5, 9);
    expect(trailerDepthM(1, 14)).toBeCloseTo(0.5, 9);
    expect(trailerDepthM(2, 14)).toBeCloseTo(1.5, 9);
    expect(trailerDepthM(60, 5)).toBe(5);
  });
  it('baú maior => descarga mais demorada (mesma frota)', () => {
    const mk = (len: number) => {
      const sc = base();
      sc.checkers.count = 0;
      const v = { ...presetVehicle('carreta'), share: 1, trailerLengthM: len, pallets: { mean: 24, sd: 0, max: 33 }, dockTurnover: { kind: 'constant' as const, a: 60 } };
      sc.vehicleTypes = [v];
      sc.arrivalsIn = { ...sc.arrivalsIn, mode: 'fixed', intervalMin: 60, delayProb: 0 };
      sc.inboundTrucksPerHour = new Array(24).fill(0);
      return run(sc).k.truckTurnaroundIn;
    };
    const longo = mk(20);
    const curto = mk(2);
    expect(longo).toBeGreaterThan(curto);
    const sc = base();
    sc.receiving.trailerDepth = false;
    expect(sc.receiving.trailerDepth).toBe(false);
  });
  it('descarga com transpaleteira e guarda com empilhadeira (sem conferência)', () => {
    const sc = base();
    sc.checkers.count = 0;
    sc.receiving.unloadWith = ['palletTruck'];
    sc.equipment[1].count = 3;
    const { k } = run(sc);
    expect(k.utilMover).toBeGreaterThan(0);
    expect(k.palletsInPerDay).toBeGreaterThan(100);
  });
  it('quando há mais de um equipamento permitido, o disponível é acionado', () => {
    const sc = base();
    sc.checkers.count = 0;
    sc.receiving.unloadWith = ['forklift', 'palletJack'];
    sc.equipment[0].count = 2;
    const { m } = run(sc);
    expect(m.eqPools.palletJack.items.some((a) => a.busyTime > 0)).toBe(true);
    expect(m.forklifts.items.some((a) => a.busyTime > 0)).toBe(true);
  });
});

describe('validações do recebimento', () => {
  it('avisa sobre avaria sem conferente, sem triagem, sem stage e descarga sem equipamento', () => {
    const sc = base();
    sc.receiving.damagePalletPct = 0.03;
    sc.checkers.count = 0;
    expect(validate(mkLayout(), sc).some((i) => /sem conferência/.test(i.msg))).toBe(true);
    sc.checkers.count = 2;
    const l = mkLayout();
    l.elements = l.elements.filter((e) => e.type !== 'triage' && e.type !== 'stage');
    const msgs = validate(l, sc).map((i) => i.msg).join('|');
    expect(msgs).toMatch(/área de triagem/);
    expect(msgs).toMatch(/não tem stage/);
    sc.receiving.unloadWith = ['amr'];
    expect(validate(mkLayout(), sc).some((i) => /quantidade configurada é 0/.test(i.msg))).toBe(true);
    sc.receiving.unloadWith = [];
    expect(validate(mkLayout(), sc).some((i) => i.level === 'erro' && /Nenhum equipamento permitido/.test(i.msg))).toBe(true);
  });
});

describe('planilha: recebimento', () => {
  it('ida e volta preserva avarias, triagem por caixa e equipamentos de descarga', async () => {
    const { exportTemplate, importWorkbook } = await import('../src/io/excel');
    const sc = base();
    sc.receiving = { ...sc.receiving, damagePalletPct: 0.07, damagedCartonsFraction: { kind: 'triangular', a: 0.1, b: 0.3, c: 0.9 }, damagedCheckFactor: 2, triageClearEveryHours: 12, trailerDepth: false, unloadWith: ['forklift', 'palletTruck'] };
    sc.ops.triageCarton = { kind: 'triangular', a: 5, b: 8, c: 15 };
    const r = await importWorkbook(await exportTemplate(sc, mkLayout()));
    expect(r.warnings).toEqual([]);
    expect(r.scenario.receiving).toEqual(sc.receiving);
    expect(r.scenario.ops.triageCarton).toEqual(sc.ops.triageCarton);
  });
});
