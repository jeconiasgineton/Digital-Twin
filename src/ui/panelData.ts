import type { ArrivalSpec, BreakSpec, Dist, DistKind, EquipmentSpec, FleetSpec, PeopleRole, Scenario, VehicleType } from '../model/types';
import { EQUIPMENT_NAMES } from '../model/equipment';
import { buildWorld, slotLabel } from '../sim/world';
import { PICKING_SOURCE, ROUTE_LABEL, parseAddresses, type PickRoute } from '../model/picking';
import { PEOPLE_ROLES, ROLE_NAMES, breakWaves, defaultBreak, presetVehicle } from '../model/traffic';
import { catalog, defaultEquipment, NIOSH_LOAD_KG } from '../model/equipment';
import { hourlyProfile } from '../model/defaults';
import { exportTemplate, importWorkbook } from '../io/excel';
import type { AppCtx } from './ctx';
import { download, fmt, h, numField, pickFile, selField, textField, toast } from './dom';
import { seriesChart } from './charts';

/** seções abertas pelo usuário: sobrevivem aos redesenhos do painel (ex.: ao adicionar um tipo de veículo) */
const sectionOpen = new Map<string, boolean>();

function section(title: string, body: (Element | null)[], open = true) {
  const d = h('details', { open: sectionOpen.get(title) ?? open }, h('summary', null, title), h('div', { class: 'body' }, body));
  d.addEventListener('toggle', () => sectionOpen.set(title, d.open));
  return d;
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

export const DIST_KINDS: [DistKind, string][] = [['constant', 'Constante'], ['triangular', 'Triangular'], ['normal', 'Normal'], ['lognormal', 'Lognormal'], ['exponential', 'Exponencial'], ['uniform', 'Uniforme']];
export const DIST_LABELS: Record<DistKind, [string, string, string]> = {
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

/** cartão de um equipamento do catálogo, com os campos próprios do AMR */
function equipmentCard(ctx: AppCtx, e: EquipmentSpec): HTMLElement {
  const sc = ctx.scenario;
  const ch = () => ctx.scenarioChanged();
  const chk = (label: string, get: () => boolean, set: (v: boolean) => void, disabled = false) =>
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: get(), disabled, onchange: (ev: Event) => { set((ev.target as HTMLInputElement).checked); ch(); } }), label);
  const fields: HTMLElement[] = [
    numField('Quantidade', () => e.count, (v) => ((e.count = Math.max(0, Math.round(v))), ch()), { step: 1, min: 0 }),
    numField('Velocidade vazio', () => e.speedEmpty, (v) => ((e.speedEmpty = v), ch()), { step: 0.05, min: 0.1, unit: 'm/s' }),
    numField('Velocidade carregado', () => e.speedLoaded, (v) => ((e.speedLoaded = v), ch()), { step: 0.05, min: 0.1, unit: 'm/s' }),
    numField('Capacidade de carga', () => e.capacityKg, (v) => ((e.capacityKg = Math.max(1, v)), ch()), { step: 50, min: 1, unit: 'kg' }),
    numField('Paletes por viagem', () => e.palletsPerTrip, (v) => ((e.palletsPerTrip = Math.max(1, Math.round(v))), ch()), { step: 1, min: 1 }),
    numField('Disponibilidade', () => e.availability * 100, (v) => ((e.availability = Math.min(1, v / 100)), ch()), { step: 1, min: 5, max: 100, unit: '%' }),
    numField('Custo', () => e.costPerHour, (v) => ((e.costPerHour = v), ch()), { step: 1, min: 0, unit: 'R$/h' }),
    chk('Eleva o palete até os níveis do rack', () => e.canLift, (v) => (e.canLift = v)),
    chk('Precisa de operador', () => e.needsOperator, (v) => (e.needsOperator = v), e.kind === 'amr'),
  ];
  if (e.kind === 'amr' && e.amr) {
    const a = e.amr;
    fields.push(
      h('b', null, 'Bateria e carregamento'),
      numField('Autonomia da bateria', () => a.autonomyMin, (v) => ((a.autonomyMin = Math.max(1, v)), ch()), { step: 10, min: 1, unit: 'min', title: 'Operação contínua entre cargas completas' }),
      numField('Gatilho de carga', () => a.chargeTriggerFraction * 100, (v) => ((a.chargeTriggerFraction = Math.min(1, Math.max(0.05, v / 100))), ch()), { step: 5, min: 5, max: 100, unit: '% da autonomia', title: 'Ao consumir esta fração da autonomia, o AMR interrompe a atividade e vai à estação de carga (50% = metade)' }),
      numField('Tempo de carregamento', () => a.chargeMin, (v) => ((a.chargeMin = Math.max(0, v)), ch()), { step: 5, min: 0, unit: 'min' }),
      numField('Setup a cada carga', () => a.setupMin, (v) => ((a.setupMin = Math.max(0, v)), ch()), { step: 1, min: 0, unit: 'min' }),
      chk('Carregar também no início do turno', () => a.chargeAtShiftStart, (v) => (a.chargeAtShiftStart = v)),
      chk('Carregar também no fim do turno', () => a.chargeAtShiftEnd, (v) => (a.chargeAtShiftEnd = v)),
      h('label', { class: 'f' }, h('span', null, 'Horários específicos de carga (h, separados por ;)'),
        h('input', { type: 'text', value: a.chargeAtHours.join(';'), placeholder: 'ex.: 12;18.5', onchange: (ev: Event) => { a.chargeAtHours = (ev.target as HTMLInputElement).value.split(/[;,]/).map((x) => parseFloat(x.trim())).filter((x) => Number.isFinite(x) && x >= 0 && x < 24); (ev.target as HTMLInputElement).value = a.chargeAtHours.join(';'); ch(); } })),
    );
  }
  const defs = defaultEquipment(e.kind, e.count);
  return h('details', { open: e.count > 0 },
    h('summary', null, `${e.name} · ${e.count} un.`),
    h('div', { class: 'body', style: { display: 'grid', gap: '7px' } }, fields,
      e.source ? h('p', { class: 'note' }, 'Padrão: ', e.source) : null,
      h('button', { class: 'b sm', onclick: () => { Object.assign(e, { ...defs, count: e.count }); if (e.amr) e.amr = defs.amr; ch(); ctx.rerender(); } }, 'Restaurar padrões'),
    ),
  );
}

