import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { presetVehicle } from '../src/model/traffic';
import { SimModel } from '../src/sim/model';
import type { Layout, Scenario } from '../src/model/types';

const layout: Layout = generateLayout(defaultLayoutParams());
const base = (): Scenario => {
  const sc = defaultScenario();
  sc.days = 1;
  sc.warmupHours = 0;
  sc.ordersPerHour = new Array(24).fill(0);
  sc.initialOccupancy = 0.4;
  sc.forklifts.count = 10;
  sc.forklifts.availability = 1;
  return sc;
};
const run = (sc: Scenario, l: Layout = layout, seed = 5) => {
  const m = new SimModel(sc, l, seed);
  return { m, k: m.runAll().kpis };
};

describe('veículo: um equipamento por vez dentro do baú', () => {
  it('com exclusividade nunca há mais de um equipamento dentro do mesmo veículo (recebimento)', () => {
    const sc = base();
    sc.outboundTrucksPerHour = new Array(24).fill(0);
    const { m, k } = run(sc);
    expect(k.palletsInPerDay).toBeGreaterThan(100);
    expect(m.maxInside).toBe(1);
  });
  it('sem exclusividade vários equipamentos entram juntos', () => {
    const sc = base();
    sc.outboundTrucksPerHour = new Array(24).fill(0);
    sc.vehicleExclusive = false;
    const { m, k } = run(sc);
    expect(m.maxInside).toBe(0); // sem trava não há contagem; vários trabalham ao mesmo tempo
    expect(k.vehicleLockWaitMean).toBe(0);
  });
  it('a descarga em série ocupa mais a doca do que a simultânea', () => {
    const mk = (ex: boolean) => {
      const sc = base();
      sc.outboundTrucksPerHour = new Array(24).fill(0);
      sc.vehicleExclusive = ex;
      return run(sc).k;
    };
    expect(mk(true).utilDockIn).toBeGreaterThan(mk(false).utilDockIn);
  });
  it('vale também para a expedição (carga do rack) e para a carga a partir do stage', () => {
    const rack = base();
    rack.inboundTrucksPerHour = new Array(24).fill(0);
    const a = run(rack);
    expect(a.k.palletsOutPerDay).toBeGreaterThan(100);
    expect(a.m.maxInside).toBe(1);
    const st = base();
    st.inboundTrucksPerHour = new Array(24).fill(0);
    st.picking.mode = 'pallet';
    st.ordersPerHour = new Array(24).fill(40);
    st.workers.count = 12;
    st.picking.loadFrom = 'stage';
    st.outboundTrucksPerHour = new Array(24).fill(1);
    const b = run(st);
    expect(b.k.palletsOutPerDay).toBeGreaterThan(5);
    expect(b.m.maxInside).toBe(1);
  });
  it('processos personalizados também respeitam a exclusividade', async () => {
    const { templateById } = await import('../src/model/process');
    const sc = base();
    sc.outboundTrucksPerHour = new Array(24).fill(0);
    sc.useCustomProcesses = true;
    sc.processes = [templateById('rec-direto')!.make(sc)];
    const { m, k } = run(sc);
    expect(k.palletsInPerDay).toBeGreaterThan(100);
    expect(m.maxInside).toBe(1);
  });
});

describe('expedição usa o comprimento do baú', () => {
  it('baú maior => caminhão de saída leva mais tempo (mesma carga)', () => {
    const mk = (len: number) => {
      const sc = base();
      sc.inboundTrucksPerHour = new Array(24).fill(0);
      sc.vehicleTypes = [{ ...presetVehicle('carreta'), share: 1, trailerLengthM: len, pallets: { mean: 20, sd: 0, max: 33 }, dockTurnover: { kind: 'constant', a: 60 } }];
      sc.arrivalsOut = { ...sc.arrivalsOut, mode: 'fixed', intervalMin: 120, delayProb: 0 };
      sc.outboundTrucksPerHour = new Array(24).fill(0);
      return run(sc).k.truckTurnaroundOut;
    };
    expect(mk(20)).toBeGreaterThan(mk(2));
    const sc = base();
    expect(sc.receiving.trailerDepth).toBe(true);
  });
});

