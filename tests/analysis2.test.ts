import { describe, expect, it } from 'vitest';
import { analyzeCapacity } from '../src/analysis/capacity';
import { diagnose } from '../src/analysis/diagnose';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { checkStats, meanTrailerDepth } from '../src/model/receiving';
import { presetVehicle, vehicleMeans } from '../src/model/traffic';
import { runExperiment } from '../src/sim/runner';
import type { Scenario } from '../src/model/types';

const layout = generateLayout(defaultLayoutParams());
const row = (sc: Scenario, key: string, l = layout) => analyzeCapacity(sc, l).rows.find((r) => r.key === key);
const full = (): Scenario => {
  const sc = defaultScenario();
  sc.days = 3;
  sc.warmupHours = 8;
  sc.replications = 3;
  sc.checkers.count = 4;
  sc.receiving.damagePalletPct = 0.1;
  sc.forklifts.count = 8;
  sc.storage = { mode: 'phased', step1With: ['palletTruck', 'amr'] };
  sc.equipment[1].count = 3; // transpaleteira
  sc.equipment[2].count = 2; // AMR
  sc.equipment[2].amr!.autonomyMin = 120;
  return sc;
};

describe('análise analítica estendida', () => {
  it('cenário padrão: só as linhas de sempre (nada novo ligado)', () => {
    const keys = analyzeCapacity(defaultScenario(), layout).rows.map((r) => r.key);
    expect(keys).toEqual(['forklift', 'worker', 'dockIn', 'dockOut', 'conveyor']);
  });
  it('com conferentes: linhas de conferentes e stage; avaria aumenta o tempo por palete', () => {
    const sc = defaultScenario();
    sc.checkers.count = 3;
    sc.receiving.damagePalletPct = 0;
    const sem = row(sc, 'checker')!;
    expect(row(sc, 'stage')).toBeDefined();
    sc.receiving.damagePalletPct = 0.3;
    const com = row(sc, 'checker')!;
    expect(com.meanServiceSec).toBeGreaterThan(sem.meanServiceSec * 1.2);
    expect(com.rhoAvg).toBeGreaterThan(sem.rhoAvg);
  });
  it('estatísticas de conferência: determinísticas e coerentes com a avaria configurada', () => {
    const sc = defaultScenario();
    sc.receiving.damagePalletPct = 0.2;
    sc.receiving.damagedCartonsFraction = { kind: 'constant', a: 1 };
    const a = checkStats(sc);
    const b = checkStats(sc);
    expect(a).toEqual(b);
    expect(a.pDamaged).toBe(0.2);
    expect(a.pWhole).toBe(1); // 100% das caixas => sempre inteiro
    expect(a.meanBadPartial).toBe(0);
    sc.receiving.damagedCartonsFraction = { kind: 'constant', a: 0.25 };
    const c = checkStats(sc);
    expect(c.pWhole).toBe(0);
    expect(c.meanBadPartial).toBe(Math.round(0.25 * c.cartonsPerPallet)); // arredonda para caixas inteiras
  });
  it('faseada: linhas de transitórios e movimentadores; sem equipamento de etapa 1 a empilhadeira pesa mais', () => {
    const sc = full();
    expect(row(sc, 'transit')).toBeDefined();
    expect(row(sc, 'mover')).toBeDefined();
    const com = row(sc, 'forklift')!;
    sc.equipment[1].count = 0;
    sc.equipment[2].count = 0;
    const sem = row(sc, 'forklift')!;
    expect(sem.meanServiceSec).toBeGreaterThan(com.meanServiceSec);
    expect(row(sc, 'mover')).toBeUndefined(); // sem unidades, nada de linha
    const direta = defaultScenario();
    direta.checkers.count = 3;
    expect(row(direta, 'transit')).toBeUndefined();
  });
  it('baú maior aumenta o tempo da tarefa da empilhadeira', () => {
    const a = defaultScenario();
    const b = defaultScenario();
    a.vehicleTypes = [{ ...presetVehicle('carreta'), share: 1, trailerLengthM: 4 }];
    b.vehicleTypes = [{ ...presetVehicle('carreta'), share: 1, trailerLengthM: 16 }];
    expect(vehicleMeans(b, 'in').depthM).toBeGreaterThan(vehicleMeans(a, 'in').depthM);
    expect(meanTrailerDepth(24, 16)).toBeGreaterThan(meanTrailerDepth(24, 4));
    expect(row(b, 'forklift')!.meanServiceSec).toBeGreaterThan(row(a, 'forklift')!.meanServiceSec);
    a.receiving.trailerDepth = false;
    b.receiving.trailerDepth = false;
    expect(row(b, 'forklift')!.meanServiceSec).toBeCloseTo(row(a, 'forklift')!.meanServiceSec, 6); // sem profundidade, o tamanho do baú não importa
  });
  it('descarga fora da empilhadeira alivia a empilhadeira e carrega os movimentadores', () => {
    const sc = full();
    sc.storage = { mode: 'direct', step1With: [] };
    sc.checkers.count = 0;
    const base = row(sc, 'forklift')!.meanServiceSec;
    sc.receiving.unloadWith = ['palletTruck'];
    expect(row(sc, 'forklift')!.meanServiceSec).toBeLessThan(base);
    expect(row(sc, 'mover')).toBeDefined();
  });
  it('AMR: vaga de carga dimensionada; calendário junta todos; mais autonomia pede menos', () => {
    const sc = full();
    const a = row(sc, 'charger')!;
    expect(a.current).toBe(1);
    expect(a.requiredPeak).toBeLessThanOrEqual(2);
    sc.equipment[2].amr!.chargeAtHours = [12];
    expect(row(sc, 'charger')!.requiredPeak).toBe(2); // calendário: todos ao mesmo tempo
    sc.equipment[2].amr!.chargeAtHours = [];
    sc.equipment[2].amr!.autonomyMin = 100000;
    expect(row(sc, 'charger')!.requiredAvg).toBeLessThanOrEqual(a.requiredAvg);
  });
  it('triagem: acumulação até a coleta; coletar com mais frequência reduz a necessidade', () => {
    const sc = full();
    sc.receiving.triageClearEveryHours = 24;
    const dia = row(sc, 'triage')!;
    sc.receiving.triageClearEveryHours = 4;
    const quatro = row(sc, 'triage')!;
    expect(quatro.requiredPeak).toBeLessThan(dia.requiredPeak);
    sc.receiving.damagePalletPct = 0;
    expect(row(sc, 'triage')).toBeUndefined();
  });
  it('concorda com a simulação nas ordens de grandeza (utilizações e picos)', () => {
    const sc = full();
    const cap = analyzeCapacity(sc, layout);
    const k = runExperiment(sc, layout).kpis;
    const get = (key: string) => cap.rows.find((r) => r.key === key)!;
    expect(Math.abs(get('forklift').rhoAvg - k.utilForklift.mean)).toBeLessThan(0.15);
    expect(Math.abs(get('checker').rhoAvg - k.utilChecker.mean)).toBeLessThan(0.1);
    expect(Math.abs(get('mover').rhoAvg - k.utilMover.mean)).toBeLessThan(0.15);
    // o pico de stage/transitórios é estimativa: mesma ordem de grandeza da ocupação máxima simulada
    const ratio = (est: number, sim: number) => est / Math.max(1, sim);
    expect(ratio(get('stage').requiredPeak, k.stageOccupancyMax.mean)).toBeGreaterThan(0.4);
    expect(ratio(get('stage').requiredPeak, k.stageOccupancyMax.mean)).toBeLessThan(2.5);
    expect(ratio(get('transit').requiredPeak, k.transitOccupancyMax.mean)).toBeGreaterThan(0.4);
    expect(ratio(get('transit').requiredPeak, k.transitOccupancyMax.mean)).toBeLessThan(2.5);
  });
  it('estoque: paletes avariados inteiros não entram na contagem de entradas', () => {
    const a = defaultScenario();
    a.checkers.count = 3;
    a.receiving.damagePalletPct = 0;
    const b = defaultScenario();
    b.checkers.count = 3;
    b.receiving.damagePalletPct = 0.5;
    b.receiving.damagedCartonsFraction = { kind: 'constant', a: 1 };
    expect(analyzeCapacity(b, layout).storage.dailyInPallets).toBeCloseTo(analyzeCapacity(a, layout).storage.dailyInPallets * 0.5, 0);
  });
});