const fmtHour = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
const parseHourText = (s: string): number | null => {
  const m = s.trim().match(/^(\d{1,2})\s*[:h]\s*(\d{0,2})$/);
  const v = m ? +m[1] + (m[2] ? +m[2] / 60 : 0) : parseFloat(s.replace(',', '.'));
  return Number.isFinite(v) && v >= 0 && v < 24 ? v : null;
};

/** chegadas de um sentido (recebimento/expedição): modo, intervalo/agenda e atrasos */
function arrivalBox(ctx: AppCtx, title: string, a: ArrivalSpec): HTMLElement {
  const ch = () => ctx.scenarioChanged();
  const body: HTMLElement[] = [
    selField('Modo de chegada', () => a.mode, (v) => ((a.mode = v), ch(), ctx.rerender()), [
      ['poisson', 'Aleatório (taxa por hora – aba Demanda)'], ['fixed', 'Intervalo fixo (a cada X min)'], ['scheduled', 'Agendado (horários)'],
    ]),
  ];
  if (a.mode === 'fixed') body.push(numField('Um veículo a cada', () => a.intervalMin, (v) => ((a.intervalMin = Math.max(0.1, v)), ch()), { step: 1, min: 0.1, unit: 'min' }));
  if (a.mode === 'scheduled')
    body.push(h('label', { class: 'f' }, h('span', null, 'Horários (hh:mm separados por ;)'),
      h('input', { type: 'text', value: a.scheduleHours.map(fmtHour).join('; '), placeholder: '06:00; 06:30; 07:15',
        onchange: (ev: Event) => { a.scheduleHours = (ev.target as HTMLInputElement).value.split(/[;,]\s*(?=\d)/).map(parseHourText).filter((x): x is number => x !== null).sort((x, y) => x - y); (ev.target as HTMLInputElement).value = a.scheduleHours.map(fmtHour).join('; '); ch(); } })));
  if (a.mode !== 'poisson')
    body.push(
      numField('Probabilidade de atraso', () => a.delayProb * 100, (v) => ((a.delayProb = Math.min(1, Math.max(0, v / 100))), ch()), { step: 5, min: 0, max: 100, unit: '%' }),
      numField('Atraso médio (se atrasado)', () => a.delayMin.a, (v) => ((a.delayMin = { kind: 'lognormal', a: Math.max(0.1, v), b: a.delayMin.b ?? 0 }), ch()), { step: 5, min: 0.1, unit: 'min' }),
      numField('Desvio do atraso', () => a.delayMin.b ?? 0, (v) => ((a.delayMin = { kind: 'lognormal', a: a.delayMin.a, b: Math.max(0, v) }), ch()), { step: 5, min: 0, unit: 'min' }),
    );
  else body.push(h('p', { class: 'note' }, 'No modo aleatório as chegadas já são irregulares; atrasos valem para os modos intervalo fixo e agendado.'));
  return h('details', { open: true }, h('summary', null, title), h('div', { class: 'body', style: { display: 'grid', gap: '7px' } }, body));
}

