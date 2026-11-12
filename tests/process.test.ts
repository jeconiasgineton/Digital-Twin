import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import {
  PROCESS_TEMPLATES, addStep, connect, getPort, makeStep, portsOf, reachable, removeStep, templateById, validateProcess,
  type DecideStep, type MoveStep, type ProcessDef, type RetrieveStep, type Step,
} from '../src/model/process';
import { SimModel } from '../src/sim/model';
import { validate } from '../src/sim/world';
import type { Layout, Scenario } from '../src/model/types';

const layout: Layout = generateLayout(defaultLayoutParams());
const base = (): Scenario => {
  const sc = defaultScenario();
  sc.days = 1;
  sc.warmupHours = 0;
  sc.ordersPerHour = new Array(24).fill(0);
  sc.outboundTrucksPerHour = new Array(24).fill(0);
  sc.initialOccupancy = 0.3;
  sc.forklifts.availability = 1;
  sc.checkers.availability = 1;
  sc.receiving.damagePalletPct = 0;
  return sc;
};
const withTemplate = (sc: Scenario, id: string) => {
  sc.useCustomProcesses = true;
  sc.processes = [templateById(id)!.make(sc)];
  return sc;
};
const run = (sc: Scenario, l: Layout = layout, seed = 5) => {
  const m = new SimModel(sc, l, seed);
  return { m, k: m.runAll().kpis };
};
/** processo manual: Início → blocos em fila → Fim */
const chain = (...steps: Step[]): ProcessDef => {
  const p: ProcessDef = { id: 'p', name: 'manual', trigger: 'unloadPallet', steps: [makeStep('start', 0, 0), ...steps, makeStep('end', 0, 0)] };
  for (let i = 0; i < p.steps.length - 1; i++) connect(p, p.steps[i].id, 'next', p.steps[i + 1].id);
  return p;
};

describe('modelos de processo', () => {
  it('todos os modelos são válidos (sem erros) e alcançam o Fim', () => {
    for (const t of PROCESS_TEMPLATES) {
      const p = t.make(defaultScenario());
      expect(validateProcess(p).filter((i) => i.level === 'erro'), t.id).toEqual([]);
      const reach = reachable(p);
      expect(p.steps.every((s) => reach.has(s.id)), t.id).toBe(true);
      expect(p.steps.some((s) => s.type === 'end')).toBe(true);
    }
  });
  it('os modelos usam as MESMAS ações genéricas em papéis diferentes', () => {
    const p = templateById('rec-conf-faseada')!.make(defaultScenario());
    const moves = p.steps.filter((s): s is MoveStep => s.type === 'move');
    expect(moves.map((m) => `${m.from.kind}→${m.to.kind}`)).toEqual(['trailer→stage', 'here→transit', 'here→triage']);
    // descarga, etapa 1 e transporte de avarias são todos "movimentar"
    expect(new Set(moves.map((m) => m.type))).toEqual(new Set(['move']));
  });
});