describe('paleteira manual leva um operário do pool de operários', () => {
  const jackScenario = (workers: number) => {
    const sc = base();
    sc.vehicleTypes = []; // caminhão genérico: isola o efeito dos operários
    sc.outboundTrucksPerHour = new Array(24).fill(0);
    sc.workers.count = workers;
    sc.workers.availability = 1;
    sc.equipment[0].count = 3; // paleteira manual
    sc.equipment[0].availability = 1;
    sc.receiving.unloadWith = ['palletJack'];
    return sc;
  };
  it('os operários trabalham junto com a paleteira (sem separação alguma)', () => {
    const { m, k } = run(jackScenario(6));
    expect(m.eqPools.palletJack.items.some((a) => a.busyTime > 0)).toBe(true);
    expect(m.workers.items.some((a) => a.busyTime > 0)).toBe(true); // operários só são usados pelas paleteiras
    expect(k.utilWorker).toBeGreaterThan(0);
  });
  it('sem operários cadastrados a paleteira vai sozinha (não trava)', () => {
    const { m, k } = run(jackScenario(0));
    expect(m.eqPools.palletJack.items.some((a) => a.busyTime > 0)).toBe(true);
    expect(k.palletsInPerDay).toBeGreaterThan(50);
  });
  it('poucos operários limitam o trabalho das paleteiras', () => {
    const muitos = run(jackScenario(6)).k;
    const um = run(jackScenario(1)).k;
    // com 1 operário só uma paleteira trabalha por vez: o caminhão leva mais tempo no pátio (o total do dia pode ser igual)
    expect(um.truckTurnaroundIn).toBeGreaterThan(muitos.truckTurnaroundIn * 1.2);
  });
  it('transpaleteira elétrica e empilhadeira não consomem operários do pool', () => {
    const sc = base();
    sc.outboundTrucksPerHour = new Array(24).fill(0);
    sc.workers.count = 4;
    sc.equipment[1].count = 3;
    sc.receiving.unloadWith = ['palletTruck'];
    const { m } = run(sc);
    expect(m.eqPools.palletTruck.items.some((a) => a.busyTime > 0)).toBe(true);
    expect(m.workers.items.every((a) => a.busyTime === 0)).toBe(true);
  });
  it('a produtividade de picking não é distorcida pelos operários das paleteiras', () => {
    const mk = (jack: number) => {
      const sc = base();
      sc.picking.mode = 'pallet';
      sc.ordersPerHour = new Array(24).fill(40);
      sc.workers.count = 25;
      sc.workers.availability = 1;
      sc.equipment[0].count = jack;
      sc.receiving.unloadWith = ['forklift', 'palletJack'];
      return run(sc).k.boxesPerPickerHour;
    };
    const sem = mk(0);
    const com = mk(3);
    expect(Math.abs(com - sem) / sem).toBeLessThan(0.12);
  });
});

describe('planilha: regra de veículo', () => {
  it('ida e volta preserva a exclusividade', async () => {
    const { exportTemplate, importWorkbook } = await import('../src/io/excel');
    const sc = defaultScenario();
    sc.vehicleExclusive = false;
    const r = await importWorkbook(await exportTemplate(sc, layout));
    expect(r.warnings).toEqual([]);
    expect(r.scenario.vehicleExclusive).toBe(false);
    expect(defaultScenario().vehicleExclusive).toBe(true); // padrão: ligada
  });
});

