import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { SimModel } from '../src/sim/model';
import { SLOT_FREE, SLOT_OCCUPIED, SLOT_RESERVED, slotAddr, slotLabel } from '../src/sim/world';

describe('controle por posição', () => {
  it('mantém os contadores consistentes com o estado de cada posição', () => {
    const sc = defaultScenario();
    sc.days = 1;
    sc.warmupHours = 1;
    sc.checkers.count = 2;
    const m = new SimModel(sc, generateLayout(defaultLayoutParams()), 11);
    m.runAll();
    for (const r of m.world.racks) {
      let occ = 0;
      let res = 0;
      for (const s of r.slots) {
        if (s === SLOT_OCCUPIED) occ++;
        else if (s === SLOT_RESERVED) res++;
        else expect(s).toBe(SLOT_FREE);
      }
      expect(r.occupied).toBe(occ);
      expect(r.stock).toBe(occ + res);
      expect(r.stock).toBeLessThanOrEqual(r.capacity);
    }
  });
  it('estoque inicial ocupa posições distintas', () => {
    const sc = defaultScenario();
    sc.initialOccupancy = 0.5;
    const m = new SimModel(sc, generateLayout(defaultLayoutParams()), 3);
    for (const r of m.world.racks) expect(r.slots.filter((s) => s === SLOT_OCCUPIED).length).toBe(r.occupied);
    expect(m.world.racks.reduce((s, r) => s + r.occupied, 0) / m.world.totalCapacity).toBeGreaterThan(0.4);
  });
  it('gera endereços legíveis e reversíveis', () => {
    const m = new SimModel(defaultScenario(), generateLayout(defaultLayoutParams()), 1);
    const r = m.world.racks[0];
    expect(slotAddr(r, 0)).toEqual({ row: 0, bay: 0, level: 0 });
    expect(slotLabel(r, 4)).toMatch(/^[A-Z]+015$/); // rua + estante 01 + nível 5
    const last = slotAddr(r, r.slots.length - 1);
    expect(last).toEqual({ row: r.rows - 1, bay: r.bays - 1, level: r.levels - 1 });
  });
});
