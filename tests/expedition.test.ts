import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { EXP_LABEL, STANDARD_ORDER, defaultExpedition, effectiveSteps, makeExpStep, validateExpedition, type ExpStep } from '../src/model/expedition';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { SimModel } from '../src/sim/model';
import { validate } from '../src/sim/world';
import type { Layout, Scenario } from '../src/model/types';

const layout: Layout = generateLayout(defaultLayoutParams());
const k = (v: number) => ({ kind: 'constant' as const, a: v });
/** cenário de expedição: paletes full separados abastecem o stage; caminhões carregam N paletes por carga */
const base = (n = 8): Scenario => {
  const sc = defaultScenario();
  sc.days = 1;
  sc.warmupHours = 0;
  sc.ordersPerHour = new Array(24).fill(0);
  sc.inboundTrucksPerHour = new Array(24).fill(0);
  sc.initialOccupancy = 0.6;
  sc.forklifts.count = 10;
  sc.forklifts.availability = 1;
  sc.checkers.count = 3;
  sc.checkers.availability = 1;
  sc.workers.count = 12;
  sc.workers.availability = 1;
  sc.picking.full = { ordersPerHour: 12, palletsPerOrder: { mean: 4, sd: 0 }, abc: { a: 0.7, b: 0.2, c: 0.1 }, mode: 'direct', step1With: ['palletTruck', 'palletJack', 'amr'] };
  sc.arrivalsOut = { ...sc.arrivalsOut, mode: 'fixed', intervalMin: 60, delayProb: 0 };
  sc.outboundTrucksPerHour = new Array(24).fill(0);
  sc.expedition = { ...defaultExpedition(), mode: 'standard', palletsPerLoad: n };
  return sc;
};
/** muda os parâmetros de uma etapa (por tipo) */
const tune = (sc: Scenario, type: ExpStep['type'], patch: Record<string, unknown>) => {
  const st = sc.expedition.steps.find((s) => s.type === type)!;
  Object.assign(st, patch);
};
const run = (sc: Scenario, l: Layout = layout, seed = 5) => {
  const m = new SimModel(sc, l, seed);
  return { m, k: m.runAll().kpis };
};

describe('modelo da expedição', () => {
  it('padrão: conferir, batimento, customizar, embarcar, registrar e lacrar, nessa ordem', () => {
    const e = defaultExpedition();
    expect(e.mode).toBe('basic'); // o padrão do app continua o fluxo básico
    expect(e.palletsPerLoad).toBe(28);
    expect(e.steps.map((s) => s.type)).toEqual(STANDARD_ORDER);
    expect(STANDARD_ORDER).toEqual(['conference', 'reconcile', 'customize', 'board', 'register', 'seal']);
    for (const t of STANDARD_ORDER) expect(EXP_LABEL[t]).toBeTruthy();
  });
  it('no formato padrão a ordem é fixa; nas etapas configuráveis vale a lista do usuário (só as ativas)', () => {
    const e = defaultExpedition();
    e.steps.reverse();
    e.mode = 'standard';
    expect(effectiveSteps(e).map((s) => s.type)).toEqual(STANDARD_ORDER); // estrutura reposta
    e.mode = 'steps';
    expect(effectiveSteps(e).map((s) => s.type)).toEqual([...STANDARD_ORDER].reverse());
    e.steps.find((s) => s.type === 'customize')!.enabled = false;
    expect(effectiveSteps(e).map((s) => s.type)).not.toContain('customize');
  });
  it('validação: sem embarque é erro; ordem fora da regra é aviso', () => {
    const e = defaultExpedition();
    e.mode = 'steps';
    expect(validateExpedition(e).filter((i) => i.level === 'erro')).toEqual([]);
    e.steps = e.steps.filter((s) => s.type !== 'board');
    expect(validateExpedition(e).some((i) => i.level === 'erro' && /sem etapa "Embarcar"/.test(i.msg))).toBe(true);
    const e2 = defaultExpedition();
    e2.mode = 'steps';
    e2.steps = [makeExpStep('board'), makeExpStep('conference'), makeExpStep('seal'), makeExpStep('register')];
    const msgs = validateExpedition(e2).map((i) => i.msg).join('|');
    expect(msgs).toMatch(/vem depois do embarque/);
    expect(msgs).toMatch(/o lacre vem antes do registro/);
    const e3 = defaultExpedition();
    e3.mode = 'steps';
    (e3.steps.find((s) => s.type === 'customize') as any).pickPct = 2;
    expect(validateExpedition(e3).some((i) => i.level === 'erro' && /percentual de paletes de picking/.test(i.msg))).toBe(true);
  });
  it('no modo básico não há validação de etapas', () => {
    expect(validateExpedition(defaultExpedition())).toEqual([]);
  });
});

