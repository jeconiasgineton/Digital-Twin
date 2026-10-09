import type { Dist, DistKind, FleetSpec, Scenario } from '../model/types';
import { hourlyProfile } from '../model/defaults';
import { exportTemplate, importWorkbook } from '../io/excel';
import type { AppCtx } from './ctx';
import { download, fmt, h, numField, pickFile, selField, toast } from './dom';
import { seriesChart } from './charts';

function section(title: string, body: (Element | null)[], open = true) {
  return h('details', { open }, h('summary', null, title), h('div', { class: 'body' }, body));
}

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

export async function loadExcelFile(ctx: AppCtx, file: File) {
  try {
    const r = await importWorkbook(await file.arrayBuffer());
    ctx.loadScenario(r.scenario);
    if (r.layout) ctx.loadLayout(r.layout, true);
    toast(`Planilha "${file.name}" importada.\nAbas lidas: ${r.found.join(', ') || '—'}` + (r.warnings.length ? `\n\nAvisos:\n• ${r.warnings.join('\n• ')}` : ''), r.warnings.length ? 'warn' : 'ok', 9000);
    ctx.openTab('sim');
  } catch (e) {
    console.error(e);
    toast('Falha ao ler a planilha: ' + (e as Error).message, 'err');
  }
}

export async function pickExcel(ctx: AppCtx) {
  const f = await pickFile('.xlsx,.xlsm');
  if (f) await loadExcelFile(ctx, f);
}