describe('processo personalizado na simulação', () => {
  it('recebimento direto: libera caminhões, guarda os paletes e conta os indicadores', () => {
    const sc = withTemplate(base(), 'rec-direto');
    const { k } = run(sc);
    expect(k.palletsInPerDay).toBeGreaterThan(100);
    expect(k.trucksInPerDay).toBeGreaterThan(5);
    const built = run(base()).k;
    expect(k.palletsInPerDay).toBeGreaterThan(built.palletsInPerDay * 0.6);
    expect(k.palletsInPerDay).toBeLessThan(built.palletsInPerDay * 1.4);
  });
  it('com conferência e triagem: avarias detectadas, triagem ocupada e palete bom guardado', () => {
    const sc = withTemplate(base(), 'rec-conf-direta');
    sc.checkers.count = 4;
    sc.receiving.damagePalletPct = 0.2;
    sc.processes = [templateById('rec-conf-direta')!.make(sc)]; // modelo lê as avarias da configuração
    const { m, k } = run(sc);
    expect(k.damagedPalletPct).toBeGreaterThan(0.1);
    expect(k.damagedPalletPct).toBeLessThan(0.3);
    expect(k.damagedCartonsPerDay).toBeGreaterThan(0);
    expect(k.checkCycleMean).toBeGreaterThan(0.5);
    expect(m.world.triages.reduce((s, t) => s + t.occupied, 0)).toBeGreaterThan(0);
    expect(k.palletsInPerDay).toBeGreaterThan(80);
  });
  it('faseada por blocos: movimentar até a rua + elevar', () => {
    const sc = base();
    sc.checkers.count = 3;
    sc.equipment[1].count = 3;
    withTemplate(sc, 'rec-conf-faseada');
    const { k } = run(sc);
    expect(k.phasedShare).toBeGreaterThan(0.9);
    expect(k.transitOccupancyMax).toBeGreaterThan(0);
    expect(k.utilMover).toBeGreaterThan(0);
    expect(k.palletsInPerDay).toBeGreaterThan(80);
  });
  it('desligado (padrão) mantém o fluxo original e processos não interferem', () => {
    const sc = base();
    sc.processes = [templateById('rec-direto')!.make(sc)];
    sc.useCustomProcesses = false;
    const a = run(sc).k;
    sc.processes = [];
    expect(run(sc).k).toEqual(a);
  });
  it('é determinístico para a mesma semente', () => {
    const sc = withTemplate(base(), 'rec-conf-direta');
    sc.checkers.count = 3;
    expect(run(sc, layout, 9).k).toEqual(run(sc, layout, 9).k);
  });
});

describe('ações genéricas isoladas', () => {
  it('Movimentar: o tempo depende dos locais e dos recursos, não do "nome" do processo', () => {
    const mk = (res: 'forklift' | 'palletJack') => {
      const sc = base();
      sc.equipment[0].count = 3;
      sc.equipment[0].speedEmpty = 0.3;
      sc.equipment[0].speedLoaded = 0.3;
      sc.checkers.count = 0;
      const mv = makeStep('move', 0, 0) as MoveStep;
      mv.from = { kind: 'trailer' };
      mv.to = { kind: 'area', areaId: layout.elements.find((e) => e.type === 'triage')!.id };
      mv.with = [res];
      sc.processes = [chain(mv)];
      sc.useCustomProcesses = true;
      sc.arrivalsIn = { ...sc.arrivalsIn, mode: 'fixed', intervalMin: 90, delayProb: 0 };
      sc.inboundTrucksPerHour = new Array(24).fill(0);
      return run(sc).k.truckTurnaroundIn;
    };
    expect(mk('palletJack')).toBeGreaterThan(mk('forklift')); // jack lento (0,3 m/s) × empilhadeira
  });
  it('Decidir: condição por sorteio segue o caminho "sim" ou "não"', () => {
    const run1 = (prob: number) => {
      const sc = base();
      const d = makeStep('decide', 0, 0) as DecideStep;
      d.condition = 'prob';
      d.value = prob;
      const p: ProcessDef = { id: 'p', name: 'd', trigger: 'unloadPallet', steps: [makeStep('start'), makeStep('move'), d, makeStep('move'), makeStep('end'), makeStep('end')] };
      const [s, mv, dd, toTriage, eYes, eNo] = p.steps;
      (mv as MoveStep).from = { kind: 'trailer' };
      (mv as MoveStep).to = { kind: 'dock' };
      (toTriage as MoveStep).from = { kind: 'here' };
      (toTriage as MoveStep).to = { kind: 'triage' };
      connect(p, s.id, 'next', mv.id);
      connect(p, mv.id, 'next', dd.id);
      connect(p, dd.id, 'next', toTriage.id); // sim → leva à triagem
      connect(p, dd.id, 'nextNo', eNo.id); // não → encerra
      connect(p, toTriage.id, 'next', eYes.id);
      sc.processes = [p];
      sc.useCustomProcesses = true;
      const { m } = run(sc);
      return m.world.triages.reduce((n, t) => n + t.occupied, 0);
    };
    expect(run1(1)).toBeGreaterThan(0);
    expect(run1(0)).toBe(0);
  });
  it('Recuperar + Movimentar caixas + Paletizar: caixas e fardos também são itens', () => {
    const sc = base();
    sc.workers.count = 4;
    sc.checkers.count = 0;
    const mv1 = makeStep('move') as MoveStep;
    mv1.from = { kind: 'trailer' };
    mv1.to = { kind: 'stage' };
    const ret = makeStep('retrieve') as RetrieveStep;
    ret.quantity = { mode: 'fraction', value: 0.5 };
    ret.with = ['worker'];
    const mvBox = makeStep('move') as MoveStep;
    mvBox.item = 'carton';
    mvBox.with = ['worker'];
    mvBox.from = { kind: 'here' };
    mvBox.to = { kind: 'triage' };
    mvBox.handling = { kind: 'constant', a: 2 };
    const pal = makeStep('palletize');
    const p: ProcessDef = { id: 'p', name: 'caixas', trigger: 'unloadPallet', steps: [makeStep('start'), mv1, ret, mvBox, pal, makeStep('end'), makeStep('end')] };
    const [s, a, r, b, pz, e1, e2] = p.steps;
    connect(p, s.id, 'next', a.id);
    connect(p, a.id, 'next', r.id);
    connect(p, r.id, 'next', e1.id); // o palete (metade) termina
    connect(p, r.id, 'extracted', b.id); // as caixas retiradas seguem
    connect(p, b.id, 'next', pz.id);
    connect(p, pz.id, 'next', e2.id);
    expect(validateProcess(p).filter((i) => i.level === 'erro')).toEqual([]);
    sc.processes = [p];
    sc.useCustomProcesses = true;
    const { m, k } = run(sc);
    expect(k.trucksInPerDay).toBeGreaterThan(5);
    expect(m.workers.items.some((a) => a.busyTime > 0)).toBe(true); // pessoas movimentaram caixas
    expect(m.world.triages.reduce((n, t) => n + t.occupied, 0)).toBeGreaterThan(0);
  });
  it('Separar: palete avariado inteiro segue pela saída "avariados" sem criar segundo palete', () => {
    const sc = base();
    sc.checkers.count = 3;
    sc.receiving.damagePalletPct = 1;
    sc.receiving.damagedCartonsFraction = { kind: 'constant', a: 1 };
    withTemplate(sc, 'rec-conf-direta');
    const { k } = run(sc);
    expect(k.wholePalletTriagePerDay).toBeGreaterThan(0);
    expect(k.palletsInPerDay).toBe(0); // todos inteiros para a triagem
  });
});