function vehicleCard(ctx: AppCtx, v: VehicleType): HTMLElement {
  const sc = ctx.scenario;
  const ch = () => ctx.scenarioChanged();
  return h('details', { open: true },
    h('summary', null, `${v.name} · ${(v.share / Math.max(1e-9, sc.vehicleTypes.reduce((s, x) => s + x.share, 0)) * 100).toFixed(0)}% da frota`),
    h('div', { class: 'body', style: { display: 'grid', gap: '7px' } },
      textField('Nome', () => v.name, (t) => ((v.name = t || v.name), ch(), ctx.rerender())),
      numField('Participação (peso)', () => v.share, (x) => ((v.share = Math.max(0, x)), ch(), ctx.rerender()), { step: 0.05, min: 0, title: 'Normalizada pela soma de todos os tipos' }),
      h('table', null,
        h('thead', null, h('tr', null, ['Manobra/docagem (s)', 'Distrib.', 'p1', 'p2', 'p3'].map((t) => h('th', null, t)))),
        h('tbody', null, distRow(ctx, '', () => v.dockTurnover, (d) => ((v.dockTurnover = d), ch())))),
      h('p', { class: 'note' }, `≈ ${(distMeanOf(v.dockTurnover) / 60).toFixed(1)} min por manobra.`),
      numField('Paletes por veículo (média)', () => v.pallets.mean, (x) => ((v.pallets.mean = Math.max(1, x)), ch()), { step: 1, min: 1 }),
      numField('desvio', () => v.pallets.sd, (x) => ((v.pallets.sd = Math.max(0, x)), ch()), { step: 0.5, min: 0 }),
      numField('máximo (capacidade)', () => v.pallets.max, (x) => ((v.pallets.max = Math.max(1, x)), ch()), { step: 1, min: 1 }),
      numField('Comprimento do baú', () => v.trailerLengthM, (x) => ((v.trailerLengthM = Math.max(1, x)), ch()), { step: 0.5, min: 1, unit: 'm', title: 'Define a distância de movimentação dentro do baú no recebimento' }),
      h('button', { class: 'b danger sm', onclick: () => { sc.vehicleTypes = sc.vehicleTypes.filter((x) => x !== v); ch(); ctx.rerender(); } }, 'Remover tipo'),
    ),
  );
}