export async function downloadTemplate(ctx: AppCtx) {
  const buf = await exportTemplate(ctx.scenario, ctx.layout);
  download('digital-twin-dimensionamento.xlsx', buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

const DIST_KINDS: [DistKind, string][] = [['constant', 'Constante'], ['triangular', 'Triangular'], ['normal', 'Normal'], ['lognormal', 'Lognormal'], ['exponential', 'Exponencial'], ['uniform', 'Uniforme']];
const DIST_LABELS: Record<DistKind, [string, string, string]> = {
  constant: ['valor', '', ''], triangular: ['mín', 'moda', 'máx'], normal: ['média', 'desvio', ''], lognormal: ['média', 'desvio', ''], exponential: ['média', '', ''], uniform: ['mín', 'máx', ''],
};

function distRow(ctx: AppCtx, label: string, get: () => Dist, set: (d: Dist) => void) {
  const d = get();
  const tr = h('tr');
  const sel = h('select', null, DIST_KINDS.map(([k, n]) => h('option', { value: k, selected: k === d.kind }, n)));
  sel.addEventListener('change', () => {
    const k = sel.value as DistKind;
    const m = d.kind === 'triangular' ? (d.a + (d.b ?? d.a) + (d.c ?? d.a)) / 3 : d.a;
    const nd: Dist = k === 'triangular' ? { kind: k, a: m * 0.7, b: m, c: m * 1.5 } : k === 'uniform' ? { kind: k, a: m * 0.7, b: m * 1.3 } : k === 'normal' || k === 'lognormal' ? { kind: k, a: m, b: m * 0.25 } : { kind: k, a: m };
    set(nd);
    ctx.rerender();
  });
  const mkIn = (idx: 'a' | 'b' | 'c', ph: string) => {
    if (!ph) return h('td', null, '');
    const i = h('input', { type: 'number', step: 'any', value: String(+(d[idx] ?? 0).toFixed(3)), title: ph });
    i.addEventListener('change', () => {
      const v = parseFloat(i.value);
      if (Number.isFinite(v)) {
        const nd = { ...get(), [idx]: v } as Dist;
        set(nd);
      }
    });
    return h('td', null, i);
  };
  const [l1, l2, l3] = DIST_LABELS[d.kind];
  tr.append(h('td', null, label), h('td', null, sel), mkIn('a', l1), mkIn('b', l2), mkIn('c', l3));
  return tr;
}

function fleetRows(ctx: AppCtx, name: string, f: FleetSpec, vUnit = 'm/s') {
  const n = (get: () => number, set: (v: number) => void, o: { step?: number; min?: number; max?: number } = {}) => {
    const i = h('input', { type: 'number', value: String(get()), step: o.step ?? 'any', min: o.min, max: o.max });
    i.addEventListener('change', () => {
      let v = parseFloat(i.value);
      if (!Number.isFinite(v)) v = get();
      if (o.min !== undefined) v = Math.max(o.min, v);
      if (o.max !== undefined) v = Math.min(o.max, v);
      set(v);
      i.value = String(v);
      ctx.scenarioChanged();
    });
    return h('td', null, i);
  };
  void vUnit;
  return h('tr', null,
    h('td', null, name),
    n(() => f.count, (v) => (f.count = Math.round(v)), { step: 1, min: 0 }),
    n(() => f.speedEmpty, (v) => (f.speedEmpty = v), { step: 0.1, min: 0.1 }),
    n(() => f.speedLoaded, (v) => (f.speedLoaded = v), { step: 0.1, min: 0.1 }),
    n(() => f.availability * 100, (v) => (f.availability = Math.min(1, v / 100)), { step: 1, min: 5, max: 100 }),
    n(() => f.costPerHour, (v) => (f.costPerHour = v), { step: 1, min: 0 }),
  );
}

export function renderDataPanel(ctx: AppCtx): HTMLElement {
  const sc = ctx.scenario;
  const ch = () => ctx.scenarioChanged();
  const root = h('div');

  // demanda
  const demandTable = () => {
    const rows = [];
    for (let k = 0; k < sc.shiftHours; k++) {
      const hr = (sc.startHour + k) % 24;
      const cell = (arr: number[]) => {
        const i = h('input', { type: 'number', step: 'any', min: 0, value: String(+arr[hr].toFixed(2)) });
        i.addEventListener('change', () => {
          arr[hr] = Math.max(0, parseFloat(i.value) || 0);
          ch();
          ctx.rerender();
        });
        return h('td', null, i);
      };
      rows.push(h('tr', null, h('td', null, `${String(hr).padStart(2, '0')}h`), cell(sc.inboundTrucksPerHour), cell(sc.outboundTrucksPerHour), cell(sc.ordersPerHour)));
    }
    return h('div', { style: { maxHeight: '260px', overflow: 'auto' } }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Hora'), h('th', null, 'Cam. entrada/h'), h('th', null, 'Cam. saída/h'), h('th', null, 'Pedidos/h'))), h('tbody', null, rows)));
  };
  const shape = { v: 'peaks' as 'peaks' | 'flat' };
  const totals = () => ({ i: sum(sc.inboundTrucksPerHour), o: sum(sc.outboundTrucksPerHour), p: sum(sc.ordersPerHour) });
  const t0 = totals();
  const tot = { i: t0.i, o: t0.o, p: t0.p };
  const apply = () => {
    sc.inboundTrucksPerHour = hourlyProfile(tot.i, sc.startHour, sc.shiftHours, shape.v);
    sc.outboundTrucksPerHour = hourlyProfile(tot.o, sc.startHour, sc.shiftHours, shape.v);
    sc.ordersPerHour = hourlyProfile(tot.p, sc.startHour, sc.shiftHours, shape.v);
    ch();
    ctx.rerender();
  };

  const idx = (a: number[]) => Array.from({ length: sc.shiftHours }, (_, k) => a[(sc.startHour + k) % 24]);
  const labels = Array.from({ length: sc.shiftHours }, (_, k) => `${(sc.startHour + k) % 24}h`);

  root.append(
    h('div', { class: 'row', style: { marginBottom: '10px' } },
      h('button', { class: 'b pri', onclick: () => pickExcel(ctx) }, '📥 Importar planilha Excel'),
      h('button', { class: 'b', onclick: () => downloadTemplate(ctx) }, '📄 Baixar modelo .xlsx'),
    ),
    section('Horizonte e metas', [
      numField('Horas operacionais/dia', () => sc.shiftHours, (v) => ((sc.shiftHours = Math.round(v)), ch(), ctx.rerender()), { min: 1, max: 24, step: 1, unit: 'h' }),
      numField('Início da operação', () => sc.startHour, (v) => ((sc.startHour = Math.round(v) % 24), ch(), ctx.rerender()), { min: 0, max: 23, step: 1, unit: 'h' }),
      numField('Dias simulados', () => sc.days, (v) => ((sc.days = Math.round(v)), ch()), { min: 1, max: 60, step: 1 }),
      numField('Aquecimento (descartado)', () => sc.warmupHours, (v) => ((sc.warmupHours = v), ch()), { min: 0, max: 72, step: 1, unit: 'h' }),
      numField('Réplicas Monte Carlo', () => sc.replications, (v) => ((sc.replications = Math.round(v)), ch()), { min: 1, max: 500, step: 1 }),
      numField('Semente aleatória', () => sc.seed, (v) => ((sc.seed = Math.round(v)), ch()), { step: 1 }),
      numField('Meta de utilização', () => sc.targetUtilization * 100, (v) => ((sc.targetUtilization = Math.min(0.99, v / 100)), ch()), { min: 10, max: 99, step: 1, unit: '%' }),
      numField('Meta espera P95', () => sc.targetWaitP95Min, (v) => ((sc.targetWaitP95Min = v), ch()), { min: 0.1, step: 1, unit: 'min' }),
      numField('Nível de serviço', () => sc.serviceLevel * 100, (v) => ((sc.serviceLevel = Math.min(0.999, v / 100)), ch()), { min: 50, max: 99.9, step: 0.5, unit: '%' }),
      numField('Fator de demanda', () => sc.demandFactor, (v) => ((sc.demandFactor = v), ch()), { min: 0.1, max: 5, step: 0.05, unit: '×', title: 'Multiplica toda a demanda – útil para testar crescimento' }),
    ], false),
    section('Recursos', [
      h('table', null,
        h('thead', null, h('tr', null, ['Recurso', 'Qtd', 'v vazio', 'v carreg.', 'Disp. %', 'R$/h'].map((t) => h('th', null, t)))),
        h('tbody', null, fleetRows(ctx, 'Empilhadeiras', sc.forklifts), fleetRows(ctx, 'Operários', sc.workers), fleetRows(ctx, 'Conferentes', sc.checkers)),
      ),
      h('p', { class: 'note' }, 'Velocidades em m/s. Disponibilidade modela quebras/paradas (MTTR = 30 min, tempos entre falhas exponenciais).'),
    ]),
    section('Demanda por hora', [
      seriesChart([
        { name: 'Cam. entrada', values: idx(sc.inboundTrucksPerHour), type: 'bar' },
        { name: 'Cam. saída', values: idx(sc.outboundTrucksPerHour), type: 'bar' },
        { name: 'Pedidos/50', values: idx(sc.ordersPerHour).map((v) => v / 50), type: 'line', color: '#34d399' },
      ], { xLabels: labels, h: 150 }),
      h('div', { class: 'row' },
        h('label', { class: 'f', style: { flex: '1' } }, h('span', null, 'Caminhões entrada/dia'), (() => { const i = h('input', { type: 'number', value: String(+tot.i.toFixed(1)) }); i.addEventListener('change', () => (tot.i = parseFloat(i.value) || 0)); return i; })()),
        h('label', { class: 'f', style: { flex: '1' } }, h('span', null, 'saída/dia'), (() => { const i = h('input', { type: 'number', value: String(+tot.o.toFixed(1)) }); i.addEventListener('change', () => (tot.o = parseFloat(i.value) || 0)); return i; })()),
      ),
      h('label', { class: 'f' }, h('span', null, 'Pedidos/dia'), (() => { const i = h('input', { type: 'number', value: String(+tot.p.toFixed(0)) }); i.addEventListener('change', () => (tot.p = parseFloat(i.value) || 0)); return i; })()),
      h('div', { class: 'row' },
        selField('Perfil', () => shape.v, (v) => (shape.v = v), [['peaks', 'Com picos (manhã/tarde)'], ['flat', 'Plano']]),
        h('button', { class: 'b', onclick: apply }, 'Aplicar totais/perfil'),
      ),
      demandTable(),
    ], false),
    section('Carga e pedidos', [
      numField('Paletes/caminhão entrada (média)', () => sc.palletsPerTruckIn.mean, (v) => ((sc.palletsPerTruckIn.mean = v), ch()), { min: 1, step: 1 }),
      numField('desvio', () => sc.palletsPerTruckIn.sd, (v) => ((sc.palletsPerTruckIn.sd = v), ch()), { min: 0, step: 0.5 }),
      numField('máximo (capacidade)', () => sc.palletsPerTruckIn.max, (v) => ((sc.palletsPerTruckIn.max = v), ch()), { min: 1, step: 1 }),
      numField('Paletes/caminhão saída (média)', () => sc.palletsPerTruckOut.mean, (v) => ((sc.palletsPerTruckOut.mean = v), ch()), { min: 1, step: 1 }),
      numField('desvio', () => sc.palletsPerTruckOut.sd, (v) => ((sc.palletsPerTruckOut.sd = v), ch()), { min: 0, step: 0.5 }),
      numField('máximo (capacidade)', () => sc.palletsPerTruckOut.max, (v) => ((sc.palletsPerTruckOut.max = v), ch()), { min: 1, step: 1 }),
      numField('Linhas por pedido (média)', () => sc.linesPerOrder.mean, (v) => ((sc.linesPerOrder.mean = v), ch()), { min: 1, step: 0.5 }),
      numField('Caixas por linha (média)', () => sc.cartonsPerLine.mean, (v) => ((sc.cartonsPerLine.mean = v), ch()), { min: 1, step: 0.5 }),
      numField('Caixas por linha (desvio)', () => sc.cartonsPerLine.sd, (v) => ((sc.cartonsPerLine.sd = v), ch()), { min: 0, step: 0.5 }),
    ], false),
    section('Tempos de operação (segundos)', [
      h('table', null,
        h('thead', null, h('tr', null, ['Operação', 'Distribuição', 'P1', 'P2', 'P3'].map((t) => h('th', null, t)))),
        h('tbody', null, ...([
          ['Descarga de palete', 'unloadPallet'], ['Conferência', 'checkPallet'], ['Posicionar no rack', 'putawayPosition'], ['Carga no caminhão', 'loadPallet'],
          ['Separar 1 caixa', 'pickCarton'], ['Manobra na doca', 'dockTurnover'], ['Embalar pedido', 'packOrder'],
        ] as [string, keyof Scenario['ops']][]).map(([lab, key]) => distRow(ctx, lab, () => sc.ops[key], (d) => ((sc.ops[key] = d), ch())))),
      ),
      numField('Velocidade de elevação', () => sc.liftSpeed, (v) => ((sc.liftSpeed = v), ch()), { min: 0.05, step: 0.05, unit: 'm/s' }),
      numField('Altura entre níveis', () => sc.levelHeight, (v) => ((sc.levelHeight = v), ch()), { min: 0.8, step: 0.1, unit: 'm' }),
      numField('Aceleração', () => sc.accel, (v) => ((sc.accel = v), ch()), { min: 0.1, step: 0.1, unit: 'm/s²' }),
      numField('Espaçamento na esteira', () => sc.conveyorSpacing, (v) => ((sc.conveyorSpacing = v), ch()), { min: 0.2, step: 0.1, unit: 'm' }),
    ], false),
    section('Estoque e endereçamento', [
      numField('Ocupação inicial', () => sc.initialOccupancy * 100, (v) => ((sc.initialOccupancy = Math.min(1, v / 100)), ch()), { min: 0, max: 100, step: 5, unit: '%' }),
      numField('Permanência média', () => sc.dwellDays, (v) => ((sc.dwellDays = v), ch()), { min: 0.1, step: 1, unit: 'dias' }),
      selField('Política de endereçamento', () => sc.slotting, (v) => ((sc.slotting = v), ch()), [['abc', 'Curva ABC (A perto das docas)'], ['nearest', 'Posição livre mais próxima'], ['random', 'Aleatória']]),
      skuTable(ctx),
    ], false),
  );
  return root;
}

function skuTable(ctx: AppCtx) {
  const sc = ctx.scenario;
  const rows = sc.skus.map((k, i) => {
    const inp = (get: () => string | number, set: (v: string) => void, type = 'text') => {
      const e = h('input', { type, value: String(get()), step: 'any' });
      e.addEventListener('change', () => { set(e.value); ctx.scenarioChanged(); });
      return h('td', null, e);
    };
    const cls = h('select', null, ['A', 'B', 'C'].map((c) => h('option', { value: c, selected: c === k.cls }, c)));
    cls.addEventListener('change', () => { k.cls = cls.value as 'A' | 'B' | 'C'; ctx.scenarioChanged(); });
    return h('tr', null,
      inp(() => k.sku, (v) => (k.sku = v)),
      h('td', null, cls),
      inp(() => +(k.share * 100).toFixed(2), (v) => { k.share = Math.max(0, parseFloat(v) || 0) / 100; }, 'number'),
      inp(() => k.cartonsPerPallet, (v) => (k.cartonsPerPallet = parseFloat(v) || 1), 'number'),
      h('td', null, h('button', { class: 'b sm danger', onclick: () => { sc.skus.splice(i, 1); ctx.scenarioChanged(); ctx.rerender(); } }, '✕')),
    );
  });
  const tot = sc.skus.reduce((s, k) => s + k.share, 0);
  return h('div', null,
    h('h3', null, `SKUs / curva ABC (soma do giro: ${fmt(tot * 100, 0)}%)`),
    h('table', null, h('thead', null, h('tr', null, ['SKU', 'Cl.', 'Giro %', 'cx/pal', ''].map((t) => h('th', null, t)))), h('tbody', null, rows)),
    h('div', { class: 'row', style: { marginTop: '6px' } },
      h('button', { class: 'b sm', onclick: () => { sc.skus.push({ sku: `SKU-${sc.skus.length + 1}`, description: '', cls: 'C', share: 0.05, cartonsPerPallet: 40 }); ctx.scenarioChanged(); ctx.rerender(); } }, '+ SKU'),
      h('button', { class: 'b sm', onclick: () => { const t = sc.skus.reduce((s, k) => s + k.share, 0) || 1; sc.skus.forEach((k) => (k.share /= t)); ctx.scenarioChanged(); ctx.rerender(); } }, 'Normalizar para 100%'),
    ),
  );
}