describe('grafo do processo', () => {
  it('conectar valida portas e impede apontar para o Início', () => {
    const p = templateById('rec-conf-direta')!.make();
    const start = p.steps.find((s) => s.type === 'start')!;
    const sep = p.steps.find((s) => s.type === 'separate')!;
    expect(connect(p, sep.id, 'next', start.id)).toBe(false);
    expect(connect(p, sep.id, 'nextNo', p.steps[2].id)).toBe(false); // separar não tem saída "não"
    expect(connect(p, sep.id, 'next', 'inexistente')).toBe(false);
    expect(portsOf(sep).map((q) => q.key)).toEqual(['next', 'nextBad']);
  });
  it('remover bloco desliga as setas que chegavam nele', () => {
    const p = templateById('rec-direto')!.make();
    const addr = p.steps.find((s) => s.type === 'address')!;
    const mv = p.steps.find((s) => s.type === 'move')!;
    expect(getPort(mv, 'next')).toBe(addr.id);
    removeStep(p, addr.id);
    expect(getPort(mv, 'next')).toBeUndefined();
    expect(validateProcess(p).some((i) => i.level === 'erro' && /não está ligada/.test(i.msg))).toBe(true);
  });
  it('validação: sem Início, bloco solto, primeiro bloco errado e recurso vazio', () => {
    const p: ProcessDef = { id: 'p', name: 'x', trigger: 'unloadPallet', steps: [] };
    expect(validateProcess(p).some((i) => /não tem bloco Início/.test(i.msg))).toBe(true);
    addStep(p, 'start', 0, 0);
    const w = addStep(p, 'wait', 0, 0);
    connect(p, p.steps[0].id, 'next', w.id);
    expect(validateProcess(p).some((i) => /primeiro bloco/.test(i.msg))).toBe(true);
    const lone = addStep(p, 'move', 0, 0) as MoveStep;
    lone.with = [];
    const msgs = validateProcess(p).map((i) => i.msg).join('|');
    expect(msgs).toMatch(/não é alcançado/);
    expect(msgs).toMatch(/escolha ao menos um recurso/);
  });
  it('validação do cenário: ativo sem processo é erro; processos com problemas viram avisos', () => {
    const sc = base();
    sc.useCustomProcesses = true;
    expect(validate(layout, sc).some((i) => i.level === 'erro' && /nenhum processo de recebimento/.test(i.msg))).toBe(true);
    sc.processes = [templateById('rec-conf-direta')!.make(sc)];
    expect(validate(layout, sc).filter((i) => i.level === 'erro' && /Processo/.test(i.msg))).toEqual([]);
    expect(validate(layout, sc).some((i) => /nenhum recurso de/.test(i.msg))).toBe(true); // conferentes = 0
  });
});

