import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { aisleCode, aisleOf, areaCapacity, nextAisleCode, PALLET_FLOOR_M2 } from '../src/model/areas';
import { buildWorld, validate } from '../src/sim/world';
import { exportTemplate, importWorkbook } from '../src/io/excel';
import type { LayoutElement } from '../src/model/types';

const el = (p: Partial<LayoutElement>): LayoutElement => ({ id: 'x', type: 'stage', name: 'x', x: 0, z: 0, rot: 0, length: 10, width: 5, ...p });

describe('áreas de layout', () => {
  it('capacidade: valor do usuário ou calculada pela área', () => {
    expect(areaCapacity(el({}))).toBe(Math.floor(50 / PALLET_FLOOR_M2));
    expect(areaCapacity(el({ capacity: 7 }))).toBe(7);
    expect(areaCapacity(el({ type: 'charger', capacity: undefined }))).toBe(1);
  });
  it('códigos de rua: A..Z, AA…', () => {
    expect([0, 1, 25, 26, 27].map(aisleCode)).toEqual(['A', 'B', 'Z', 'AA', 'AB']);
    expect(nextAisleCode([el({ type: 'aisle', aisle: 'A' }), el({ type: 'aisle', aisle: 'B' })])).toBe('C');
  });
  it('endereço transitório herda a rua que o contém', () => {
    const a = el({ type: 'aisle', aisle: 'B', x: 20, z: 20, length: 30, width: 4 });
    const t = el({ type: 'transit', x: 25, z: 21, length: 4, width: 2 });
    expect(aisleOf(t, [a])).toBe('B');
    expect(aisleOf({ ...t, aisle: 'c' }, [a])).toBe('C');
  });
  it('layout gerado traz ruas, transitórios, stage, triagens e carga; mundo os expõe', () => {
    const l = generateLayout(defaultLayoutParams());
    const w = buildWorld(l, defaultScenario());
    expect(w.aisles.length).toBe(defaultLayoutParams().rackRows + 1);
    expect(w.transits.length).toBe(w.aisles.length);
    expect(w.transitsByAisle.get('A')?.length).toBe(1);
    expect(w.stages.length).toBe(1);
    expect(w.triages.map((t) => t.el.priority)).toEqual([1, 2]);
    expect(w.chargers[0].capacity).toBe(1);
    expect(validate(l, defaultScenario()).filter((i) => /transit|rua/i.test(i.msg))).toEqual([]);
  });
  it('validação avisa transitório órfão', () => {
    const l = generateLayout(defaultLayoutParams());
    l.elements = l.elements.filter((e) => e.type !== 'aisle');
    l.elements.forEach((e) => e.type === 'transit' && (e.aisle = undefined));
    expect(validate(l, defaultScenario()).some((i) => /não pertence a nenhuma rua/.test(i.msg))).toBe(true);
  });
  it('ida e volta no Excel preserva capacidade, rua e prioridade', async () => {
    const l = generateLayout(defaultLayoutParams());
    l.elements.find((e) => e.type === 'stage')!.capacity = 123;
    l.elements.find((e) => e.type === 'triage' && e.priority === 2)!.capacity = 9;
    const r = await importWorkbook(await exportTemplate(defaultScenario(), l));
    expect(r.warnings).toEqual([]);
    const els = r.layout!.elements;
    expect(els.find((e) => e.type === 'stage')!.capacity).toBe(123);
    expect(els.find((e) => e.type === 'triage' && e.priority === 2)!.capacity).toBe(9);
    expect(els.filter((e) => e.type === 'aisle').map((e) => e.aisle)[0]).toBe('A');
    expect(els.filter((e) => e.type === 'transit').every((e) => !!e.aisle)).toBe(true);
    expect(els.length).toBe(l.elements.length);
  });
});
