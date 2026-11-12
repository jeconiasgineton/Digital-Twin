import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { parseAddresses, planU, planZigzag, routeTravelSec, splitAmongPickers, type AisleInfo, type PickPos, type Stop } from '../src/model/picking';
import { SimModel } from '../src/sim/model';
import { buildWorld, slotLabel as slotLabelOf } from '../src/sim/world';
import type { Layout, Scenario } from '../src/model/types';

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const pos = (aisle: string, axis: number, side: 0 | 1, z = side === 0 ? 1 : -1): PickPos => ({ label: `${aisle}${axis}${side}`, aisle, axis, side, pt: { x: axis, z } });
const stop = (aisle: string, axis: number, side: 0 | 1, boxes = 1): Stop => ({ pos: pos(aisle, axis, side), boxes });
const aisles = new Map<string, AisleInfo>([
  ['A', { code: 'A', lo: { x: 0, z: 0 }, hi: { x: 100, z: 0 } }],
  ['B', { code: 'B', lo: { x: 0, z: 20 }, hi: { x: 100, z: 20 } }],
]);

describe('rotas de separação (funções puras)', () => {
  it('em U: um lado na ida (crescente) e o outro na volta (decrescente), ruas da mais próxima à mais distante', () => {
    const stops = [stop('B', 30, 0), stop('A', 70, 1), stop('A', 20, 0), stop('A', 50, 0), stop('A', 10, 1), stop('B', 80, 1)];
    const r = planU(stops, { x: 0, z: 0 }, aisles, dist);
    expect(r.map((s) => `${s.pos.aisle}${s.pos.axis}`)).toEqual(['A20', 'A50', 'A70', 'A10', 'B30', 'B80']);
    // rua A inteira (ida: lado 0 crescente; volta: lado 1 decrescente), depois a rua B
    const fromRight = planU(stops, { x: 100, z: 0 }, aisles, dist); // entra pela outra ponta da rua A
    expect(fromRight[0].pos.axis).toBe(50); // ida a partir do fim da rua, lado 0 em ordem decrescente de eixo
    expect(fromRight[1].pos.axis).toBe(20);
  });
  it('zigue-zague: sempre a parada mais próxima, trocando de lado quando convém', () => {
    const stops = [stop('A', 10, 0), stop('A', 12, 1), stop('A', 40, 0), stop('A', 41, 1)];
    const r = planZigzag(stops, { x: 0, z: 0 }, dist);
    expect(r.map((s) => s.pos.axis)).toEqual([10, 12, 40, 41]);
    expect(r.map((s) => s.pos.side)).toEqual([0, 1, 0, 1]); // alterna de lado a cada coleta
  });
  it('tempo de rota: vazio até a 1ª parada, carregado entre paradas e na volta ao stage', () => {
    const tt = (d: number, loaded: boolean) => d / (loaded ? 1 : 2);
    const order = [stop('A', 10, 0), stop('A', 30, 0)];
    const t = routeTravelSec(order, { x: 0, z: 0 }, { x: 0, z: 0 }, dist, tt);
    const d = (a: { x: number; z: number }, b: { x: number; z: number }) => dist(a, b);
    expect(t).toBeCloseTo(d({ x: 0, z: 0 }, order[0].pos.pt) / 2 + d(order[0].pos.pt, order[1].pos.pt) + d(order[1].pos.pt, { x: 0, z: 0 }), 9);
    expect(routeTravelSec([], { x: 0, z: 0 }, { x: 0, z: 0 }, dist, tt)).toBe(0);
  });
  it('vários separadores: divide por rua equilibrando as caixas; nunca mais separadores que ruas', () => {
    const stops = [stop('A', 1, 0, 30), stop('A', 2, 1, 30), stop('B', 1, 0, 40), stop('C', 1, 0, 10)];
    const parts = splitAmongPickers(stops, 3);
    expect(parts).toHaveLength(3);
    const boxes = parts.map((p) => p.reduce((n, s) => n + s.boxes, 0)).sort((a, b) => a - b);
    expect(boxes).toEqual([10, 40, 60]);
    expect(parts.every((p) => new Set(p.map((s) => s.pos.aisle)).size === 1)).toBe(true); // cada separador cobre ruas inteiras
    expect(splitAmongPickers(stops, 10)).toHaveLength(3); // só 3 ruas
    expect(splitAmongPickers(stops, 1)).toHaveLength(1);
    expect(splitAmongPickers(stops, 2).map((p) => p.reduce((n, s) => n + s.boxes, 0)).sort((a, b) => a - b)).toEqual([50, 60]); // 60 | 40+10
  });
  it('lista de endereços vazios é normalizada', () => {
    expect(parseAddresses('a015, B023;  c101  a015\nd1')).toEqual(['A015', 'B023', 'C101', 'D1']);
    expect(parseAddresses('')).toEqual([]);
  });
});

