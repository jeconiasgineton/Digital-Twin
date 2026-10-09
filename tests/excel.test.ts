import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { exportTemplate, importWorkbook } from '../src/io/excel';

describe('excel', () => {
  it('ida e volta (template -> import) preserva cenário e layout', async () => {
    const sc = defaultScenario();
    sc.forklifts.count = 7;
    sc.ops.unloadPallet = { kind: 'lognormal', a: 50, b: 12 };
    const layout = generateLayout(defaultLayoutParams());
    const buf = await exportTemplate(sc, layout);
    const r = await importWorkbook(buf);
    expect(r.warnings).toEqual([]);
    expect(r.scenario.forklifts.count).toBe(7);
    expect(r.scenario.ops.unloadPallet).toEqual({ kind: 'lognormal', a: 50, b: 12 });
    expect(r.scenario.ordersPerHour.reduce((a, b) => a + b, 0)).toBeCloseTo(900, 0);
    expect(r.layout!.elements.length).toBe(layout.elements.length);
    expect(r.scenario.skus.reduce((s, k) => s + k.share, 0)).toBeCloseTo(1, 6);
  });
});
