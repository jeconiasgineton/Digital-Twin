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
    expect(um.palletsInPerDay).toBeLessThan(muitos.palletsInPerDay);
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