describe('diagnóstico dos novos processos', () => {
  const diag = (sc: Scenario, mutate?: (r: ReturnType<typeof runExperiment>) => void) => {
    const res = runExperiment(sc, layout);
    mutate?.(res);
    return diagnose(sc, res, analyzeCapacity(sc, layout)).map((i) => i.text).join('\n');
  };
  it('aponta stage cheio, rua cheia e triagem lotada citando o dimensionamento', () => {
    const sc = full();
    sc.replications = 2;
    const l = generateLayout(defaultLayoutParams());
    void l;
    const res = runExperiment(sc, layout);
    res.kpis.stageWaitMean.mean = 6;
    res.kpis.transitWaitMean.mean = 3;
    res.kpis.triageOverflowPerDay.mean = 4;
    res.kpis.chargerWaitMean.mean = 5;
    res.kpis.amrChargesPerDay.mean = 8;
    const t = diagnose(sc, res, analyzeCapacity(sc, layout)).map((i) => i.text).join('\n');
    expect(t).toMatch(/Stage cheio/);
    expect(t).toMatch(/Rua cheia/);
    expect(t).toMatch(/Triagem lotada/);
    expect(t).toMatch(/Faltam vagas na estação de carga/);
    expect(t).toMatch(/dimensionamento analítico \(estimativa\)/);
  });
  it('sem problemas nos novos processos não gera alarmes deles', () => {
    const sc = defaultScenario();
    sc.replications = 2;
    sc.days = 2;
    const t = diag(sc);
    expect(t).not.toMatch(/Stage cheio|Rua cheia|Triagem lotada|AMR:/);
  });
});

