import { describe, expect, it } from 'vitest';
import { exportTemplate, importWorkbook } from '../src/io/excel';
import { blankLayout } from '../src/model/blank';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import type { Layout } from '../src/model/types';

describe('ida e volta do modelo em .xlsx (biblioteca)', () => {
  it('modelo em branco: a planilha volta com layout vazio (não herda o layout anterior)', async () => {
    const sc = defaultScenario();
    const buf = await exportTemplate(sc, blankLayout('Galpão X'));
    const r = await importWorkbook(buf);
    expect(r.layout).toBeDefined();
    expect(r.layout!.elements).toHaveLength(0);
    expect(r.layout!.floor.width).toBe(60);
    expect(r.layout!.floor.depth).toBe(40);
  });
  it('modelo com galpão gerado: elementos e parâmetros voltam iguais', async () => {
    const sc = defaultScenario();
    sc.forklifts.count = 7;
    const l: Layout = generateLayout(defaultLayoutParams());
    const r = await importWorkbook(await exportTemplate(sc, l));
    expect(r.scenario.forklifts.count).toBe(7);
    expect(r.layout!.elements.length).toBe(l.elements.length);
  });
  it('o nome do galpão vai junto com a planilha', async () => {
    const r = await importWorkbook(await exportTemplate(defaultScenario(), blankLayout('Centro de distribuição SP')));
    expect(r.layout!.name).toBe('Centro de distribuição SP');
  });
});