const layout: Layout = generateLayout(defaultLayoutParams());
const base = (): Scenario => {
  const sc = defaultScenario();
  sc.days = 1;
  sc.warmupHours = 0;
  sc.inboundTrucksPerHour = new Array(24).fill(0);
  sc.outboundTrucksPerHour = new Array(24).fill(0);
  sc.initialOccupancy = 0.5;
  sc.picking.mode = 'pallet';
  sc.workers.count = 12;
  sc.workers.availability = 1;
  return sc;
};
const run = (sc: Scenario, l: Layout = layout, seed = 5) => {
  const m = new SimModel(sc, l, seed);
  return { m, k: m.runAll().kpis };
};

describe('separação picking por palete na simulação', () => {
  it('o layout gerado tem stage de expedição separado do de recebimento', () => {
    const w = buildWorld(layout, defaultScenario());
    expect(w.stages).toHaveLength(1);
    expect(w.stagesOut).toHaveLength(1);
  });
  it('legado continua o padrão: sem paletes de separação', () => {
    const sc = base();
    sc.picking.mode = 'legacy';
    const { k } = run(sc);
    expect(k.pickPalletsPerDay).toBe(0);
    expect(k.ordersPerDay).toBeGreaterThan(100);
  });
  it('pedido por caixas e % A/B/C; limite do palete define as caixas por palete', () => {
    const sc = base();
    sc.picking.boxesPerOrder = { mean: 200, sd: 0 };
    sc.picking.palletLimit = { mean: 50, sd: 0 };
    sc.ordersPerHour = new Array(24).fill(10);
    const { k } = run(sc);
    expect(k.ordersPerDay).toBeGreaterThan(50);
    expect(k.cartonsPerDay / k.ordersPerDay).toBeCloseTo(200, 6);
    expect(k.boxesPerPallet).toBeGreaterThan(45);
    expect(k.boxesPerPallet).toBeLessThanOrEqual(50);
    expect(k.pickPalletsPerDay).toBeGreaterThan(k.ordersPerDay * 3.5); // ~4 paletes por pedido de 200 caixas
    expect(k.pickPalletTimeMean).toBeGreaterThan(5);
  });
  it('mede o tempo médio dos dois formatos de rota sobre os mesmos pedidos', () => {
    const { k } = run(base());
    expect(k.pickRouteTimeU).toBeGreaterThan(0);
    expect(k.pickRouteTimeZigzag).toBeGreaterThan(0);
    expect(k.pickRouteTimeU).not.toBeCloseTo(k.pickRouteTimeZigzag, 3); // os formatos dão tempos diferentes
  });
  it('a rota escolhida é a que se executa (tempo do palete acompanha o formato)', () => {
    const u = base();
    u.picking.route = 'u';
    const z = base();
    z.picking.route = 'zigzag';
    const ku = run(u).k;
    const kz = run(z).k;
    // o formato que a análise aponta como mais rápido tende a produzir paletes mais rápidos
    const uFaster = ku.pickRouteTimeU < ku.pickRouteTimeZigzag;
    expect(uFaster ? ku.pickPalletTimeMean <= kz.pickPalletTimeMean * 1.15 : kz.pickPalletTimeMean <= ku.pickPalletTimeMean * 1.15).toBe(true);
  });
  it('produtividade em caixas por hora por operário na faixa dos guias públicos (100–250)', () => {
    const sc = base();
    sc.workers.count = 20; // sem fila: mede o ritmo do operador
    const { k } = run(sc);
    expect(k.boxesPerPickerHour).toBeGreaterThan(40);
    expect(k.boxesPerPickerHour).toBeLessThan(400);
  });
  it('tempos por caixa maiores reduzem a produtividade (cálculo vem do tempo por caixa)', () => {
    const rapido = base();
    rapido.workers.count = 20;
    rapido.picking.pick = { kind: 'constant', a: 2 };
    rapido.picking.place = { kind: 'constant', a: 2 };
    const lento = base();
    lento.workers.count = 20;
    lento.picking.pick = { kind: 'constant', a: 12 };
    lento.picking.place = { kind: 'constant', a: 10 };
    expect(run(lento).k.boxesPerPickerHour).toBeLessThan(run(rapido).k.boxesPerPickerHour * 0.7);
  });
  it('furo de estoque por percentual: perde tempo e reduz a produtividade', () => {
    const off = base();
    off.workers.count = 20;
    const on = base();
    on.workers.count = 20;
    on.picking.stockout = { mode: 'pct', pct: 1, addresses: [], delay: { kind: 'constant', a: 300 } };
    const k1 = run(off).k;
    const k2 = run(on).k;
    expect(k1.stockoutPicksPerDay).toBe(0);
    expect(k2.stockoutPicksPerDay).toBeGreaterThan(100);
    expect(k2.stockoutTimeLostPerDay / k2.stockoutPicksPerDay).toBeCloseTo(5, 6); // 300 s por furo
    expect(k2.boxesPerPickerHour).toBeLessThan(k1.boxesPerPickerHour);
  });
  it('furo em posições definidas: só os endereços informados ficam vazios', () => {
    const sc = base();
    const probe = new SimModel(sc, layout, 5) as any;
    const all: string[] = probe.pickPos.flat().map((p: PickPos) => p.label);
    expect(all.length).toBeGreaterThan(100);
    expect(new Set(all).size).toBeLessThanOrEqual(all.length);
    sc.picking.stockout = { mode: 'positions', pct: 0, addresses: ['ZZZ999'], delay: { kind: 'constant', a: 300 } };
    expect(run(sc).k.stockoutPicksPerDay).toBe(0); // endereço que não existe
    sc.picking.stockout.addresses = all; // todos os endereços vazios
    const k = run(sc).k;
    // toda parada encontra o endereço vazio (as paradas de pedidos ainda em andamento no fim também contam)
    expect(k.stockoutPicksPerDay).toBeGreaterThanOrEqual(k.linesPerDay);
    expect(k.stockoutPicksPerDay).toBeLessThan(k.linesPerDay * 1.08);
  });
  it('endereços de picking seguem o formato rua + estante + nível 1 (ex.: A011)', () => {
    const m = new SimModel(base(), layout, 5) as any;
    const labels: string[] = m.pickPos.flat().map((p: PickPos) => p.label);
    expect(labels.every((l) => /^[A-Z]+\d{3}$/.test(l))).toBe(true);
    expect(labels.every((l) => l.endsWith('1'))).toBe(true); // nível mais baixo
  });
  it('mais de um separador no mesmo pedido reduz o tempo do pedido', () => {
    const um = base();
    um.picking.boxesPerOrder = { mean: 120, sd: 0 };
    um.ordersPerHour = new Array(24).fill(4);
    um.workers.count = 20;
    const tres = JSON.parse(JSON.stringify(um)) as Scenario;
    tres.picking.pickersPerOrder = 3;
    const k1 = run(um).k;
    const k3 = run(tres).k;
    expect(k3.orderCycleMean).toBeLessThan(k1.orderCycleMean * 0.8);
    expect(k3.cartonsPerDay).toBeCloseTo(k1.cartonsPerDay, 0); // mesma carga
  });
  it('é determinístico para a mesma semente', () => {
    expect(run(base(), layout, 9).k).toEqual(run(base(), layout, 9).k);
  });
});

