import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { SimModel } from '../src/sim/model';
import { arrivalProfile, breakMinutesPerDay, breakWaves, defaultBreak, effectiveVehicles, presetVehicle, vehicleMeans, waveOf } from '../src/model/traffic';
import type { Scenario } from '../src/model/types';

const layout = generateLayout(defaultLayoutParams());
const base = (): Scenario => {
  const sc = defaultScenario();
  sc.days = 1;
  sc.warmupHours = 0;
  sc.replications = 1;
  return sc;
};
const run = (sc: Scenario, seed = 7) => {
  const m = new SimModel(sc, layout, seed);
  const r = m.runAll();
  return { m, r };
};

describe('chegadas de veículos', () => {
  it('intervalo fixo: um caminhão a cada 10 min gera 96 chegadas em 16 h', () => {
    const sc = base();
    sc.arrivalsIn = { ...sc.arrivalsIn, mode: 'fixed', intervalMin: 10, delayProb: 0 };
    sc.ordersPerHour = new Array(24).fill(0);
    sc.outboundTrucksPerHour = new Array(24).fill(0);
    const { m } = run(sc);
    expect(m.c.scheduled).toBe(96);
  });
  it('agenda: só horários dentro do turno; atraso com probabilidade 1 e duração fixa', () => {
    const sc = base(); // turno 06h–22h
    sc.arrivalsIn = { mode: 'scheduled', intervalMin: 30, scheduleHours: [6, 6.5, 7, 23, 3], delayProb: 1, delayMin: { kind: 'constant', a: 30 } };
    sc.ordersPerHour = new Array(24).fill(0);
    sc.outboundTrucksPerHour = new Array(24).fill(0);
    const { m, r } = run(sc);
    expect(m.c.scheduled).toBe(3); // 23h e 03h ficam fora do turno
    expect(r.kpis.trucksDelayedPct).toBe(1);
    expect(r.kpis.truckDelayMean).toBeCloseTo(30, 6);
  });
  it('sem atraso configurado, nenhum veículo é marcado como atrasado', () => {
    const sc = base();
    sc.arrivalsIn = { ...sc.arrivalsIn, mode: 'fixed', intervalMin: 20, delayProb: 0 };
    expect(run(sc).r.kpis.trucksDelayedPct).toBe(0);
  });
  it('perfil analítico acompanha o modo de chegada', () => {
    const sc = base();
    sc.arrivalsIn = { ...sc.arrivalsIn, mode: 'fixed', intervalMin: 10 };
    expect(arrivalProfile(sc, 'in')[10]).toBeCloseTo(6, 9);
    sc.arrivalsIn = { ...sc.arrivalsIn, mode: 'scheduled', scheduleHours: [6, 6.5, 7] };
    expect(arrivalProfile(sc, 'in').slice(5, 9)).toEqual([0, 2, 1, 0]);
  });
});

describe('tipos de veículo', () => {
  it('carreta e truck docam em tempos diferentes (3 min × 1 min)', () => {
    const sc = base();
    const carreta = { ...presetVehicle('carreta'), share: 0.5, dockTurnover: { kind: 'constant' as const, a: 180 } };
    const truck = { ...presetVehicle('truck'), share: 0.5, dockTurnover: { kind: 'constant' as const, a: 60 } };
    sc.vehicleTypes = [carreta, truck];
    sc.arrivalsIn = { ...sc.arrivalsIn, mode: 'fixed', intervalMin: 6, delayProb: 0 };
    sc.ordersPerHour = new Array(24).fill(0);
    const { r } = run(sc);
    const [c, t] = r.vehicleStats;
    expect(c.name).toBe('Carreta');
    expect(c.dockTurnMean).toBeCloseTo(3, 6);
    expect(t.dockTurnMean).toBeCloseTo(1, 6);
    expect(c.trucks + t.trucks).toBeGreaterThan(25); // a descarga em série (um equipamento por vez no baú) reduz o total
    expect(Math.abs(c.trucks - t.trucks)).toBeLessThan(0.35 * (c.trucks + t.trucks));
  });
  it('sem tipos cadastrados usa um tipo único com os parâmetros gerais; médias ponderadas por participação', () => {
    const sc = base();
    sc.vehicleTypes = [];
    expect(effectiveVehicles(sc, 'in')).toHaveLength(1);
    expect(vehicleMeans(sc, 'in').pallets).toBe(sc.palletsPerTruckIn.mean);
    sc.vehicleTypes = [
      { ...presetVehicle('carreta'), share: 3, shareIn: undefined, shareOut: undefined, capacityPallets: 33, pallets: { mean: 30, sd: 0, max: 33 }, dockTurnover: { kind: 'constant', a: 180 } },
      { ...presetVehicle('truck'), share: 1, shareIn: undefined, shareOut: undefined, capacityPallets: 14, pallets: { mean: 10, sd: 0, max: 14 }, dockTurnover: { kind: 'constant', a: 60 } },
    ];
    const m = vehicleMeans(sc, 'in');
    expect(m.pallets).toBeCloseTo(25, 9);
    expect(m.dockSec).toBeCloseTo(150, 9);
  });
  it('% de caminhões acima do limite de espera sobe quando as docas são o gargalo', () => {
    const sc = base();
    sc.arrivalsIn = { ...sc.arrivalsIn, mode: 'fixed', intervalMin: 2, delayProb: 0 };
    sc.dockWaitThresholdMin = 1;
    const l = generateLayout({ ...defaultLayoutParams(), docksIn: 1 });
    const r = new SimModel(sc, l, 3).runAll();
    expect(r.kpis.dockWaitOverPctIn).toBeGreaterThan(0.3);
  });
});