describe('expedição na simulação', () => {
  it('uma carga = a quantidade de paletes por caminhão definida pelo usuário', () => {
    const { k: r } = run(base(8));
    expect(r.trucksOutPerDay).toBeGreaterThan(5);
    expect(r.palletsOutPerDay / r.trucksOutPerDay).toBeGreaterThanOrEqual(8);
    expect(r.palletsOutPerDay / r.trucksOutPerDay).toBeLessThan(8 * 1.25); // paletes de cargas ainda em embarque no fim
    const r2 = run(base(12)).k;
    expect(r2.palletsOutPerDay / r2.trucksOutPerDay).toBeGreaterThanOrEqual(12);
  });
  it('só sai o que foi separado (a carga espera os paletes) e o caminhão espera a carga ficar completa', () => {
    const { k: r } = run(base(10));
    expect(r.loadReadyMean).toBeGreaterThan(0.5);
    expect(r.palletsOutPerDay).toBeLessThanOrEqual(r.fullPalletsPerDay + 1);
  });
  it('o veículo só é liberado depois do registro e do lacre (conferente)', () => {
    const sc = base(6);
    tune(sc, 'register', { time: k(300) });
    tune(sc, 'seal', { time: k(120) });
    const { k: r } = run(sc);
    expect(r.expCloseMean).toBeGreaterThanOrEqual(7); // 5 min de registro + 2 min de lacre, mais a caminhada do conferente
    expect(r.expCloseMean).toBeLessThan(7.6);
    expect(r.truckTurnaroundOut).toBeGreaterThan(7);
    const sem = base(6);
    sem.expedition.mode = 'steps';
    sem.expedition.steps = sem.expedition.steps.filter((s) => s.type !== 'register' && s.type !== 'seal');
    expect(run(sem).k.truckTurnaroundOut).toBeLessThan(r.truckTurnaroundOut);
    expect(run(sem).k.expCloseMean).toBe(0);
  });
  it('registro e lacre usam o conferente (mesmo sem recebimento)', () => {
    const { m, k: r } = run(base(6));
    expect(r.utilChecker).toBeGreaterThan(0);
    expect(m.checkers.items.some((a) => a.busyTime > 0)).toBe(true);
  });
  it('conferência simultânea acontece antes da carga ficar pronta; posterior entra na sequência', () => {
    const sim = base(8);
    tune(sim, 'conference', { timing: 'simultaneous', fullTime: k(60) });
    const pos = base(8);
    tune(pos, 'conference', { timing: 'later', fullTime: k(60) });
    const a = run(sim).k;
    const b = run(pos).k;
    expect(a.expConferMean).toBe(0); // já conferida enquanto separava
    expect(b.expConferMean).toBeGreaterThan(1); // 8 paletes × 1 min com 3 conferentes ≈ 3 min
    expect(b.truckTurnaroundOut).toBeGreaterThan(a.truckTurnaroundOut);
  });
  it('tempo da conferência: fixo no palete full e por caixa no palete de picking', () => {
    const full = base(6);
    tune(full, 'conference', { timing: 'later', fullTime: k(120), perBox: k(100) });
    full.checkers.count = 1;
    const f = run(full).k.expConferMean; // 6 paletes full × 120 s = 12 min em série com 1 conferente
    expect(f).toBeGreaterThan(10);
    expect(f).toBeLessThan(14);
    const pick = base(6);
    pick.picking.full.ordersPerHour = 0;
    pick.picking.mode = 'pallet';
    pick.ordersPerHour = new Array(24).fill(30);
    pick.picking.boxesPerOrder = { mean: 40, sd: 0 };
    pick.picking.palletLimit = { mean: 40, sd: 0 };
    tune(pick, 'conference', { timing: 'later', fullTime: k(1), perBox: k(3) });
    pick.checkers.count = 1;
    const p = run(pick).k.expConferMean; // ~40 caixas × 3 s = 2 min por palete × 6
    expect(p).toBeGreaterThan(9);
    expect(p).toBeLessThan(15);
  });
  it('batimento sempre bate por padrão; com divergência há correção', () => {
    const ok = base(6);
    tune(ok, 'reconcile', { time: k(180), divergencePct: 0 });
    const a = run(ok).k;
    expect(a.divergentLoadsPct).toBe(0);
    expect(a.expReconcileMean).toBeGreaterThanOrEqual(3); // 3 min + caminhada
    expect(a.expReconcileMean).toBeLessThan(3.4);
    const div = base(6);
    tune(div, 'reconcile', { time: k(180), divergencePct: 1, correctionTime: k(600) });
    const b = run(div).k;
    expect(b.divergentLoadsPct).toBe(1);
    expect(b.expReconcileMean).toBeGreaterThanOrEqual(13); // 3 min de batimento + 10 min de correção + caminhadas
    expect(b.expReconcileMean).toBeLessThan(13.8);
  });
  it('customização: percentual de paletes de picking por carga e tempo por palete; embarque só depois', () => {
    const none = base(10);
    tune(none, 'customize', { pickPct: 0 });
    expect(run(none).k.customizedPalletsPerLoad).toBe(0);
    const all = base(10);
    tune(all, 'customize', { pickPct: 1, time: k(300) });
    const r = run(all).k;
    expect(r.customizedPalletsPerLoad).toBe(10);
    expect(r.expCustomizeMean).toBeGreaterThanOrEqual(5); // 10 operários em paralelo × 5 min (+ caminhada)
    expect(r.expCustomizeMean).toBeLessThan(5.5);
    expect(r.truckTurnaroundOut).toBeGreaterThan(run(none).k.truckTurnaroundOut);
    const half = base(10);
    tune(half, 'customize', { pickPct: 0.5, time: k(60) });
    const h = run(half).k;
    expect(h.customizedPalletsPerLoad).toBeGreaterThan(3);
    expect(h.customizedPalletsPerLoad).toBeLessThan(7);
  });
  it('customização espera operários livres: poucos operários alongam a etapa', () => {
    const muitos = base(10);
    tune(muitos, 'customize', { pickPct: 1, time: k(300) });
    const poucos = base(10);
    tune(poucos, 'customize', { pickPct: 1, time: k(300) });
    poucos.workers.count = 2;
    expect(run(poucos).k.expCustomizeMean).toBeGreaterThan(run(muitos).k.expCustomizeMean * 2);
  });
  it('embarque com os equipamentos escolhidos, um por vez dentro do veículo', () => {
    const sc = base(8);
    sc.equipment[1].count = 3;
    tune(sc, 'board', { with: ['palletTruck'] });
    const { m, k: r } = run(sc);
    expect(r.palletsOutPerDay).toBeGreaterThan(8);
    expect(m.eqPools.palletTruck.items.some((a) => a.busyTime > 0)).toBe(true);
    expect(m.maxInside).toBe(1);
    expect(r.expBoardMean).toBeGreaterThan(0);
  });
  it('embarque com paleteira manual usa operários do pool', () => {
    const sc = base(6);
    sc.equipment[0].count = 2;
    sc.picking.full.ordersPerHour = 6;
    tune(sc, 'board', { with: ['palletJack'] });
    tune(sc, 'customize', { pickPct: 0 });
    const { m } = run(sc);
    expect(m.eqPools.palletJack.items.some((a) => a.busyTime > 0)).toBe(true);
    expect(m.workers.items.some((a) => a.busyTime > 0)).toBe(true);
  });
  it('etapas configuráveis: tirar customização e lacre muda o modelo; etapa livre acrescenta tempo', () => {
    const sc = base(6);
    sc.expedition.mode = 'steps';
    sc.expedition.steps = sc.expedition.steps.filter((s) => s.type !== 'customize' && s.type !== 'seal');
    const extra = makeExpStep('task');
    (extra as any).time = k(180);
    sc.expedition.steps.push(extra);
    const { k: r } = run(sc);
    expect(r.expCustomizeMean).toBe(0);
    expect(r.expCloseMean).toBeGreaterThan(3); // registro (padrão ~5) + tarefa livre 3 min
    expect(r.trucksOutPerDay).toBeGreaterThan(3);
  });
  it('sem etapa de embarque o app embarca no fim (a carga não fica parada)', () => {
    const sc = base(6);
    sc.expedition.mode = 'steps';
    sc.expedition.steps = sc.expedition.steps.filter((s) => s.type === 'register');
    const { k: r } = run(sc);
    expect(r.palletsOutPerDay).toBeGreaterThan(5);
  });
  it('é determinístico para a mesma semente', () => {
    expect(run(base(), layout, 9).k).toEqual(run(base(), layout, 9).k);
  });
  it('o padrão (básico) segue igual: nenhum indicador de etapas', () => {
    const sc = defaultScenario();
    sc.days = 1;
    sc.warmupHours = 0;
    const r = run(sc).k;
    expect(r.loadReadyMean).toBe(0);
    expect(r.expCloseMean).toBe(0);
    expect(r.customizedPalletsPerLoad).toBe(0);
  });
});

