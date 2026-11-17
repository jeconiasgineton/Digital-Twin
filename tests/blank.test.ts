import { describe, expect, it } from 'vitest';
import { analyzeCapacity } from '../src/analysis/capacity';
import { defaultScenario } from '../src/model/defaults';
import type { Layout } from '../src/model/types';
import { SimModel } from '../src/sim/model';
import { validate, buildWorld } from '../src/sim/world';

/** modelo em branco: piso vazio, sem racks, ruas, docas nem equipamentos desenhados */
const blank = (): Layout => ({ name: 'Novo galpão', floor: { width: 60, depth: 40 }, elements: [] });

describe('modelo em branco (começar do zero)', () => {
  it('o mundo, a validação e a análise analítica funcionam sem nenhum elemento', () => {
    const sc = defaultScenario();
    expect(() => buildWorld(blank(), sc)).not.toThrow();
    expect(() => validate(blank(), sc)).not.toThrow();
    expect(() => analyzeCapacity(sc, blank())).not.toThrow();
  });
  it('a simulação roda sem travar, mesmo com pedidos e chegadas configurados', () => {
    const sc = defaultScenario();
    sc.days = 1;
    sc.warmupHours = 0;
    const k = new SimModel(sc, blank(), 3).runAll().kpis;
    expect(Number.isFinite(k.palletsInPerDay)).toBe(true);
    expect(Number.isFinite(k.palletsOutPerDay)).toBe(true);
  });
  it('a simulação também roda no modo de separação por palete sem racks', () => {
    const sc = defaultScenario();
    sc.days = 1;
    sc.warmupHours = 0;
    sc.picking.mode = 'pallet';
    const k = new SimModel(sc, blank(), 3).runAll().kpis;
    expect(Number.isFinite(k.pickPalletsPerDay)).toBe(true);
  });
});