describe('calendário e intervalos', () => {
  const idle = () => {
    const sc = base();
    sc.demandFactor = 0; // sem demanda: todos ociosos; ociosos = total − parados
    sc.forklifts.count = 4;
    sc.forklifts.availability = 1;
    return sc;
  };
  const idleAt = (sc: Scenario, hoursAfterStart: number) => {
    const m = new SimModel(sc, layout, 1);
    m.runUntil(hoursAfterStart * 3600);
    return m.forklifts.idleCount;
  };
  it('ondas: todos juntos, metade por vez e percentual por vez', () => {
    const b = { ...defaultBreak('almoco'), startHour: 12, durationMin: 60 }; // 12h = 6 h após o início (6h)
    expect(breakWaves({ ...b, stagger: 'all' })).toBe(1);
    expect(breakWaves({ ...b, stagger: 'half' })).toBe(2);
    expect(breakWaves({ ...b, stagger: 'percent', percentPerWave: 25 })).toBe(4);
    expect([0, 1, 2, 3].map((i) => waveOf({ ...b, stagger: 'half' }, i, 4))).toEqual([0, 0, 1, 1]);

    const all = idle();
    all.calendar.breaks = [{ ...b, stagger: 'all', groups: ['forklift'] }];
    expect(idleAt(all, 6.5)).toBe(0); // os 4 em intervalo
    expect(idleAt(all, 7.1)).toBe(4);

    const half = idle();
    half.calendar.breaks = [{ ...b, stagger: 'half', groups: ['forklift'] }];
    expect(idleAt(half, 6.5)).toBe(2); // 1ª metade parada
    expect(idleAt(half, 7.5)).toBe(2); // 2ª metade parada
    expect(idleAt(half, 8.1)).toBe(4);

    const pct = idle();
    pct.calendar.breaks = [{ ...b, stagger: 'percent', percentPerWave: 25, groups: ['forklift'] }];
    for (const h of [6.5, 7.5, 8.5, 9.5]) expect(idleAt(pct, h)).toBe(3); // 1 por vez
    expect(idleAt(pct, 10.1)).toBe(4);
  });
  it('grupos específicos: o intervalo só atinge os grupos marcados', () => {
    const sc = idle();
    sc.workers.count = 3;
    sc.workers.availability = 1;
    sc.calendar.breaks = [{ ...defaultBreak('almoco'), stagger: 'all', groups: ['worker'] }];
    const m = new SimModel(sc, layout, 1);
    m.runUntil(6.5 * 3600);
    expect(m.workers.idleCount).toBe(0);
    expect(m.forklifts.idleCount).toBe(4);
  });
  it('horas úteis = turno − intervalos; produtividade por hora útil', () => {
    const sc = base();
    sc.calendar.breaks = [{ ...defaultBreak('almoco'), stagger: 'all' }, { ...defaultBreak('cafe') }];
    expect(breakMinutesPerDay(sc, 'forklift')).toBe(75);
    const k = run(sc).r.kpis;
    expect(k.breakHoursPerDay).toBeCloseTo(1.25, 9);
    expect(k.productiveHoursPerDay).toBeCloseTo(16 - 1.25, 9);
    expect(k.nonWorkingHoursPerDay).toBe(8);
  });
  it('intervalo fora do turno é ignorado', () => {
    const sc = base();
    sc.calendar.breaks = [{ ...defaultBreak('almoco'), startHour: 3 }];
    expect(breakMinutesPerDay(sc, 'forklift')).toBe(0);
  });
  it('intervalos com quebras aleatórias no mesmo recurso não travam a simulação (determinístico)', () => {
    const sc = base();
    sc.days = 2;
    sc.forklifts.availability = 0.8;
    sc.calendar.breaks = [{ ...defaultBreak('almoco'), stagger: 'all' }];
    const a = run(sc, 9).r.kpis;
    const b = run(sc, 9).r.kpis;
    expect(a).toEqual(b);
    expect(a.palletsInPerDay).toBeGreaterThan(50);
  });
  it('intervalo para todos reduz a vazão frente à operação sem intervalos', () => {
    const a = base();
    a.forklifts.count = 3;
    const b = base();
    b.forklifts.count = 3;
    b.calendar.breaks = [{ ...defaultBreak('almoco'), startHour: 8, durationMin: 240, stagger: 'all' }];
    expect(run(b).r.kpis.palletsInPerDay + run(b).r.kpis.palletsOutPerDay).toBeLessThan(run(a).r.kpis.palletsInPerDay + run(a).r.kpis.palletsOutPerDay);
  });
});

