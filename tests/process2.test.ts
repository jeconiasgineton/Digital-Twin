import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { defaultExpedition } from '../src/model/expedition';
import { exportTemplate, importWorkbook } from '../src/io/excel';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import {
  PROCESS_TEMPLATES, TRIGGER_STEPS, connect, makeStep, templateById, validateProcess,
  type ProcessDef, type Step, type TaskStep, type Trigger,
} from '../src/model/process';
import { SimModel } from '../src/sim/model';
import { validate } from '../src/sim/world';
import type { Layout, Scenario } from '../src/model/types';

const layout: Layout = generateLayout(defaultLayoutParams());
const flat = (n: number) => new Array(24).fill(n);
const run = (sc: Scenario, seed = 5) => new SimModel(sc, layout, seed).runAll().kpis;
const custom = (sc: Scenario, ...ids: string[]) => {
  sc.useCustomProcesses = true;
  sc.processes = ids.map((i) => templateById(i)!.make(sc));
  return sc;
};
const chain = (trigger: Trigger, ...steps: Step[]): ProcessDef => {
  const p: ProcessDef = { id: 'p', name: 'manual', trigger, steps: [makeStep('start', 0, 0), ...steps, makeStep('end', 0, 0)] };
  for (let i = 0; i < p.steps.length - 1; i++) connect(p, p.steps[i].id, 'next', p.steps[i + 1].id);
  return p;
};

const pickSc = (): Scenario => {
  const sc = defaultScenario();
  sc.days = 1;
  sc.warmupHours = 0;
  sc.inboundTrucksPerHour = flat(0);
  sc.outboundTrucksPerHour = flat(0);
  sc.ordersPerHour = flat(20);
  sc.initialOccupancy = 0.5;
  sc.workers.count = 12;
  sc.workers.availability = 1;
  sc.picking.loadFrom = 'stage';
  sc.arrivalsOut = { ...sc.arrivalsOut, mode: 'poisson', delayProb: 0 };
  sc.outboundTrucksPerHour = flat(2); // os caminhões esvaziam o stage de expedição
  return sc;
};
const expSc = (): Scenario => {
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
  sc.arrivalsOut = { ...sc.arrivalsOut, mode: 'fixed', intervalMin: 60, delayProb: 0 };
  sc.outboundTrucksPerHour = flat(0);
  sc.vehicleTypes = [];
  sc.expedition = { ...defaultExpedition(), mode: 'basic', palletsPerLoad: 8 };
  return sc;
};