describe('planilha, validações e interface de dados da separação', () => {
  it('ida e volta preserva modo, pedido, curvas, palete, rota, tempos, furos e stage de expedição', async () => {
    const { exportTemplate, importWorkbook } = await import('../src/io/excel');
    const sc = defaultScenario();
    sc.picking = {
      mode: 'pallet', boxesPerOrder: { mean: 100, sd: 15 }, abc: { a: 0.5, b: 0.3, c: 0.2 }, palletLimit: { mean: 80, sd: 5 }, area: { mode: 'custom', levels: 2, addresses: ['A011', 'B012'] },
      full: { ordersPerHour: 2, palletsPerOrder: { mean: 4, sd: 1 }, abc: { a: 0.6, b: 0.3, c: 0.1 }, mode: 'phased', step1With: ['palletJack'] }, loadFrom: 'stage', loadWith: ['forklift', 'palletTruck'], route: 'zigzag', pickersPerOrder: 3,
      scan: { kind: 'constant', a: 4 }, pick: { kind: 'triangular', a: 2, b: 6, c: 10 }, place: { kind: 'constant', a: 3 },
      stockout: { mode: 'positions', pct: 0.05, addresses: ['A015', 'B023'], delay: { kind: 'constant', a: 240 } },
    };
    const r = await importWorkbook(await exportTemplate(sc, layout));
    expect(r.warnings).toEqual([]);
    expect(r.scenario.picking).toEqual(sc.picking);
    expect(r.layout!.elements.filter((e) => e.type === 'stage' && e.stageKind === 'out')).toHaveLength(1);
  });
  it('validação da separação por palete', async () => {
    const { validate } = await import('../src/sim/world');
    const sc = defaultScenario();
    sc.picking.mode = 'pallet';
    expect(validate(layout, sc).filter((i) => /Separa/.test(i.msg))).toEqual([]);
    const l: Layout = { ...layout, elements: layout.elements.filter((e) => !(e.type === 'stage' && e.stageKind === 'out') && e.type !== 'aisle') };
    const msgs = validate(l, sc).map((i) => i.msg).join('|');
    expect(msgs).toMatch(/sem stage de expedição/);
    expect(msgs).toMatch(/sem ruas desenhadas/);
    sc.workers.count = 0;
    sc.picking.abc = { a: 0, b: 0, c: 0 };
    sc.picking.stockout = { ...sc.picking.stockout, mode: 'positions', addresses: [] };
    const m2 = validate(layout, sc);
    expect(m2.some((i) => i.level === 'erro' && /sem operários/.test(i.msg))).toBe(true);
    expect(m2.some((i) => i.level === 'erro' && /somam zero/.test(i.msg))).toBe(true);
    expect(m2.some((i) => /nenhum endereço foi informado/.test(i.msg))).toBe(true);
  });
});

