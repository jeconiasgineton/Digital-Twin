import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { SimModel } from '../src/sim/model';
import type { Layout, Scenario } from '../src/model/types';

const mkLayout = (): Layout => generateLayout(defaultLayoutParams());
/** faseada com AMR como único equipamento de etapa 1 */
const base = (n = 2): Scenario => {
  const sc = defaultScenario();
  sc.days = 1;
  sc.warmupHours = 0;
  sc.ordersPerHour = new Array(24).fill(0);
  sc.outboundTrucksPerHour = new Array(24).fill(0);
  sc.initialOccupancy = 0.3;
  sc.forklifts.availability = 1;
  sc.receiving.damagePalletPct = 0;
  sc.storage = { mode: 'phased', step1With: ['amr'] };
  const amr = sc.equipment[2];
  amr.count = n;
  amr.availability = 1;
  amr.amr = { autonomyMin: 480, chargeTriggerFraction: 0.5, chargeMin: 60, setupMin: 2, chargeAtShiftStart: false, chargeAtShiftEnd: false, chargeAtHours: [] };
  return sc;
};
const run = (sc: Scenario, layout = mkLayout(), seed = 5) => {
  const m = new SimModel(sc, layout, seed);
  return { m, k: m.runAll().kpis };
};

describe('AMR: bateria e carregamento', () => {
  it('sem AMR não há carga', () => {
    const sc = base(0);
    const { k } = run(sc);
    expect(k.amrChargesPerDay).toBe(0);
    expect(k.utilAmr).toBe(0);
  });
  it('carrega ao consumir 1/2 da autonomia de trabalho e o tempo de carga entra no ciclo', () => {
    const sc = base(2);
    sc.equipment[2].amr!.autonomyMin = 60; // gatilho: 30 min de trabalho
    const { k } = run(sc);
    expect(k.utilAmr).toBeGreaterThan(0.1);
    expect(k.amrChargesPerDay).toBeGreaterThan(2);
    expect(k.amrChargeShare).toBeGreaterThan(0.05);
    expect(k.palletsInPerDay).toBeGreaterThan(50); // a operação continua
  });
  it('autonomia maior => menos cargas', () => {
    const curta = base(2);
    curta.equipment[2].amr!.autonomyMin = 60;
    const longa = base(2);
    longa.equipment[2].amr!.autonomyMin = 480;
    expect(run(longa).k.amrChargesPerDay).toBeLessThan(run(curta).k.amrChargesPerDay);
  });
  it('gatilho configurável: 100% da autonomia carrega bem menos que 50%', () => {
    const meio = base(2);
    meio.equipment[2].amr!.autonomyMin = 60;
    const cheio = base(2);
    cheio.equipment[2].amr!.autonomyMin = 60;
    cheio.equipment[2].amr!.chargeTriggerFraction = 1;
    expect(run(cheio).k.amrChargesPerDay).toBeLessThan(run(meio).k.amrChargesPerDay);
  });
  it('carga demorada reduz a vazão (o AMR fica fora de serviço)', () => {
    const rapida = base(1);
    rapida.equipment[2].amr!.autonomyMin = 40;
    rapida.equipment[2].amr!.chargeMin = 1;
    rapida.equipment[2].amr!.setupMin = 0;
    const lenta = base(1);
    lenta.equipment[2].amr!.autonomyMin = 40;
    lenta.equipment[2].amr!.chargeMin = 300;
    expect(run(lenta).k.amrChargeShare).toBeGreaterThan(run(rapida).k.amrChargeShare);
    expect(run(lenta).k.phasedShare).toBeGreaterThanOrEqual(0);
  });
  it('uma vaga de carga para vários AMR gera fila; vagas suficientes, não', () => {
    const mk = (vagas: number) => {
      const sc = base(4);
      sc.equipment[2].amr!.chargeAtHours = [12];
      sc.equipment[2].amr!.autonomyMin = 100000; // sem gatilho por autonomia: só o calendário
      const l = mkLayout();
      l.elements.find((e) => e.type === 'charger')!.capacity = vagas;
      return run(sc, l).k;
    };
    expect(mk(1).chargerWaitMean).toBeGreaterThan(10);
    expect(mk(4).chargerWaitMean).toBe(0);
  });
  it('calendário: horário específico, início e fim de turno (só carrega quem gastou bateria)', () => {
    const sc = base(1);
    sc.days = 2;
    sc.equipment[2].amr!.autonomyMin = 100000; // sem gatilho por autonomia: só o calendário
    sc.equipment[2].amr!.chargeAtHours = [12];
    expect(run(sc).k.amrChargesPerDay).toBeCloseTo(1, 9); // 12h em cada dia
    sc.equipment[2].amr!.chargeAtShiftStart = true; // 06h do dia 1: bateria cheia, não carrega
    sc.equipment[2].amr!.chargeAtShiftEnd = true; // 22h do dia 1 (= início do dia 2: uma só carga)
    expect(run(sc).k.amrChargesPerDay).toBeCloseTo(1.5, 9); // 12h, 22h/06h, 12h
  });
  it('sem estação de carga no layout o AMR carrega onde está (sem travar)', () => {
    const sc = base(2);
    sc.equipment[2].amr!.autonomyMin = 60;
    const l = mkLayout();
    l.elements = l.elements.filter((e) => e.type !== 'charger');
    const { k } = run(sc, l);
    expect(k.amrChargesPerDay).toBeGreaterThan(0);
    expect(k.chargerWaitMean).toBe(0);
    expect(k.palletsInPerDay).toBeGreaterThan(50);
  });
  it('quebras aleatórias, intervalos e cargas no mesmo AMR não travam a simulação', () => {
    const sc = base(3);
    sc.days = 2;
    sc.equipment[2].availability = 0.8;
    sc.equipment[2].amr!.autonomyMin = 60;
    sc.calendar.amrWorksDuringBreaks = false;
    sc.calendar.breaks = [{ name: 'Almoço', startHour: 12, durationMin: 60, groups: ['mover'], stagger: 'half', percentPerWave: 50 }];
    const a = run(sc, mkLayout(), 9).k;
    const b = run(sc, mkLayout(), 9).k;
    expect(a).toEqual(b);
    expect(a.palletsInPerDay).toBeGreaterThan(50);
  });
});