describe('cenário de demonstração completo', () => {
  it('liga todos os processos, passa pela planilha e simula com todos os indicadores novos', async () => {
    const { exemploCompleto } = await import('../scripts/exemplo-completo');
    const { exportTemplate, importWorkbook } = await import('../src/io/excel');
    const { sc, layout: l } = exemploCompleto();
    const r = await importWorkbook(await exportTemplate(sc, l));
    expect(r.warnings).toEqual([]);
    const s = r.scenario;
    expect(s.vehicleTypes).toHaveLength(2);
    expect(s.storage.mode).toBe('phased');
    expect(s.equipment[2].count).toBe(2);
    expect(s.calendar.breaks).toHaveLength(2);
    s.replications = 2;
    s.days = 2;
    const res = runExperiment(s, r.layout!);
    const k = res.kpis;
    expect(k.palletsInPerDay.mean).toBeGreaterThan(50);
    expect(k.phasedShare.mean).toBeGreaterThan(0.8);
    expect(k.utilMover.mean).toBeGreaterThan(0);
    expect(k.damagedPalletPct.mean).toBeGreaterThan(0);
    expect(k.amrChargesPerDay.mean).toBeGreaterThan(0);
    expect(k.trucksDelayedPct.mean).toBeGreaterThan(0);
    expect(res.vehicleStats.map((v) => v.name)).toEqual(['Carreta', 'Truck']);
    const cap = analyzeCapacity(s, r.layout!);
    expect(cap.rows.map((x) => x.key)).toEqual(expect.arrayContaining(['forklift', 'checker', 'mover', 'stage', 'transit', 'triage', 'charger']));
  });
});