function breakCard(ctx: AppCtx, b: BreakSpec): HTMLElement {
  const sc = ctx.scenario;
  const ch = () => ctx.scenarioChanged();
  const roleChk = (r: PeopleRole) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: b.groups.includes(r), onchange: (ev: Event) => {
    b.groups = (ev.target as HTMLInputElement).checked ? [...new Set([...b.groups, r])] : b.groups.filter((x) => x !== r);
    ch(); ctx.rerender();
  } }), ROLE_NAMES[r]);
  const all = b.groups.length === PEOPLE_ROLES.length;
  const waves = breakWaves(b);
  return h('details', { open: true },
    h('summary', null, `${b.name} · ${fmtHour(b.startHour)} · ${b.durationMin} min`),
    h('div', { class: 'body', style: { display: 'grid', gap: '7px' } },
      textField('Nome', () => b.name, (t) => ((b.name = t || b.name), ch(), ctx.rerender())),
      h('label', { class: 'f' }, h('span', null, 'Início (hh:mm)'), h('input', { type: 'text', value: fmtHour(b.startHour), onchange: (ev: Event) => { const v = parseHourText((ev.target as HTMLInputElement).value); if (v !== null) { b.startHour = v; ch(); ctx.rerender(); } else (ev.target as HTMLInputElement).value = fmtHour(b.startHour); } })),
      numField('Duração', () => b.durationMin, (x) => ((b.durationMin = Math.max(1, x)), ch(), ctx.rerender()), { step: 5, min: 1, unit: 'min' }),
      h('b', null, 'Quem para'),
      h('div', { class: 'row' },
        h('button', { class: `b sm${all ? ' pri' : ''}`, onclick: () => { b.groups = [...PEOPLE_ROLES]; ch(); ctx.rerender(); } }, 'Todas as pessoas'),
        h('span', { class: 'note' }, all ? '' : 'ou grupos específicos:')),
      h('div', { class: 'row' }, PEOPLE_ROLES.map(roleChk)),
      selField('Como a equipe sai', () => b.stagger, (v) => ((b.stagger = v), ch(), ctx.rerender()), [['all', 'Todos ao mesmo tempo'], ['half', 'Metade da equipe por vez'], ['percent', 'Um percentual por vez']]),
      b.stagger === 'percent' ? numField('Percentual por vez', () => b.percentPerWave, (x) => ((b.percentPerWave = Math.min(100, Math.max(1, x))), ch(), ctx.rerender()), { step: 5, min: 1, max: 100, unit: '%' }) : null,
      h('p', { class: 'note' }, waves === 1 ? 'Toda a equipe sai junta.' : `${waves} ondas sucessivas de ${b.durationMin} min cada (o intervalo todo dura ${waves * b.durationMin} min).`),
      h('button', { class: 'b danger sm', onclick: () => { sc.calendar.breaks = sc.calendar.breaks.filter((x) => x !== b); ch(); ctx.rerender(); } }, 'Remover intervalo'),
    ),
  );
}