describe('área de picking', () => {
  const positions = (sc: Scenario) => (new SimModel(sc, layout, 5) as any).pickPos as PickPos[][];
  const nLevel = (p: PickPos) => Number(p.label.slice(-1));
  it('padrão: todos os endereços próximos ao chão (nível 1) de todos os racks', () => {
    const sc = base();
    const all = positions(sc).flat();
    const w = buildWorld(layout, sc);
    const uniq = new Set(all.map((p) => p.label));
    expect(sc.picking.area.mode).toBe('floor');
    expect(uniq.size).toBe(w.racks.reduce((n, r) => n + r.rows * r.bays, 0)); // uma posição por vão e fileira
    expect(all.every((p) => nLevel(p) === 1)).toBe(true);
  });
  it('níveis a partir do chão: 2 níveis dobram as posições', () => {
    const um = base();
    const dois = base();
    dois.picking.area.levels = 2;
    const a = new Set(positions(um).flat().map((p) => p.label)).size;
    const b = new Set(positions(dois).flat().map((p) => p.label)).size;
    expect(b).toBe(a * 2);
    expect(positions(dois).flat().every((p) => nLevel(p) <= 2)).toBe(true);
  });
  it('só faces de picking: restringe aos racks marcados', () => {
    const sc = base();
    sc.picking.area.mode = 'faces';
    const w = buildWorld(layout, sc);
    const flagged = w.racks.filter((r) => r.pickFace);
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.length).toBeLessThan(w.racks.length);
    const n = new Set(positions(sc).flat().map((p) => p.label)).size;
    expect(n).toBe(flagged.reduce((s, r) => s + r.rows * r.bays, 0));
  });
  it('posições específicas: só os endereços informados (em qualquer nível); os inexistentes são contados', () => {
    const sc = base();
    const w = buildWorld(layout, sc);
    const r = w.racks[0];
    const ok = [slotLabelOf(r, 0), slotLabelOf(r, 3)]; // vão 1 nível 1; nível 4 do vão 1
    sc.picking.area = { mode: 'custom', levels: 1, addresses: [...ok, 'ZZ999'] };
    const m = new SimModel(sc, layout, 5) as any;
    const labels = new Set((m.pickPos as PickPos[][]).flat().map((p) => p.label));
    expect([...labels].sort()).toEqual([...ok].sort());
    expect(m.unmatchedPickAddresses).toBe(1);
  });
  it('sem nenhum endereço válido cai para o chão de todos os racks (não trava)', () => {
    const sc = base();
    sc.picking.area = { mode: 'custom', levels: 1, addresses: ['NADA'] };
    const { k } = run(sc);
    expect(k.pickPalletsPerDay).toBeGreaterThan(0);
  });
  it('a coleta acontece só dentro da área definida', () => {
    const sc = base();
    const w = buildWorld(layout, sc);
    const r = w.racks[0];
    sc.picking.area = { mode: 'custom', levels: 1, addresses: [slotLabelOf(r, 0)] };
    sc.picking.stockout = { mode: 'positions', pct: 0, addresses: [slotLabelOf(r, 0)], delay: { kind: 'constant', a: 60 } };
    const k = run(sc).k;
    expect(k.stockoutPicksPerDay).toBeGreaterThan(0); // todas as paradas são nesse único endereço, que está vazio
    expect(k.stockoutPicksPerDay).toBeGreaterThanOrEqual(k.linesPerDay);
  });
  it('as curvas A, B e C dividem a área por proximidade (20/30/50%)', () => {
    const p = positions(base());
    const n = p.flat().length;
    expect(p[0].length).toBeCloseTo(n * 0.2, -1);
    expect(p[1].length).toBeCloseTo(n * 0.3, -1);
    expect(p[2].length).toBeCloseTo(n * 0.5, -1);
  });
});