describe('validações do cenário de expedição', () => {
  it('exige fonte de paletes, avisa recursos zerados e embarque sem equipamento', () => {
    const sc = defaultScenario();
    sc.expedition.mode = 'standard';
    expect(validate(layout, sc).some((i) => i.level === 'erro' && /sem fonte de paletes/.test(i.msg))).toBe(true);
    sc.picking.full.ordersPerHour = 2;
    expect(validate(layout, sc).some((i) => /sem fonte de paletes/.test(i.msg))).toBe(false);
    expect(validate(layout, sc).some((i) => /usa conferentes, mas a quantidade é 0/.test(i.msg))).toBe(true);
    sc.expedition.steps.find((s) => s.type === 'board')!.with = ['amr'];
    expect(validate(layout, sc).some((i) => /nenhum equipamento do embarque/.test(i.msg))).toBe(true);
  });
});

describe('planilha: expedição', () => {
  it('ida e volta preserva modo, paletes por carga e todas as etapas com seus parâmetros', async () => {
    const { exportTemplate, importWorkbook } = await import('../src/io/excel');
    const sc = defaultScenario();
    sc.expedition = { ...defaultExpedition(), mode: 'steps', palletsPerLoad: 28 };
    (sc.expedition.steps.find((s) => s.type === 'conference') as any).timing = 'later';
    (sc.expedition.steps.find((s) => s.type === 'reconcile') as any).divergencePct = 0.1;
    (sc.expedition.steps.find((s) => s.type === 'customize') as any).pickPct = 0.4;
    (sc.expedition.steps.find((s) => s.type === 'board') as any).with = ['palletTruck', 'forklift'];
    sc.expedition.steps.find((s) => s.type === 'seal')!.enabled = false;
    const extra = makeExpStep('task');
    extra.label = 'Foto da carga';
    sc.expedition.steps.push(extra);
    const r = await importWorkbook(await exportTemplate(sc, layout));
    expect(r.warnings).toEqual([]);
    expect(r.scenario.expedition.mode).toBe('steps');
    expect(r.scenario.expedition.palletsPerLoad).toBe(28);
    expect(r.scenario.expedition.steps).toEqual(sc.expedition.steps);
  });
  it('aba com tipo desconhecido avisa e o padrão de um cenário sem a aba é preservado', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const { importWorkbook } = await import('../src/io/excel');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Expedicao');
    ws.addRow(['Ordem', 'Etapa_Id', 'Tipo', 'Ativo', 'Rotulo', 'Parametros']);
    ws.addRow([1, 'a', 'teletransportar', 'S', null, '{}']);
    const r = await importWorkbook(new Uint8Array(await wb.xlsx.writeBuffer()));
    expect(r.warnings.some((w) => /desconhecido/.test(w))).toBe(true);
    expect(r.scenario.expedition.steps.map((s) => s.type)).toEqual(STANDARD_ORDER);
  });
});
