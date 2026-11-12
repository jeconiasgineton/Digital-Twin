import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { SimModel } from '../src/sim/model';
import { buildWorld, slotLabel, slotSide, validate } from '../src/sim/world';
import type { Layout, Scenario } from '../src/model/types';

const mkLayout = (): Layout => generateLayout(defaultLayoutParams());
const base = (): Scenario => {
  const sc = defaultScenario();
  sc.days = 1;
  sc.warmupHours = 0;
  sc.ordersPerHour = new Array(24).fill(0);
  sc.outboundTrucksPerHour = new Array(24).fill(0);
  sc.initialOccupancy = 0.3;
  sc.checkers.count = 0;
  sc.forklifts.availability = 1;
  sc.receiving.damagePalletPct = 0;
  return sc;
};
const run = (sc: Scenario, layout = mkLayout(), seed = 5) => {
  const m = new SimModel(sc, layout, seed);
  return { m, k: m.runAll().kpis };
};
const phased = (): Scenario => {
  const sc = base();
  sc.storage.mode = 'phased';
  sc.equipment[1].count = 3; // transpaleteira elétrica
  return sc;
};

describe('endereços com rua', () => {
  it('endereço = rua + estante + nível (ex.: A015); racks duplos usam uma rua por fileira', () => {
    const w = buildWorld(mkLayout(), defaultScenario());
    const r = w.racks[0];
    expect(r.rows).toBe(2);
    const front = slotLabel(r, 4); // fileira 0, vão 1, nível 5
    const back = slotLabel(r, r.bays * r.levels + 4); // fileira 1
    expect(front).toMatch(/^[A-Z]+015$/);
    expect(back).toMatch(/^[A-Z]+015$/);
    expect(front[0]).not.toBe(back[0]);
    expect(slotSide(r, 4)).toBe(0);
    expect(slotSide(r, r.bays * r.levels + 4)).toBe(1);
    expect(front[0]).toBe(r.faceAisle[0]);
    expect(back[0]).toBe(r.faceAisle[1]);
  });
  it('todos os endereços do galpão são únicos (estantes numeradas em sequência ao longo da rua)', () => {
    const w = buildWorld(mkLayout(), defaultScenario());
    const seen = new Set<string>();
    let n = 0;
    for (const r of w.racks)
      for (let i = 0; i < r.slots.length; i++) {
        seen.add(slotLabel(r, i));
        n++;
      }
    expect(n).toBe(w.totalCapacity);
    expect(seen.size).toBe(n);
    // as estantes de uma rua formam uma sequência contínua começando em 1
    const a = w.racks.find((r) => r.el.name === 'Rack 1A')!;
    const b = w.racks.find((r) => r.el.name === 'Rack 1B')!;
    expect(a.faceAisle[0]).toBe(b.faceAisle[0]);
    expect(new Set([a.estanteBase[0], b.estanteBase[0]]).size).toBe(2);
  });
  it('rua manual na face tem prioridade sobre a automática', () => {
    const l = mkLayout();
    const rack = l.elements.find((e) => e.type === 'rack')!;
    rack.aisleFront = 'z';
    const w = buildWorld(l, defaultScenario());
    expect(w.racks[0].faceAisle[0]).toBe('Z');
    expect(slotLabel(w.racks[0], 4)).toMatch(/^Z\d{3}$/);
  });
});