describe('palete full e carga do caminhão a partir do stage', () => {
  const withFull = (extra?: (sc: Scenario) => void): Scenario => {
    const sc = base();
    sc.picking.mode = 'legacy';
    sc.ordersPerHour = new Array(24).fill(0);
    sc.picking.full = { ordersPerHour: 4, palletsPerOrder: { mean: 3, sd: 0 }, abc: { a: 0.7, b: 0.2, c: 0.1 }, mode: 'direct', step1With: ['palletTruck', 'palletJack', 'amr'] };
    extra?.(sc);
    return sc;
  };
  it('Store: quem pede espera até haver item, na ordem de chegada', async () => {
    const { Sim, Store } = await import('../src/sim/engine');
    const sim = new Sim();
    const st = new Store<number>(sim);
    const got: number[] = [];
    const taker = function* () {
      const r = st.take();
      yield r.signal;
      got.push(r.res.item!);
    };
    sim.spawn(taker());
    sim.spawn(taker());
    sim.schedule(10, () => st.put(1));
    sim.schedule(20, () => st.put(2));
    st.put(0); // já havia um item antes de alguém pedir? não: pedidos ainda não rodaram
    sim.runUntil(100);
    expect(got).toEqual([0, 1]);
    expect(st.size).toBe(1); // o item 2 sobrou
  });
  it('palete full direto: pedidos por quantidade de paletes chegam ao stage', () => {
    const { k } = run(withFull());
    expect(k.fullOrdersPerDay).toBeGreaterThan(30);
    expect(k.fullPalletsPerDay / k.fullOrdersPerDay).toBeGreaterThan(2.7);
    expect(k.fullPalletsPerDay / k.fullOrdersPerDay).toBeLessThanOrEqual(3.05); // 3 paletes por pedido (os últimos em andamento)
    expect(k.fullOrderTimeMean).toBeGreaterThan(0.3);
  });
  it('sem estoque: palete full pedido não é separado e é contado', () => {
    const { k } = run(withFull((sc) => { sc.initialOccupancy = 0; }));
    expect(k.fullNoStockPerDay).toBeGreaterThan(50);
    expect(k.fullPalletsPerDay).toBe(0);
  });
  it('faseado: a empilhadeira baixa na rua e a transpaleteira leva ao stage', () => {
    const { m, k } = run(withFull((sc) => {
      sc.picking.full.mode = 'phased';
      sc.equipment[1].count = 3;
    }));
    expect(k.fullPalletsPerDay).toBeGreaterThan(30);
    expect(k.utilMover).toBeGreaterThan(0);
    expect(k.transitOccupancyMax).toBeGreaterThan(0);
    expect(m.eqPools.palletTruck.items.some((a) => a.busyTime > 0)).toBe(true);
  });
  it('faseado sem endereços transitórios: cai para a direta, sem travar', () => {
    const l: Layout = { ...layout, elements: layout.elements.filter((e) => e.type !== 'transit') };
    const { k } = run(withFull((sc) => { sc.picking.full.mode = 'phased'; sc.equipment[1].count = 2; }), l);
    expect(k.fullPalletsPerDay).toBeGreaterThan(30);
  });
  it('caminhão carrega do stage: só sai o que foi separado e ele espera os paletes', () => {
    const sc = withFull((s) => {
      s.picking.loadFrom = 'stage';
      s.outboundTrucksPerHour = new Array(24).fill(2); // 2 caminhões/h de ~16 paletes: bem mais que o separado
    });
    const { k } = run(sc);
    expect(k.palletsOutPerDay).toBeGreaterThan(20);
    expect(k.palletsOutPerDay).toBeLessThanOrEqual(k.fullPalletsPerDay + 1); // nunca carrega mais do que foi separado
    expect(k.expeditionWaitMean).toBeGreaterThan(1); // os caminhões esperam paletes
    expect(k.stageOutMax).toBeGreaterThan(0);
  });
  it('picking por palete também abastece o stage de expedição', () => {
    const sc = base();
    sc.picking.loadFrom = 'stage';
    sc.outboundTrucksPerHour = new Array(24).fill(1);
    const { k } = run(sc);
    expect(k.pickPalletsPerDay).toBeGreaterThan(100);
    expect(k.palletsOutPerDay).toBeGreaterThan(5);
    expect(k.palletsOutPerDay).toBeLessThanOrEqual(k.pickPalletsPerDay + 1);
  });
  it('capacidade do stage de expedição limita os paletes esperando (e freia a separação)', () => {
    const cap = (n: number) => {
      const l: Layout = JSON.parse(JSON.stringify(layout));
      l.elements.find((e) => e.type === 'stage' && e.stageKind === 'out')!.capacity = n;
      const sc = withFull((s) => { s.picking.loadFrom = 'stage'; s.outboundTrucksPerHour = new Array(24).fill(0); });
      return run(sc, l).k;
    };
    const apertado = cap(3);
    const folgado = cap(500);
    expect(apertado.stageOutMax).toBeLessThanOrEqual(3);
    expect(folgado.stageOutMax).toBeGreaterThan(apertado.stageOutMax);
    expect(apertado.fullPalletsPerDay).toBeLessThan(folgado.fullPalletsPerDay);
  });
  it('o padrão (carga do rack) segue igual e não usa o stage', () => {
    const { k } = run(withFull());
    expect(k.stageOutMax).toBe(0);
    expect(k.expeditionWaitMean).toBe(0);
  });
  it('validações do palete full e da carga a partir do stage', async () => {
    const { validate } = await import('../src/sim/world');
    const sc = defaultScenario();
    sc.picking.loadFrom = 'stage';
    expect(validate(layout, sc).some((i) => i.level === 'erro' && /sem fonte de paletes/.test(i.msg))).toBe(true);
    sc.picking.full.ordersPerHour = 2;
    expect(validate(layout, sc).some((i) => /sem fonte de paletes/.test(i.msg))).toBe(false);
    sc.picking.full.mode = 'phased';
    expect(validate(layout, sc).some((i) => /sem equipamento de etapa 2/.test(i.msg))).toBe(true);
    const l: Layout = { ...layout, elements: layout.elements.filter((e) => !(e.type === 'stage' && e.stageKind === 'out')) };
    expect(validate(l, sc).some((i) => /sem stage de expedição/.test(i.msg))).toBe(true);
    sc.picking.loadWith = [];
    expect(validate(layout, sc).some((i) => i.level === 'erro' && /nenhum equipamento permitido/.test(i.msg))).toBe(true);
  });
});