describe('catálogo de tipos de veículo (recebimento e expedição)', () => {
  const types = async () => (await import('../src/model/traffic'));
  it('o cenário já traz tipos conhecidos: carreta, truque, toco, VUC e picape, com baú e capacidade', async () => {
    const sc = defaultScenario();
    expect(sc.vehicleTypes.map((v) => v.name)).toEqual(['Carreta', 'Truque', 'Toco', 'VUC (3/4)', 'Picape']);
    expect(sc.vehicleTypes.map((v) => v.capacityPallets)).toEqual([28, 16, 12, 6, 1]);
    // maior veículo, maior baú e maior tempo de docagem
    const len = sc.vehicleTypes.map((v) => v.trailerLengthM);
    expect([...len].sort((a, b) => b - a)).toEqual(len);
    const { distMean } = await import('../src/math/rng');
    const dock = sc.vehicleTypes.map((v) => distMean(v.dockTurnover));
    expect([...dock].sort((a, b) => b - a)).toEqual(dock);
    expect(sc.vehicleTypes.every((v) => v.pallets.mean <= v.capacityPallets && v.pallets.max === v.capacityPallets)).toBe(true);
    const { validate } = await import('../src/sim/world');
    expect(validate(layout, sc).filter((i) => /Veículo/.test(i.msg))).toEqual([]); // baús coerentes com as capacidades
  });
  it('o usuário cadastra novos tipos com tamanho e capacidade, e eles entram na simulação', async () => {
    const { presetVehicle } = await types();
    const sc = base();
    sc.outboundTrucksPerHour = new Array(24).fill(0);
    const bitrem = { ...presetVehicle('novo'), name: 'Bitrem', share: 1, shareIn: 1, shareOut: 0, capacityPallets: 40, trailerLengthM: 19.5, pallets: { mean: 36, sd: 2, max: 40 } };
    sc.vehicleTypes = [bitrem];
    const { k, m } = run(sc);
    expect(k.trucksInPerDay).toBeGreaterThan(3);
    expect(k.palletsInPerDay / k.trucksInPerDay).toBeGreaterThan(25); // veículos grandes
    void m;
  });
  it('a capacidade é o teto de paletes por veículo (mesmo com média maior)', async () => {
    const { presetVehicle } = await types();
    const sc = base();
    sc.outboundTrucksPerHour = new Array(24).fill(0);
    sc.vehicleTypes = [{ ...presetVehicle('toco'), share: 1, shareIn: 1, capacityPallets: 12, pallets: { mean: 30, sd: 0, max: 33 } }];
    const k = run(sc).k;
    expect(k.palletsInPerDay / k.trucksInPerDay).toBeLessThanOrEqual(12.6);
    expect(k.palletsInPerDay / k.trucksInPerDay).toBeGreaterThan(8); // paletes de veículos ainda em descarga no fim
  });
  it('participação separada: o recebimento recebe só carretas e a expedição só tocos', async () => {
    const sc = base();
    sc.days = 2;
    sc.vehicleTypes.forEach((v) => { v.shareIn = v.name === 'Carreta' ? 1 : 0; v.shareOut = v.name === 'Toco' ? 1 : 0; });
    sc.arrivalsOut = { ...sc.arrivalsOut, mode: 'fixed', intervalMin: 60, delayProb: 0 };
    sc.picking.full = { ordersPerHour: 0, palletsPerOrder: { mean: 3, sd: 0 }, abc: { a: 1, b: 0, c: 0 }, mode: 'direct', step1With: [] };
    const { k } = run(sc);
    expect(k.trucksInPerDay).toBeGreaterThan(3);
    const res = new SimModel(sc, layout, 5).runAll();
    const by = Object.fromEntries(res.vehicleStats.map((v) => [v.name, v]));
    expect(by['Carreta'].trucks).toBeGreaterThan(3);
    expect(by['Truque'].trucks + by['Toco'].trucks + by['VUC (3/4)'].trucks + by['Picape'].trucks).toBe(0);
    expect(by['Toco'].trucksOut).toBeGreaterThan(3);
    expect(by['Carreta'].trucksOut + by['Truque'].trucksOut + by['VUC (3/4)'].trucksOut + by['Picape'].trucksOut).toBe(0);
  });
  it('na expedição por etapas a carga é a capacidade do baú × ocupação', async () => {
    const { defaultExpedition } = await import('../src/model/expedition');
    const { presetVehicle } = await types();
    const sc = base();
    sc.inboundTrucksPerHour = new Array(24).fill(0);
    sc.checkers.count = 3;
    sc.workers.count = 12;
    sc.vehicleTypes = [{ ...presetVehicle('truque'), share: 1, shareOut: 1, capacityPallets: 16, pallets: { mean: 10, sd: 0, max: 16 } }];
    sc.picking.full = { ordersPerHour: 12, palletsPerOrder: { mean: 4, sd: 0 }, abc: { a: 0.7, b: 0.2, c: 0.1 }, mode: 'direct', step1With: [] };
    sc.arrivalsOut = { ...sc.arrivalsOut, mode: 'fixed', intervalMin: 90, delayProb: 0 };
    sc.outboundTrucksPerHour = new Array(24).fill(0);
    sc.expedition = { ...defaultExpedition(), mode: 'standard', loadOccupancy: 0.5 };
    const k = run(sc).k;
    expect(k.trucksOutPerDay).toBeGreaterThan(3);
    expect(k.palletsOutPerDay / k.trucksOutPerDay).toBeGreaterThanOrEqual(8); // 16 × 50%
    expect(k.palletsOutPerDay / k.trucksOutPerDay).toBeLessThan(8 * 1.3);
  });
  it('validações do catálogo: capacidade, coerência com o baú e participações', async () => {
    const { validate } = await import('../src/sim/world');
    const sc = defaultScenario();
    sc.vehicleTypes[1].capacityPallets = 0;
    expect(validate(layout, sc).some((i) => i.level === 'erro' && /ao menos 1 palete/.test(i.msg))).toBe(true);
    sc.vehicleTypes[1].capacityPallets = 40; // truque de 8,5 m não comporta 40
    expect(validate(layout, sc).some((i) => /comporta cerca de/.test(i.msg))).toBe(true);
    sc.vehicleTypes[1].capacityPallets = 16;
    sc.vehicleTypes[0].pallets.mean = 40;
    expect(validate(layout, sc).some((i) => /passa da capacidade/.test(i.msg))).toBe(true);
    sc.vehicleTypes.forEach((v) => { v.shareOut = 0; });
    expect(validate(layout, sc).some((i) => i.level === 'erro' && /participação na expedição/.test(i.msg))).toBe(true);
  });
  it('planilha: ida e volta preserva capacidade, baú e participações por sentido; aba vazia = sem tipos', async () => {
    const { exportTemplate, importWorkbook } = await import('../src/io/excel');
    const sc = defaultScenario();
    sc.vehicleTypes[0].capacityPallets = 30;
    sc.vehicleTypes[0].pallets.max = 30;
    sc.vehicleTypes[2].shareOut = 0.5;
    const r = await importWorkbook(await exportTemplate(sc, layout));
    expect(r.warnings).toEqual([]);
    expect(r.scenario.vehicleTypes.map((v) => [v.name, v.capacityPallets, v.trailerLengthM, v.shareIn, v.shareOut])).toEqual(sc.vehicleTypes.map((v) => [v.name, v.capacityPallets, v.trailerLengthM, v.shareIn, v.shareOut]));
    const none = defaultScenario();
    none.vehicleTypes = [];
    const r2 = await importWorkbook(await exportTemplate(none, layout));
    expect(r2.scenario.vehicleTypes).toEqual([]);
  });
});