describe('armazenagem direta × faseada', () => {
  it('direta: sem etapa 1 e sem uso dos endereços transitórios', () => {
    const { k } = run(base());
    expect(k.phasedShare).toBe(0);
    expect(k.transitOccupancyMax).toBe(0);
    expect(k.palletsInPerDay).toBeGreaterThan(100);
  });
  it('faseada: etapa 1 pelo equipamento sem elevação e etapa 2 pela empilhadeira', () => {
    const { m, k } = run(phased());
    expect(k.phasedShare).toBeCloseTo(1, 9);
    expect(k.utilMover).toBeGreaterThan(0);
    expect(k.transitOccupancyMax).toBeGreaterThan(0);
    const cap = m.world.transits.reduce((s, t) => s + t.capacity, 0);
    expect(k.transitOccupancyMax).toBeLessThanOrEqual(cap);
    expect(k.palletsInPerDay).toBeGreaterThan(100);
    // os paletes terminam em posições ocupadas, sem vazamento de espaço nos transitórios
    for (const p of m.transitPoolsForTest()) expect(p.busyCount).toBeLessThanOrEqual(p.size);
  });
  it('faseada com conferência e avarias funciona junto', () => {
    const sc = phased();
    sc.checkers.count = 3;
    sc.receiving.damagePalletPct = 0.1;
    const { k } = run(sc);
    expect(k.phasedShare).toBeGreaterThan(0.8);
    expect(k.damagedPalletsPerDay).toBeGreaterThan(0);
  });
  it('rua cheia: a etapa 1 espera liberar espaço', () => {
    const apertado = phased();
    const folgado = phased();
    const l = mkLayout();
    l.elements.filter((e) => e.type === 'transit').forEach((t) => (t.capacity = 1));
    const kA = run(apertado, l).k;
    const kF = run(folgado, mkLayout()).k;
    expect(kA.transitWaitMean).toBeGreaterThan(kF.transitWaitMean);
    expect(kA.transitOccupancyMax).toBeLessThan(kF.transitOccupancyMax);
  });
  it('sem equipamento de etapa 1, a empilhadeira faz as duas etapas', () => {
    const sc = base();
    sc.storage.mode = 'phased';
    const { k } = run(sc);
    expect(k.phasedShare).toBeCloseTo(1, 9);
    expect(k.utilMover).toBe(0);
    expect(k.palletsInPerDay).toBeGreaterThan(100);
  });
  it('só os equipamentos permitidos fazem a etapa 1', () => {
    const sc = phased();
    sc.equipment[0].count = 2; // paleteira manual
    sc.storage.step1With = ['palletJack'];
    const { m } = run(sc);
    expect(m.eqPools.palletJack.items.some((a) => a.busyTime > 0)).toBe(true);
    expect(m.eqPools.palletTruck.items.every((a) => a.busyTime === 0)).toBe(true);
  });
  it('rua sem endereço transitório: leva direto ao destino, sem travar', () => {
    const l = mkLayout();
    l.elements = l.elements.filter((e) => e.type !== 'transit');
    const { k } = run(phased(), l);
    expect(k.palletsInPerDay).toBeGreaterThan(100);
    expect(k.transitOccupancyMax).toBe(0);
  });
});

describe('validações da armazenagem', () => {
  it('faseada avisa sem equipamento de etapa 1, sem ruas e rua sem transitório', () => {
    const sc = base();
    sc.storage.mode = 'phased';
    expect(validate(mkLayout(), sc).some((i) => /sem equipamento de etapa 1/.test(i.msg))).toBe(true);
    const l = mkLayout();
    const t = l.elements.find((e) => e.type === 'transit')!;
    l.elements = l.elements.filter((e) => e !== t);
    expect(validate(l, sc).some((i) => /não tem endereço transitório/.test(i.msg))).toBe(true);
    l.elements = l.elements.filter((e) => e.type !== 'aisle' && e.type !== 'transit');
    expect(validate(l, sc).some((i) => /sem ruas no layout/.test(i.msg))).toBe(true);
    sc.storage.mode = 'direct';
    expect(validate(mkLayout(), sc).some((i) => /faseada/.test(i.msg))).toBe(false);
  });
});

describe('planilha: armazenagem', () => {
  it('ida e volta preserva modo, equipamentos da etapa 1 e ruas manuais dos racks', async () => {
    const { exportTemplate, importWorkbook } = await import('../src/io/excel');
    const sc = base();
    sc.storage = { mode: 'phased', step1With: ['palletJack', 'amr'] };
    const l = mkLayout();
    const rack = l.elements.find((e) => e.type === 'rack')!;
    rack.aisleFront = 'X';
    rack.aisleBack = 'Y';
    const r = await importWorkbook(await exportTemplate(sc, l));
    expect(r.warnings).toEqual([]);
    expect(r.scenario.storage).toEqual(sc.storage);
    const rr = r.layout!.elements.filter((e) => e.type === 'rack');
    expect(rr.find((e) => e.name === rack.name)).toMatchObject({ aisleFront: 'X', aisleBack: 'Y' });
  });
});