const distMeanOf = (d: Dist) => (d.kind === 'triangular' ? (d.a + (d.b ?? d.a) + (d.c ?? d.a)) / 3 : d.kind === 'uniform' ? (d.a + (d.b ?? d.a)) / 2 : d.kind === 'lognormal' || d.kind === 'normal' || d.kind === 'exponential' || d.kind === 'constant' ? d.a : d.a);

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
    section('Equipamentos (catálogo)', [
      h('p', { class: 'note' }, 'Quantidade 0 = equipamento não usado. Velocidades em m/s. Os padrões vêm de fichas técnicas públicas ou de premissas típicas (a fonte aparece em cada equipamento); edite livremente.'),
      ...catalog(sc).map((e) => equipmentCard(ctx, e)),
    ]),
    section('Pessoas', [
      h('table', null,
        h('thead', null, h('tr', null, ['Recurso', 'Qtd', 'v vazio', 'v carreg.', 'Disp. %', 'R$/h'].map((t) => h('th', null, t)))),
        h('tbody', null, fleetRows(ctx, 'Operários', sc.workers), fleetRows(ctx, 'Conferentes', sc.checkers)),
      ),
      numField('Carga manual máx. por operador', () => sc.workers.capacityKg ?? NIOSH_LOAD_KG, (v) => ((sc.workers.capacityKg = sc.checkers.capacityKg = Math.max(1, v)), ch()), { step: 1, min: 1, unit: 'kg', title: 'Padrão: 23 kg, constante de carga da equação de levantamento do NIOSH (condições ideais)' }),
      h('p', { class: 'note' }, 'Disponibilidade modela quebras/paradas (MTTR = 30 min, tempos entre falhas exponenciais). A carga manual máxima (padrão NIOSH, 23 kg) limita o que uma pessoa levanta sem equipamento.'),
    ]),
    section('Veículos e chegadas', [
      arrivalBox(ctx, 'Chegadas – recebimento', sc.arrivalsIn),
      arrivalBox(ctx, 'Chegadas – expedição', sc.arrivalsOut),
      numField('Limite de espera na doca (gargalo)', () => sc.dockWaitThresholdMin, (v) => ((sc.dockWaitThresholdMin = Math.max(0, v)), ch()), { step: 1, min: 0, unit: 'min', title: 'Caminhões que esperam mais que isso contam no indicador "% acima do limite"' }),
      h('b', null, 'Tipos de veículo'),
      sc.vehicleTypes.length ? null : h('p', { class: 'note' }, 'Sem tipos cadastrados: todos os caminhões são iguais (paletes por caminhão e manobra gerais). Adicione tipos para diferenciar o tempo de docagem e a carga de cada veículo.'),
      ...sc.vehicleTypes.map((v) => vehicleCard(ctx, v)),
      h('div', { class: 'row' },
        h('button', { class: 'b sm', onclick: () => { sc.vehicleTypes.push(presetVehicle('carreta')); ch(); ctx.rerender(); } }, '+ Carreta'),
        h('button', { class: 'b sm', onclick: () => { sc.vehicleTypes.push(presetVehicle('truck')); ch(); ctx.rerender(); } }, '+ Truck'),
        h('button', { class: 'b sm', onclick: () => { sc.vehicleTypes.push(presetVehicle('vuc')); ch(); ctx.rerender(); } }, '+ VUC')),
    ], false),
    section('Armazenagem', [
      selField('Modo de armazenagem (vale para toda a operação)', () => sc.storage.mode, (v) => ((sc.storage.mode = v), ch(), ctx.rerender()), [
        ['direct', 'Direta: empilhadeira busca no stage e leva ao endereço'],
        ['phased', 'Faseada: etapa 1 sem elevação até a rua; etapa 2 elevação'],
      ]),
      sc.storage.mode === 'phased'
        ? h('div', { style: { display: 'grid', gap: '7px' } },
            h('b', null, 'Equipamentos da etapa 1 (sem elevação)'),
            h('div', { class: 'row' }, (['palletJack', 'palletTruck', 'amr'] as const).map((k) =>
              h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: sc.storage.step1With.includes(k), onchange: (ev: Event) => {
                sc.storage.step1With = (ev.target as HTMLInputElement).checked ? [...new Set([...sc.storage.step1With, k])] : sc.storage.step1With.filter((x) => x !== k);
                ch(); ctx.rerender();
              } }), EQUIPMENT_NAMES[k]))),
            h('p', { class: 'note' }, 'O endereço de destino (rua + estante + nível) é definido após a conferência. O equipamento da etapa 1 leva o palete a um endereço transitório da rua do destino; se a rua estiver cheia, espera liberar espaço. Na etapa 2 a empilhadeira recebe o destino final, pega o palete na rua e faz a elevação. Sem equipamento de etapa 1 disponível, a empilhadeira faz as duas etapas.'))
        : h('p', { class: 'note' }, 'A empilhadeira busca o palete no stage e o leva ao endereço definido pelas regras de armazenagem e pela curva ABC, já com a elevação.'),
    ], false),
    section('Separação (picking por palete)', [
      selField('Modo de separação', () => sc.picking.mode, (v) => ((sc.picking.mode = v), ch(), ctx.rerender()), [
        ['legacy', 'Padrão antigo (esteira e embalagem)'], ['pallet', 'Picking por palete (rota, leitura, furos de estoque)'],
      ]),
      ...(sc.picking.mode === 'pallet' ? [
        h('b', null, 'Pedido'),
        numField('Caixas por pedido (média)', () => sc.picking.boxesPerOrder.mean, (v) => ((sc.picking.boxesPerOrder.mean = Math.max(1, v)), ch()), { step: 1, min: 1 }),
        numField('… desvio', () => sc.picking.boxesPerOrder.sd, (v) => ((sc.picking.boxesPerOrder.sd = Math.max(0, v)), ch()), { step: 1, min: 0 }),
        numField('Caixas da curva A', () => sc.picking.abc.a * 100, (v) => ((sc.picking.abc.a = Math.max(0, v / 100)), ch(), ctx.rerender()), { step: 5, min: 0, max: 100, unit: '%' }),
        numField('Caixas da curva B', () => sc.picking.abc.b * 100, (v) => ((sc.picking.abc.b = Math.max(0, v / 100)), ch(), ctx.rerender()), { step: 5, min: 0, max: 100, unit: '%' }),
        numField('Caixas da curva C', () => sc.picking.abc.c * 100, (v) => ((sc.picking.abc.c = Math.max(0, v / 100)), ch(), ctx.rerender()), { step: 5, min: 0, max: 100, unit: '%' }),
        (() => {
          const t = sc.picking.abc.a + sc.picking.abc.b + sc.picking.abc.c;
          return h('p', { class: 'note' }, Math.abs(t - 1) > 0.005 ? `A soma é ${(t * 100).toFixed(0)}%: os percentuais serão normalizados para 100%.` : 'Cada caixa do pedido é da curva A, B ou C conforme esses percentuais; a curva define a zona do galpão onde ela é coletada.');
        })(),
        h('b', null, 'Palete e rota'),
        numField('Caixas por palete – limite médio', () => sc.picking.palletLimit.mean, (v) => ((sc.picking.palletLimit.mean = Math.max(1, v)), ch()), { step: 5, min: 1, title: 'Ao atingir o limite, o operador leva o palete ao stage de expedição' }),
        numField('… desvio', () => sc.picking.palletLimit.sd, (v) => ((sc.picking.palletLimit.sd = Math.max(0, v)), ch()), { step: 1, min: 0 }),
        selField('Rota de separação', () => sc.picking.route, (v) => ((sc.picking.route = v as PickRoute), ch()), (Object.keys(ROUTE_LABEL) as PickRoute[]).map((k) => [k, ROUTE_LABEL[k]] as [PickRoute, string])),
        numField('Separadores por pedido', () => sc.picking.pickersPerOrder, (v) => ((sc.picking.pickersPerOrder = Math.max(1, Math.round(v))), ch()), { step: 1, min: 1, title: 'O pedido é dividido por ruas entre os separadores (ex.: 100 caixas com 3 separadores)' }),
        h('b', null, 'Tempos por movimento (s)'),
        h('table', null,
          h('thead', null, h('tr', null, ['Movimento', 'Distribuição', 'P1', 'P2', 'P3'].map((t) => h('th', null, t)))),
          h('tbody', null,
            distRow(ctx, 'Ler o código do endereço', () => sc.picking.scan, (d) => ((sc.picking.scan = d), ch())),
            distRow(ctx, 'Pegar uma caixa', () => sc.picking.pick, (d) => ((sc.picking.pick = d), ch())),
            distRow(ctx, 'Colocar no palete', () => sc.picking.place, (d) => ((sc.picking.place = d), ch())))),
        h('p', { class: 'note' }, PICKING_SOURCE),
        h('b', null, 'Furos de estoque'),
        selField('Furo de estoque', () => sc.picking.stockout.mode, (v) => ((sc.picking.stockout.mode = v), ch(), ctx.rerender()), [
          ['off', 'Sem furos (faces sempre abastecidas)'], ['pct', 'Percentual das visitas'], ['positions', 'Endereços definidos (vazios na simulação)'],
        ]),
        ...(sc.picking.stockout.mode === 'pct' ? [numField('Endereço vazio ao chegar', () => sc.picking.stockout.pct * 100, (v) => ((sc.picking.stockout.pct = Math.min(1, Math.max(0, v / 100))), ch()), { step: 0.5, min: 0, max: 100, unit: '%' })] : []),
        ...(sc.picking.stockout.mode === 'positions' ? [h('label', { class: 'f', style: { gridTemplateColumns: '1fr' } }, h('span', null, 'Endereços vazios (ex.: A015, B023)'),
          h('textarea', { rows: '3', style: { width: '100%', background: 'var(--bg3)', color: 'var(--tx)', border: '1px solid var(--line)', borderRadius: '5px', padding: '5px' }, value: sc.picking.stockout.addresses.join(', '),
            onchange: (ev: Event) => { sc.picking.stockout.addresses = parseAddresses((ev.target as HTMLTextAreaElement).value); (ev.target as HTMLTextAreaElement).value = sc.picking.stockout.addresses.join(', '); ch(); } }))] : []),
        ...(sc.picking.stockout.mode === 'positions' ? [(() => {
          let ex: string[] = [];
          try {
            const w = buildWorld(ctx.layout, sc);
            ex = w.pickRacks.slice(0, 4).flatMap((r) => [slotLabel(r, 0), slotLabel(r, Math.max(0, (Math.floor(r.bays / 2)) * r.levels))]).slice(0, 8);
          } catch { /* layout incompleto */ }
          return h('p', { class: 'note' }, ex.length ? `Endereços de picking que existem no layout atual (exemplos): ${[...new Set(ex)].join(', ')}.` : 'Desenhe racks (e ruas) no layout para ver os endereços de picking.');
        })()] : []),
        ...(sc.picking.stockout.mode !== 'off' ? [h('table', null,
          h('thead', null, h('tr', null, ['Tempo perdido', 'Distribuição', 'P1', 'P2', 'P3'].map((t) => h('th', null, t)))),
          h('tbody', null, distRow(ctx, 'Espera até repor o produto (s)', () => sc.picking.stockout.delay, (d) => ((sc.picking.stockout.delay = d), ch()))))] : []),
        h('p', { class: 'note' }, 'Os endereços de picking são o nível mais baixo dos racks, no formato rua + estante + nível 1 (ex.: A011). O stage de expedição é o elemento "Stage" marcado como expedição no layout. A produtividade sai em caixas por hora de trabalho do separador, calculada a partir dos tempos acima.'),
      ] : [h('p', { class: 'note' }, 'No modo antigo o operador coleta as caixas e as leva à esteira. Escolha "Picking por palete" para simular a rota, a leitura de endereço, o limite do palete e os furos de estoque.')]),
    ], false),
    section('Recebimento: descarga, avarias e triagem', [
      h('b', null, 'Equipamentos que podem descarregar o baú'),
      h('p', { class: 'note' }, 'O equipamento disponível no momento é acionado. Só vale para os que têm quantidade maior que 0 no catálogo.'),
      h('div', { class: 'row' }, (['forklift', 'palletJack', 'palletTruck', 'amr'] as const).map((k) =>
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: sc.receiving.unloadWith.includes(k), onchange: (ev: Event) => {
          sc.receiving.unloadWith = (ev.target as HTMLInputElement).checked ? [...new Set([...sc.receiving.unloadWith, k])] : sc.receiving.unloadWith.filter((x) => x !== k);
          ch(); ctx.rerender();
        } }), EQUIPMENT_NAMES[k]))),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: sc.receiving.trailerDepth, onchange: (ev: Event) => { sc.receiving.trailerDepth = (ev.target as HTMLInputElement).checked; ch(); } }), 'Distância dentro do baú conforme o comprimento do veículo'),
      h('b', null, 'Avarias'),
      numField('Paletes avariados', () => sc.receiving.damagePalletPct * 100, (v) => ((sc.receiving.damagePalletPct = Math.min(1, Math.max(0, v / 100))), ch()), { step: 0.5, min: 0, max: 100, unit: '%', title: 'Probabilidade de cada palete conferido ter avaria. Padrão: 3% (premissa)' }),
      numField('Caixas avariadas no palete – mínimo', () => sc.receiving.damagedCartonsFraction.a * 100, (v) => { const f = sc.receiving.damagedCartonsFraction; sc.receiving.damagedCartonsFraction = { kind: 'triangular', a: Math.min(1, Math.max(0, v / 100)), b: f.b, c: f.c }; ch(); }, { step: 1, min: 0, max: 100, unit: '%' }),
      numField('… mais provável (moda)', () => (sc.receiving.damagedCartonsFraction.b ?? 0.2) * 100, (v) => { const f = sc.receiving.damagedCartonsFraction; sc.receiving.damagedCartonsFraction = { kind: 'triangular', a: f.a, b: Math.min(1, Math.max(0, v / 100)), c: f.c }; ch(); }, { step: 1, min: 0, max: 100, unit: '%' }),
      numField('… máximo (100% = palete inteiro)', () => (sc.receiving.damagedCartonsFraction.c ?? 1) * 100, (v) => { const f = sc.receiving.damagedCartonsFraction; sc.receiving.damagedCartonsFraction = { kind: 'triangular', a: f.a, b: f.b, c: Math.min(1, Math.max(0, v / 100)) }; ch(); }, { step: 1, min: 0, max: 100, unit: '%', title: 'Se todas as caixas estiverem avariadas, o palete original vai inteiro para a triagem' }),
      numField('Acréscimo no tempo de conferência', () => (sc.receiving.damagedCheckFactor - 1) * 100, (v) => ((sc.receiving.damagedCheckFactor = 1 + Math.max(0, v) / 100), ch()), { step: 10, min: 0, unit: '%', title: 'Palete avariado leva mais tempo para ser conferido. Padrão: +50% (premissa)' }),
      numField('Esvaziar triagem a cada', () => sc.receiving.triageClearEveryHours, (v) => ((sc.receiving.triageClearEveryHours = Math.max(0, v)), ch()), { step: 1, min: 0, unit: 'h', title: 'Coleta/descarte periódico das áreas de triagem. 0 = nunca' }),
      h('p', { class: 'note' }, 'A conferência (e portanto a detecção e a triagem de avarias) só ocorre com conferentes (quantidade > 0). O tempo por caixa na triagem (padrão 8 s, premissa) está em "Tempos de operação". Ao lotar uma área de triagem, o palete segue para a próxima por prioridade. O palete de avarias é levado por paleteira/transpaleteira/AMR; sem nenhum deles, pela empilhadeira.'),
    ], false),
    section('Jornada e intervalos', [
      h('p', { class: 'note' }, `Jornada: ${sc.shiftHours} h a partir das ${fmtHour(sc.startHour)} (ajuste em "Horizonte e metas"). As ${fmt(Math.max(0, 24 - sc.shiftHours), 0)} h restantes do dia são horas não úteis e não são simuladas. A produtividade usa as horas úteis (jornada − intervalos).`),
      ...sc.calendar.breaks.map((b) => breakCard(ctx, b)),
      h('div', { class: 'row' },
        h('button', { class: 'b sm', onclick: () => { sc.calendar.breaks.push(defaultBreak('almoco')); ch(); ctx.rerender(); } }, '+ Almoço (metade por vez)'),
        h('button', { class: 'b sm', onclick: () => { sc.calendar.breaks.push(defaultBreak('cafe')); ch(); ctx.rerender(); } }, '+ Café (todos juntos)')),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: sc.calendar.amrWorksDuringBreaks, onchange: (ev: Event) => { sc.calendar.amrWorksDuringBreaks = (ev.target as HTMLInputElement).checked; ch(); } }), 'AMR continuam trabalhando durante os intervalos das pessoas'),
    ], false),
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
          ['Separar 1 caixa', 'pickCarton'], ['Manobra na doca', 'dockTurnover'], ['Embalar pedido', 'packOrder'], ['Triagem: 1 caixa avariada', 'triageCarton'],
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
