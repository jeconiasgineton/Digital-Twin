import { describe, expect, it } from 'vitest';
import { analyzeCapacity } from '../src/analysis/capacity';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { parseDxf } from '../src/io/dxf';
import { runSweep } from '../src/sim/runner';
import { validate } from '../src/sim/world';

describe('análise de capacidade', () => {
  const sc = defaultScenario();
  const layout = generateLayout(defaultLayoutParams());
  it('produz dimensionamento coerente (necessário ≥ 1 e pico ≥ média)', () => {
    const cap = analyzeCapacity(sc, layout);
    for (const r of cap.rows) {
      expect(r.requiredPeak).toBeGreaterThanOrEqual(r.requiredAvg);
      expect(r.requiredAvg).toBeGreaterThanOrEqual(1);
    }
    expect(cap.storage.positions).toBeGreaterThan(1000);
    expect(cap.storage.expectedPallets).toBeCloseTo(cap.storage.dailyInPallets * sc.dwellDays, 5);
  });
  it('mais demanda aumenta o nº de empilhadeiras necessárias', () => {
    const a = analyzeCapacity(sc, layout).rows.find((r) => r.key === 'forklift')!;
    const sc2 = { ...sc, demandFactor: 2 };
    const b = analyzeCapacity(sc2, layout).rows.find((r) => r.key === 'forklift')!;
    expect(b.requiredPeak).toBeGreaterThan(a.requiredPeak);
  });
  it('valida layouts sem racks ou docas', () => {
    const issues = validate({ name: 'x', floor: { width: 10, depth: 10 }, elements: [] }, sc);
    expect(issues.some((i) => i.level === 'erro')).toBe(true);
  });
});

describe('varredura por simulação', () => {
  it('utilização cai com mais empilhadeiras (CRN)', () => {
    const sc = defaultScenario();
    sc.days = 2;
    sc.warmupHours = 4;
    sc.replications = 5;
    const layout = generateLayout({ ...defaultLayoutParams(), rackRows: 4, baysPerRow: 14 });
    const pts = runSweep(sc, layout, 'forklifts', [2, 5]);
    expect(pts[0].kpis.utilForklift.mean).toBeGreaterThan(pts[1].kpis.utilForklift.mean);
  });
});

describe('DXF', () => {
  it('converte LINE e LWPOLYLINE em paredes (mm → m)', () => {
    const dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '10000', '21', '0',
      '0', 'LWPOLYLINE', '90', '3', '70', '0', '10', '0', '20', '0', '10', '0', '20', '5000', '10', '8000', '20', '5000',
      '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const r = parseDxf(dxf);
    expect(r.unitsDetected).toBe('mm');
    expect(r.walls.length).toBe(3);
    expect(r.bounds.w).toBeCloseTo(10, 5);
    expect(r.bounds.d).toBeCloseTo(5, 5);
    expect(Math.max(...r.walls.map((w) => w.length))).toBeCloseTo(10, 3);
  });
});
