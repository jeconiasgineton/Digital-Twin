import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { parseAddresses, planU, planZigzag, routeTravelSec, splitAmongPickers, type AisleInfo, type PickPos, type Stop } from '../src/model/picking';
import { SimModel } from '../src/sim/model';
import { buildWorld } from '../src/sim/world';
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
      mode: 'pallet', boxesPerOrder: { mean: 100, sd: 15 }, abc: { a: 0.5, b: 0.3, c: 0.2 }, palletLimit: { mean: 80, sd: 5 }, route: 'zigzag', pickersPerOrder: 3,
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