describe('separação e expedição como processos em blocos', () => {
  it('cada modelo novo é válido e só usa blocos do seu tipo', () => {
    for (const t of PROCESS_TEMPLATES) {
      const p = t.make(defaultScenario());
      expect(p.trigger).toBe(t.trigger);
      expect(validateProcess(p).filter((i) => i.level === 'erro'), t.id).toEqual([]);
      for (const s of p.steps) if (s.type !== 'start' && s.type !== 'end') expect(TRIGGER_STEPS[p.trigger]).toContain(s.type);
    }
  });
  it('validações por tipo: separação sem rota, palete full sem stage, expedição sem carga/embarque, bloco fora do tipo', () => {
    const noRoute = chain('order', makeStep('wait'));
    expect(validateProcess(noRoute).some((i) => i.level === 'erro' && /Percorrer rota/.test(i.msg))).toBe(true);
    const full = chain('fullOrder', makeStep('wait'));
    expect(validateProcess(full).some((i) => i.level === 'erro' && /Stage de expedição/.test(i.msg))).toBe(true);
    const ex = chain('outLoad', makeStep('wait'));
    const msgs = validateProcess(ex).filter((i) => i.level === 'erro').map((i) => i.msg).join(' | ');
    expect(msgs).toMatch(/Formar a carga/);
    expect(msgs).toMatch(/Embarcar/);
    const wrong = chain('unloadPallet', makeStep('pickRoute'));
    expect(validateProcess(wrong).some((i) => i.level === 'erro' && /não existe em processos de Recebimento/.test(i.msg))).toBe(true);
    const late = chain('outLoad', makeStep('collect'), makeStep('board'), Object.assign(makeStep('task') as TaskStep, { kpi: 'conference' as const }));
    expect(validateProcess(late).some((i) => /depois do embarque/.test(i.msg))).toBe(true);
  });
  it('separação em blocos reproduz a padrão (mesma semente, mesmos resultados)', () => {
    const a = pickSc();
    a.picking.mode = 'pallet';
    const b = custom(pickSc(), 'sep-palete');
    const ka = run(a);
    const kb = run(b);
    expect(kb.pickPalletsPerDay).toBeGreaterThan(50);
    expect(kb.pickPalletsPerDay).toBeCloseTo(ka.pickPalletsPerDay, 5);
    expect(kb.boxesPerPickerHour).toBeCloseTo(ka.boxesPerPickerHour, 5);
  });
  it('o bloco de rota usa seus próprios parâmetros (zigue-zague, mais separadores por pedido)', () => {
    const sc = custom(pickSc(), 'sep-palete');
    const step = sc.processes[0].steps.find((s) => s.type === 'pickRoute');
    if (step?.type === 'pickRoute') {
      step.params.route = 'zigzag';
      step.params.pickersPerOrder = 3;
      step.params.boxesPerOrder = { mean: 60, sd: 0 };
    }
    const k = run(sc);
    const ref = run(custom(pickSc(), 'sep-palete'));
    expect(k.pickPalletsPerDay).not.toBeCloseTo(ref.pickPalletsPerDay, 0);
    expect(k.boxesPerPickerHour).toBeGreaterThan(0);
  });
  it('palete full em blocos (direto) entrega paletes ao stage de expedição como o padrão', () => {
    const a = expSc();
    a.picking.loadFrom = 'stage';
    const b = custom(expSc(), 'full-direta');
    const ka = run(a);
    const kb = run(b);
    expect(kb.fullPalletsPerDay).toBeGreaterThan(100);
    expect(kb.fullPalletsPerDay).toBeGreaterThan(ka.fullPalletsPerDay * 0.8);
    expect(kb.fullPalletsPerDay).toBeLessThan(ka.fullPalletsPerDay * 1.2);
  });
  it('palete full faseado em blocos usa a rua e o equipamento sem elevação', () => {
    const sc = custom(expSc(), 'full-faseada');
    sc.equipment[1].count = 3; // transpaleteira
    const m = new SimModel(sc, layout, 5);
    const k = m.runAll().kpis;
    expect(k.fullPalletsPerDay).toBeGreaterThan(50);
    expect(k.transitOccupancyMax).toBeGreaterThan(0);
    expect(m.eqPools.palletTruck.items.some((x) => x.busyTime > 0)).toBe(true);
  });
  it('expedição em blocos reproduz o formato padrão da expedição por etapas', () => {
    const a = expSc();
    a.outboundTrucksPerHour = flat(1);
    a.expedition = { ...defaultExpedition(), mode: 'standard', palletsPerLoad: 8 };
    const b = custom(expSc(), 'full-direta', 'exp-padrao');
    b.outboundTrucksPerHour = flat(1);
    b.expedition = { ...defaultExpedition(), mode: 'basic', palletsPerLoad: 8 };
    const ka = run(a);
    const kb = run(b);
    expect(kb.palletsOutPerDay).toBeGreaterThan(20);
    expect(kb.palletsOutPerDay).toBeGreaterThan(ka.palletsOutPerDay * 0.7);
    expect(kb.palletsOutPerDay).toBeLessThan(ka.palletsOutPerDay * 1.3);
    expect(kb.expBoardMean).toBeGreaterThan(0);
    expect(kb.expCloseMean).toBeGreaterThan(0);
  });
  it('tarefa de batimento com divergência alonga o fechamento da carga', () => {
    const mk = (pct: number) => {
      const sc = custom(expSc(), 'full-direta', 'exp-padrao');
      sc.outboundTrucksPerHour = flat(1);
      const t = sc.processes[1].steps.find((s) => s.type === 'task' && s.kpi === 'reconcile');
      if (t?.type === 'task') t.extraPct = pct;
      return run(sc);
    };
    const sem = mk(0);
    const com = mk(1);
    expect(com.divergentLoadsPct).toBeGreaterThan(0.9);
    expect(sem.divergentLoadsPct).toBe(0);
    expect(com.expReconcileMean).toBeGreaterThan(sem.expReconcileMean);
  });
  it('expedição simples: só forma a carga e embarca (sem etapas de pessoas)', () => {
    const sc = custom(expSc(), 'full-direta', 'exp-simples');
    sc.outboundTrucksPerHour = flat(1);
    const k = run(sc);
    expect(k.palletsOutPerDay).toBeGreaterThan(20);
    expect(k.expCloseMean).toBe(0);
  });
  it('desligado, os processos de separação/expedição não valem', () => {
    const sc = custom(expSc(), 'full-direta', 'exp-padrao');
    sc.useCustomProcesses = false;
    sc.outboundTrucksPerHour = flat(1);
    const k = run(sc);
    expect(k.stageOutMax).toBe(0); // carga do rack: o stage de expedição não é usado
  });
  it('a validação do cenário avalia todos os tipos de processo e aceita só o de separação', () => {
    const sc = custom(pickSc(), 'sep-palete');
    const issues = validate(layout, sc);
    expect(issues.some((i) => i.level === 'erro')).toBe(false);
    sc.processes = [];
    expect(validate(layout, sc).some((i) => i.level === 'erro' && /nenhum processo de recebimento/.test(i.msg))).toBe(true);
  });
  it('o Excel guarda o tipo de cada processo e os parâmetros dos novos blocos', async () => {
    const sc = custom(expSc(), 'sep-palete', 'full-faseada', 'exp-padrao');
    const r = await importWorkbook(await exportTemplate(sc, layout));
    const got = r.scenario!.processes;
    expect(got.map((p) => p.trigger)).toEqual(['order', 'fullOrder', 'outLoad']);
    const task = got[2].steps.find((s) => s.type === 'task' && s.kpi === 'reconcile') as TaskStep;
    expect(task.scope).toBe('load');
    expect(got[0].steps.find((s) => s.type === 'pickRoute')).toBeTruthy();
    expect(got[1].steps.some((s) => s.type === 'move' && s.to.kind === 'stageOut')).toBe(true);
  });
});