describe('planilha: veículos, chegadas e intervalos', () => {
  it('ida e volta preserva tipos, modos de chegada, atrasos e intervalos', async () => {
    const { exportTemplate, importWorkbook } = await import('../src/io/excel');
    const sc = base();
    sc.vehicleTypes = [
      { ...presetVehicle('carreta'), name: 'Carreta', share: 0.6, dockTurnover: { kind: 'constant', a: 180 } },
      { ...presetVehicle('truck'), name: 'Truck', share: 0.4, dockTurnover: { kind: 'triangular', a: 40, b: 60, c: 100 } },
    ];
    sc.arrivalsIn = { mode: 'fixed', intervalMin: 10, scheduleHours: [], delayProb: 0.15, delayMin: { kind: 'lognormal', a: 30, b: 12 } };
    sc.arrivalsOut = { mode: 'scheduled', intervalMin: 30, scheduleHours: [7, 8.5, 14], delayProb: 0.3, delayMin: { kind: 'lognormal', a: 20, b: 5 } };
    sc.dockWaitThresholdMin = 7;
    sc.calendar.amrWorksDuringBreaks = false;
    sc.calendar.breaks = [
      { name: 'Almoço', startHour: 12, durationMin: 60, groups: ['forklift', 'worker', 'checker'], stagger: 'half', percentPerWave: 50 },
      { name: 'Café', startHour: 16.5, durationMin: 15, groups: ['worker'], stagger: 'percent', percentPerWave: 25 },
    ];
    const r = await importWorkbook(await exportTemplate(sc, layout));
    expect(r.warnings).toEqual([]);
    const s = r.scenario;
    expect(s.vehicleTypes.map((v) => [v.name, v.share, v.dockTurnover.kind])).toEqual([['Carreta', 0.6, 'constant'], ['Truck', 0.4, 'triangular']]);
    expect(s.vehicleTypes[0].dockTurnover.a).toBe(180);
    expect(s.arrivalsIn).toMatchObject({ mode: 'fixed', intervalMin: 10, delayProb: 0.15 });
    expect(s.arrivalsIn.delayMin).toMatchObject({ a: 30, b: 12 });
    expect(s.arrivalsOut).toMatchObject({ mode: 'scheduled', scheduleHours: [7, 8.5, 14], delayProb: 0.3 });
    expect(s.dockWaitThresholdMin).toBe(7);
    expect(s.calendar.amrWorksDuringBreaks).toBe(false);
    expect(s.calendar.breaks).toEqual(sc.calendar.breaks);
  });
  it('horário aceita 12:30 e grupos inválidos geram aviso', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const { importWorkbook } = await import('../src/io/excel');
    const wb = new ExcelJS.Workbook();
    const p = wb.addWorksheet('Parametros');
    p.addRow(['Parametro', 'Valor']);
    p.addRow(['chegada_entrada_modo', 'agendado']);
    p.addRow(['chegada_entrada_horarios', '06:30;7h15;8']);
    const b = wb.addWorksheet('Intervalos');
    b.addRow(['Nome', 'Inicio', 'Duracao_min', 'Grupos', 'Escalonamento', 'Percentual']);
    b.addRow(['Almoço', '12:30', 45, 'empilhadeira;operario', 'percentual', 20]);
    b.addRow(['Ruim', 13, 10, 'marcianos', 'todos', 50]);
    const r = await importWorkbook(new Uint8Array(await wb.xlsx.writeBuffer()));
    expect(r.scenario.arrivalsIn.scheduleHours).toEqual([6.5, 7.25, 8]);
    expect(r.scenario.calendar.breaks).toEqual([{ name: 'Almoço', startHour: 12.5, durationMin: 45, groups: ['forklift', 'worker'], stagger: 'percent', percentPerWave: 20 }]);
    expect(r.warnings.some((w) => /grupos inválidos/.test(w))).toBe(true);
  });
});