describe('persistência e organização', () => {
  it('ida e volta no Excel preserva processos, blocos, setas e parâmetros', async () => {
    const { exportTemplate, importWorkbook } = await import('../src/io/excel');
    const sc = base();
    sc.checkers.count = 3;
    sc.equipment[1].count = 2;
    sc.processes = [templateById('rec-conf-faseada')!.make(sc), templateById('rec-direto')!.make(sc)];
    sc.useCustomProcesses = true;
    const r = await importWorkbook(await exportTemplate(sc, layout));
    expect(r.warnings).toEqual([]);
    expect(r.scenario.useCustomProcesses).toBe(true);
    expect(r.scenario.processes).toHaveLength(2);
    const [a, b] = r.scenario.processes;
    expect(a.name).toBe(sc.processes[0].name);
    expect(a.steps).toEqual(sc.processes[0].steps.map((s) => ({ ...s, x: Math.round(s.x), y: Math.round(s.y) })));
    expect(b.steps.length).toBe(sc.processes[1].steps.length);
    expect(validateProcess(a).filter((i) => i.level === 'erro')).toEqual([]);
    // o processo importado roda
    r.scenario.days = 1;
    r.scenario.warmupHours = 0;
    expect(run(r.scenario, r.layout!).k.palletsInPerDay).toBeGreaterThan(50);
  });
  it('organizar automaticamente coloca o Início no topo e cada camada abaixo da anterior', async () => {
    const { autoLayout } = await import('../src/model/process');
    const p = templateById('rec-conf-direta')!.make();
    for (const s of p.steps) { s.x = 0; s.y = 0; }
    autoLayout(p);
    const start = p.steps.find((s) => s.type === 'start')!;
    const move = p.steps.find((s) => s.type === 'move')!;
    expect(start.y).toBeLessThan(move.y);
    // nenhum bloco sobre outro
    const pos = new Set(p.steps.map((s) => `${s.x},${s.y}`));
    expect(pos.size).toBe(p.steps.length);
  });
  it('aba de planilha com tipo desconhecido avisa e ignora a linha', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const { importWorkbook } = await import('../src/io/excel');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Processos');
    ws.addRow(['Processo_Id', 'Nome_Processo', 'Bloco_Id', 'Tipo', 'X', 'Y', 'Rotulo', 'Saidas', 'Parametros']);
    ws.addRow(['p1', 'Teste', 's1', 'start', 0, 0, null, '{}', '{}']);
    ws.addRow(['p1', 'Teste', 's2', 'teletransportar', 0, 0, null, '{}', '{}']);
    const r = await importWorkbook(new Uint8Array(await wb.xlsx.writeBuffer()));
    expect(r.warnings.some((w) => /desconhecido/.test(w))).toBe(true);
    expect(r.scenario.processes[0].steps).toHaveLength(1);
  });
});

describe('análise analítica com processo personalizado', () => {
  it('avisa que continua modelando o fluxo padrão', async () => {
    const { analyzeCapacity } = await import('../src/analysis/capacity');
    const sc = base();
    expect(analyzeCapacity(sc, layout).assumptions.join(' ')).not.toMatch(/Processo personalizado ativo/);
    sc.useCustomProcesses = true;
    sc.processes = [templateById('rec-direto')!.make(sc)];
    expect(analyzeCapacity(sc, layout).assumptions[0]).toMatch(/Processo personalizado ativo/);
  });
});
