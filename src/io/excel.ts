import ExcelJS from 'exceljs';
import type { ArrivalSpec, BreakSpec, Dist, DistKind, EquipmentKind, EquipmentSpec, FleetSpec, PeopleRole, VehicleType, Layout, LayoutElement, Scenario, SkuSpec } from '../model/types';
import { defaultScenario } from '../model/defaults';
import { defaultEquipment, normalizeEquipment } from '../model/equipment';
import { PEOPLE_ROLES } from '../model/traffic';
import { parseAddresses } from '../model/picking';
import { EXP_LABEL, type ExpStep, type ExpStepType } from '../model/expedition';
import { STEP_LABEL, portsOf, type ProcessDef, type Step, type StepType } from '../model/process';
import { defaultLayoutParams, generateLayout, newId, type LayoutParams } from '../model/layoutGen';
import { linearEnds, toWorld } from '../math/spatial';

export interface ImportResult {
  scenario: Scenario;
  layout: Layout | null;
  warnings: string[];
  /** o que foi lido da planilha */
  found: string[];
}

const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9%]+/g, '_')
    .replace(/^_+|_+$/g, '');

function cellValue(v: ExcelJS.CellValue): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    const o = v as any;
    if ('result' in o) return cellValue(o.result);
    if ('richText' in o) return o.richText.map((r: any) => r.text).join('');
    if ('text' in o) return o.text;
    if (v instanceof Date) return v.getHours() + v.getMinutes() / 60;
    return null;
  }
  return v as any;
}

const num = (v: unknown, fallback?: number): number | undefined => {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'boolean') return v ? 1 : 0;
  let s = String(v).trim();
  const pct = s.endsWith('%');
  if (pct) s = s.slice(0, -1);
  s = s.replace(/\s/g, '');
  if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  return pct ? n / 100 : n;
};
/** fração 0–1 (aceita 85 ou 0,85 ou 85%) */
const frac = (v: unknown, fb?: number): number | undefined => {
  const n = num(v, fb);
  if (n === undefined) return fb;
  return n > 1 ? n / 100 : n;
};

function findSheet(wb: ExcelJS.Workbook, names: string[]): ExcelJS.Worksheet | undefined {
  const set = names.map(norm);
  return wb.worksheets.find((ws) => set.includes(norm(ws.name)));
}

/** lê uma aba como tabela com cabeçalho na 1ª linha não vazia */
function table(ws: ExcelJS.Worksheet): { headers: string[]; rows: Record<string, any>[] } {
  let headerRow = 0;
  const headers: string[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (headerRow) return;
    headerRow = rn;
    row.eachCell({ includeEmpty: true }, (cell, cn) => {
      headers[cn - 1] = norm(cellValue(cell.value));
    });
  });
  const rows: Record<string, any>[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= headerRow) return;
    const rec: Record<string, any> = {};
    let any = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const v = cellValue(row.getCell(i + 1).value);
      if (v !== null && v !== '') any = true;
      rec[h] = v;
    });
    if (any) rows.push(rec);
  });
  return { headers, rows };
}

const pick = (rec: Record<string, any>, ...keys: string[]) => {
  for (const k of keys) if (rec[norm(k)] !== undefined && rec[norm(k)] !== null) return rec[norm(k)];
  return undefined;
};

const DIST_ALIASES: Record<string, DistKind> = {
  constante: 'constant', constant: 'constant', fixo: 'constant', determinístico: 'constant', deterministico: 'constant',
  triangular: 'triangular', tri: 'triangular',
  normal: 'normal', gaussiana: 'normal',
  lognormal: 'lognormal', log_normal: 'lognormal',
  exponencial: 'exponential', exponential: 'exponential', exp: 'exponential',
  uniforme: 'uniform', uniform: 'uniform',
};

function parseDist(kindRaw: unknown, p1: unknown, p2: unknown, p3: unknown, fb: Dist, warn: (m: string) => void, label: string): Dist {
  const kind = DIST_ALIASES[norm(kindRaw)];
  const a = num(p1);
  const b = num(p2);
  const c = num(p3);
  if (!kind || a === undefined) {
    warn(`Operação "${label}": distribuição inválida, usando padrão.`);
    return fb;
  }
  switch (kind) {
    case 'constant':
    case 'exponential':
      return { kind, a };
    case 'triangular': {
      if (b === undefined || c === undefined) {
        warn(`Operação "${label}": triangular requer mín, moda e máx.`);
        return fb;
      }
      const [lo, mid, hi] = [a, b, c].sort((x, y) => x - y);
      return { kind, a: lo, b: mid, c: hi };
    }
    case 'uniform':
      return { kind, a: Math.min(a, b ?? a), b: Math.max(a, b ?? a) };
    case 'normal':
    case 'lognormal':
      return { kind, a, b: b ?? 0 };
  }
}

const PICK_OPS: ['scan' | 'pick' | 'place' | 'delay', string[]][] = [
  ['scan', ['leitura_endereco', 'ler_endereco', 'scan']],
  ['pick', ['pegar_caixa', 'coleta_caixa']],
  ['place', ['colocar_caixa', 'colocar_palete']],
  ['delay', ['furo_reposicao', 'reposicao_furo']],
];

const OPS: [keyof Scenario['ops'], string[]][] = [
  ['unloadPallet', ['descarga_palete', 'descarga', 'unload']],
  ['checkPallet', ['conferencia_palete', 'conferencia']],
  ['putawayPosition', ['guarda_posicao', 'posicionamento', 'putaway']],
  ['loadPallet', ['carga_palete', 'carregamento', 'load']],
  ['pickCarton', ['separacao_caixa', 'picking_caixa', 'picking']],
  ['dockTurnover', ['manobra_doca', 'troca_caminhao']],
  ['packOrder', ['embalagem_pedido', 'embalagem', 'consolidacao']],
  ['triageCarton', ['triagem_caixa', 'triagem']],
];

const ELEMENT_ALIASES: Record<string, LayoutElement['type']> = {
  rack: 'rack', porta_palete: 'rack', porta_paletes: 'rack', estrutura: 'rack',
  doca_entrada: 'dockIn', docain: 'dockIn', doca_recebimento: 'dockIn', dockin: 'dockIn',
  doca_saida: 'dockOut', doca_expedicao: 'dockOut', dockout: 'dockOut',
  esteira: 'conveyor', conveyor: 'conveyor',
  parede: 'wall', wall: 'wall',
  zona: 'zone', area: 'zone', zone: 'zone',
  estacao: 'station', station: 'station',
  estacionamento: 'parking', parking: 'parking',
  rua: 'aisle', corredor: 'aisle', aisle: 'aisle',
  transitorio: 'transit', endereco_transitorio: 'transit', transit: 'transit',
  stage: 'stage', stage_recebimento: 'stage',
  triagem: 'triage', area_triagem: 'triage', triage: 'triage',
  carga_amr: 'charger', carregador: 'charger', carga: 'charger', charger: 'charger',
};

/** hora do dia: 6,5 | "06:30" | "6h30" → 6.5 */
function parseHour(v: unknown): number | undefined {
  const s = String(v ?? '').trim().toLowerCase();
  const m = s.match(/^(\d{1,2})\s*[:h]\s*(\d{0,2})$/);
  if (m) return +m[1] + (m[2] ? +m[2] / 60 : 0);
  const n = num(s);
  return n === undefined ? undefined : n;
}

const ROLE_ALIASES: Record<string, PeopleRole> = {
  empilhadeira: 'forklift', empilhadeiras: 'forklift', empilhadeirista: 'forklift', empilhadeiristas: 'forklift', forklift: 'forklift',
  operario: 'worker', operarios: 'worker', picking: 'worker', worker: 'worker',
  conferente: 'checker', conferentes: 'checker', checker: 'checker',
  paleteira: 'mover', paleteiras: 'mover', transpaleteira: 'mover', transpaleteiras: 'mover', mover: 'mover', operador_paleteira: 'mover',
};
const ROLE_NAMES_PT: Record<PeopleRole, string> = { forklift: 'empilhadeira', worker: 'operario', checker: 'conferente', mover: 'paleteira' };

export async function importWorkbook(buf: ArrayBuffer | Uint8Array): Promise<ImportResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as ArrayBuffer);
  const warnings: string[] = [];
  const found: string[] = [];
  const warn = (m: string) => warnings.push(m);
  const sc = defaultScenario();
  sc.name = 'Planilha importada';
  const gp: Partial<LayoutParams> = {};
  let hasParams = false;

  // ---- Parâmetros ----
  const wsP = findSheet(wb, ['Parametros', 'Parâmetros', 'Parameters', 'Config']);
  if (wsP) {
    found.push('Parâmetros');
    hasParams = true;
    const map: Record<string, any> = {};
    wsP.eachRow({ includeEmpty: false }, (row) => {
      const k = norm(cellValue(row.getCell(1).value));
      if (k) map[k] = cellValue(row.getCell(2).value);
    });
    const g = (k: string) => map[norm(k)];
    const setN = (k: string, f: (v: number) => void, clamp?: [number, number]) => {
      let v = num(g(k));
      if (v === undefined) return;
      if (clamp) v = Math.min(clamp[1], Math.max(clamp[0], v));
      f(v);
    };
    if (g('nome') || g('cenario')) sc.name = String(g('nome') ?? g('cenario'));
    setN('horas_turno', (v) => (sc.shiftHours = v), [1, 24]);
    setN('hora_inicio', (v) => (sc.startHour = Math.floor(v) % 24), [0, 23]);
    setN('dias_simulacao', (v) => (sc.days = Math.round(v)), [1, 60]);
    setN('aquecimento_h', (v) => (sc.warmupHours = v), [0, 72]);
    setN('replicacoes', (v) => (sc.replications = Math.round(v)), [1, 500]);
    setN('semente', (v) => (sc.seed = Math.round(v)));
    const mu = frac(g('meta_utilizacao'));
    if (mu !== undefined) sc.targetUtilization = Math.min(0.99, Math.max(0.1, mu));
    setN('meta_espera_p95_min', (v) => (sc.targetWaitP95Min = v), [0.1, 600]);
    const nsv = frac(g('nivel_servico'));
    if (nsv !== undefined) sc.serviceLevel = Math.min(0.999, Math.max(0.5, nsv));
    setN('paletes_caminhao_entrada_media', (v) => (sc.palletsPerTruckIn.mean = v));
    setN('paletes_caminhao_entrada_desvio', (v) => (sc.palletsPerTruckIn.sd = v));
    setN('paletes_caminhao_entrada_max', (v) => (sc.palletsPerTruckIn.max = v));
    setN('paletes_caminhao_saida_media', (v) => (sc.palletsPerTruckOut.mean = v));
    setN('paletes_caminhao_saida_desvio', (v) => (sc.palletsPerTruckOut.sd = v));
    setN('paletes_caminhao_saida_max', (v) => (sc.palletsPerTruckOut.max = v));
    setN('linhas_por_pedido', (v) => (sc.linesPerOrder.mean = v));
    setN('caixas_por_linha_media', (v) => (sc.cartonsPerLine.mean = v));
    setN('caixas_por_linha_desvio', (v) => (sc.cartonsPerLine.sd = v));
    setN('vel_elevacao_ms', (v) => (sc.liftSpeed = v));
    setN('altura_nivel_m', (v) => (sc.levelHeight = v));
    setN('aceleracao_ms2', (v) => (sc.accel = v));
    setN('espacamento_esteira_m', (v) => (sc.conveyorSpacing = v));
    const oc = frac(g('ocupacao_inicial'));
    if (oc !== undefined) sc.initialOccupancy = Math.min(1, Math.max(0, oc));
    setN('permanencia_dias', (v) => (sc.dwellDays = v));
    setN('fator_demanda', (v) => (sc.demandFactor = v));
    const dp = frac(g('dano_paletes_pct'));
    if (dp !== undefined) sc.receiving.damagePalletPct = Math.min(1, Math.max(0, dp));
    {
      const f = sc.receiving.damagedCartonsFraction;
      const lo = frac(g('dano_fracao_min'), f.a);
      const mo = frac(g('dano_fracao_moda'), f.b);
      const hi = frac(g('dano_fracao_max'), f.c);
      if (g('dano_fracao_min') !== undefined || g('dano_fracao_moda') !== undefined || g('dano_fracao_max') !== undefined) {
        const [a, b, c] = [lo ?? 0.05, mo ?? 0.2, hi ?? 1].map((x) => Math.min(1, Math.max(0, x))).sort((x, y) => x - y);
        sc.receiving.damagedCartonsFraction = { kind: 'triangular', a, b, c };
      }
    }
    setN('dano_fator_conferencia', (v) => (sc.receiving.damagedCheckFactor = Math.max(1, v)));
    setN('triagem_esvaziar_h', (v) => (sc.receiving.triageClearEveryHours = Math.max(0, v)));
    const bau = norm(g('bau_profundidade'));
    if (bau) sc.receiving.trailerDepth = ['s', 'sim', '1', 'true', 'x'].includes(bau);
    const uw = g('descarga_equipamentos');
    if (uw !== undefined && uw !== null && String(uw).trim() !== '') {
      const kinds = [...new Set(String(uw).split(/[;|,]/).map((x) => norm(x)).map((t) => (t.startsWith('empilh') || t.startsWith('forklift') ? 'forklift' : t.startsWith('paletei') ? 'palletJack' : t.startsWith('transpal') ? 'palletTruck' : t.startsWith('amr') ? 'amr' : null)).filter((x): x is EquipmentKind => !!x))];
      if (kinds.length) sc.receiving.unloadWith = kinds;
      else warn('descarga_equipamentos: use empilhadeira, paleteira_manual, transpaleteira e/ou amr.');
    }
    const modo = norm(g('armazenagem_modo'));
    if (modo) sc.storage.mode = modo.startsWith('fas') || modo === 'phased' ? 'phased' : 'direct';
    const s1 = g('armazenagem_etapa1_equipamentos');
    if (s1 !== undefined && s1 !== null && String(s1).trim() !== '') {
      const kinds = [...new Set(String(s1).split(/[;|,]/).map((x) => norm(x)).map((t) => (t.startsWith('paletei') ? 'palletJack' : t.startsWith('transpal') ? 'palletTruck' : t.startsWith('amr') ? 'amr' : t.startsWith('empilh') ? 'forklift' : null)).filter((x): x is EquipmentKind => !!x))];
      if (kinds.length) sc.storage.step1With = kinds;
      else warn('armazenagem_etapa1_equipamentos: use paleteira_manual, transpaleteira e/ou amr.');
    }
    const kindsOf = (t: unknown): EquipmentKind[] => [...new Set(String(t ?? '').split(/[;|,]/).map((x) => norm(x)).map((x) => (x.startsWith('empilh') ? 'forklift' : x.startsWith('paletei') ? 'palletJack' : x.startsWith('transpal') ? 'palletTruck' : x.startsWith('amr') ? 'amr' : null)).filter((x): x is EquipmentKind => !!x))];
    const full = sc.picking.full;
    setN('palete_full_pedidos_hora', (v) => (full.ordersPerHour = Math.max(0, v)));
    setN('palete_full_paletes_media', (v) => (full.palletsPerOrder.mean = Math.max(1, v)));
    setN('palete_full_paletes_desvio', (v) => (full.palletsPerOrder.sd = Math.max(0, v)));
    for (const [k, key] of [['palete_full_curva_a_pct', 'a'], ['palete_full_curva_b_pct', 'b'], ['palete_full_curva_c_pct', 'c']] as const) {
      const f = frac(g(k));
      if (f !== undefined) full.abc[key] = Math.max(0, f);
    }
    const fmode = norm(g('palete_full_modo'));
    if (fmode) full.mode = fmode.startsWith('fas') || fmode === 'phased' ? 'phased' : 'direct';
    const fk = kindsOf(g('palete_full_etapa2_equipamentos'));
    if (fk.length) full.step1With = fk;
    const lf = norm(g('expedicao_origem'));
    if (lf) sc.picking.loadFrom = lf.startsWith('stage') ? 'stage' : 'rack';
    const lw = kindsOf(g('expedicao_equipamentos'));
    if (lw.length) sc.picking.loadWith = lw;
    const em = norm(g('expedicao_modo'));
    if (em) sc.expedition.mode = em.startsWith('etap') || em === 'steps' ? 'steps' : em.startsWith('pad') || em === 'standard' ? 'standard' : 'basic';
    setN('expedicao_paletes_por_carga', (v) => (sc.expedition.palletsPerLoad = Math.max(1, Math.round(v))));
    const ve = norm(g('veiculo_exclusivo'));
    if (ve) sc.vehicleExclusive = ['s', 'sim', '1', 'true', 'x'].includes(ve);
    const am = norm(g('picking_area_modo'));
    if (am) sc.picking.area.mode = am.startsWith('perso') || am.startsWith('custom') ? 'custom' : am.startsWith('face') ? 'faces' : 'floor';
    setN('picking_area_niveis', (v) => (sc.picking.area.levels = Math.max(1, Math.round(v))));
    const aa = g('picking_area_enderecos');
    if (aa !== undefined && aa !== null) sc.picking.area.addresses = parseAddresses(String(aa));
    const sm = norm(g('separacao_modo'));
    if (sm) sc.picking.mode = sm.startsWith('pal') || sm === 'pallet' ? 'pallet' : 'legacy';
    setN('pedido_caixas_media', (v) => (sc.picking.boxesPerOrder.mean = Math.max(1, v)));
    setN('pedido_caixas_desvio', (v) => (sc.picking.boxesPerOrder.sd = Math.max(0, v)));
    for (const [k, key] of [['curva_a_pct', 'a'], ['curva_b_pct', 'b'], ['curva_c_pct', 'c']] as const) {
      const f = frac(g(k));
      if (f !== undefined) sc.picking.abc[key] = Math.max(0, f);
    }
    setN('palete_limite_media', (v) => (sc.picking.palletLimit.mean = Math.max(1, v)));
    setN('palete_limite_desvio', (v) => (sc.picking.palletLimit.sd = Math.max(0, v)));
    const rt = norm(g('rota_separacao'));
    if (rt) sc.picking.route = rt.startsWith('zig') ? 'zigzag' : 'u';
    setN('separadores_por_pedido', (v) => (sc.picking.pickersPerOrder = Math.max(1, Math.round(v))));
    const fm = norm(g('furo_modo'));
    if (fm) sc.picking.stockout.mode = fm.startsWith('pos') ? 'positions' : fm.startsWith('pct') || fm.startsWith('perc') ? 'pct' : 'off';
    const fp = frac(g('furo_pct'));
    if (fp !== undefined) sc.picking.stockout.pct = Math.min(1, Math.max(0, fp));
    const fa = g('furo_enderecos');
    if (fa !== undefined && fa !== null) sc.picking.stockout.addresses = parseAddresses(String(fa));
    const cp = norm(g('processos_personalizados'));
    if (cp) sc.useCustomProcesses = ['s', 'sim', '1', 'true', 'x'].includes(cp);
    setN('limite_espera_doca_min', (v) => (sc.dockWaitThresholdMin = v), [0, 600]);
    const amrBreaks = norm(g('amr_trabalha_intervalos'));
    if (amrBreaks) sc.calendar.amrWorksDuringBreaks = ['s', 'sim', '1', 'true', 'x'].includes(amrBreaks);
    for (const [dir, spec] of [['entrada', sc.arrivalsIn], ['saida', sc.arrivalsOut]] as [string, ArrivalSpec][]) {
      const modo = norm(g(`chegada_${dir}_modo`));
      if (modo) spec.mode = modo.startsWith('interv') || modo === 'fixo' || modo === 'fixed' ? 'fixed' : modo.startsWith('agend') || modo === 'scheduled' ? 'scheduled' : 'poisson';
      setN(`chegada_${dir}_intervalo_min`, (v) => (spec.intervalMin = Math.max(0.1, v)));
      const hs = g(`chegada_${dir}_horarios`);
      if (hs !== undefined && hs !== null && String(hs).trim() !== '') spec.scheduleHours = String(hs).split(/[;|]/).map((x) => parseHour(x)).filter((x): x is number => x !== undefined && x >= 0 && x < 24);
      const dp = frac(g(`atraso_${dir}_prob`));
      if (dp !== undefined) spec.delayProb = Math.min(1, Math.max(0, dp));
      const dm = num(g(`atraso_${dir}_media_min`));
      const ds = num(g(`atraso_${dir}_desvio_min`));
      if (dm !== undefined) spec.delayMin = { kind: 'lognormal', a: Math.max(0.1, dm), b: Math.max(0, ds ?? spec.delayMin.b ?? 0) };
    }
    const pol = norm(g('enderecamento'));
    if (pol) sc.slotting = pol.startsWith('abc') ? 'abc' : pol.startsWith('prox') ? 'nearest' : pol.startsWith('alea') || pol.startsWith('rand') ? 'random' : sc.slotting;
    setN('docas_entrada', (v) => (gp.docksIn = Math.round(v)));
    setN('docas_saida', (v) => (gp.docksOut = Math.round(v)));
    setN('fileiras_rack', (v) => (gp.rackRows = Math.round(v)));
    setN('vaos_por_fileira', (v) => (gp.baysPerRow = Math.round(v)));
    setN('niveis', (v) => (gp.levels = Math.round(v)));
    setN('esteiras', (v) => (gp.conveyors = Math.round(v)));
    setN('estacoes', (v) => (gp.stations = Math.round(v)));
  } else warn('Aba "Parametros" não encontrada – usando valores padrão.');

  // ---- Recursos ----
  const wsR = findSheet(wb, ['Recursos', 'Resources']);
  if (wsR) {
    found.push('Recursos');
    for (const r of table(wsR).rows) {
      const t = norm(pick(r, 'tipo', 'recurso'));
      const eqKind = t.startsWith('empilh') || t.startsWith('forklift') ? 'forklift' : t.startsWith('paletei') || t.includes('palletjack') ? 'palletJack' : t.startsWith('transpal') || t.includes('pallettruck') ? 'palletTruck' : t.startsWith('amr') ? 'amr' : null;
      const spec: FleetSpec | EquipmentSpec | null = eqKind ? (eqKind === 'forklift' ? sc.forklifts : sc.equipment.find((e) => e.kind === eqKind)!) : t.startsWith('oper') || t.startsWith('pick') || t.startsWith('worker') ? sc.workers : t.startsWith('conf') ? sc.checkers : null;
      if (!spec) {
        if (t) warn(`Recurso "${t}" desconhecido (use empilhadeira, paleteira_manual, transpaleteira, amr, operario ou conferente).`);
        continue;
      }
      spec.count = Math.max(0, Math.round(num(pick(r, 'quantidade', 'qtd'), spec.count)!));
      spec.speedEmpty = num(pick(r, 'vel_vazio', 'velocidade_vazio', 'velocidade'), spec.speedEmpty)!;
      spec.speedLoaded = num(pick(r, 'vel_carregado', 'velocidade_carregado'), spec.speedLoaded)!;
      spec.availability = Math.min(1, Math.max(0.05, frac(pick(r, 'disponibilidade', 'disponibilidade_%'), spec.availability)!));
      spec.costPerHour = num(pick(r, 'custo_hora', 'custo_h', 'custo'), spec.costPerHour)!;
      const kg = num(pick(r, 'capacidade_kg', 'carga_kg'));
      if (kg !== undefined) spec.capacityKg = kg;
      if (eqKind) {
        const e = spec as EquipmentSpec;
        e.palletsPerTrip = Math.max(1, Math.round(num(pick(r, 'capacidade_paletes', 'paletes_viagem'), e.palletsPerTrip)!));
        const yes = (k: string, d: boolean) => { const v = norm(pick(r, k)); return v === '' ? d : ['s', 'sim', '1', 'true', 'x'].includes(v); };
        e.canLift = yes('eleva', e.canLift);
        e.needsOperator = yes('operador', e.needsOperator);
        if (eqKind === 'amr' && e.amr) {
          const a = e.amr;
          a.autonomyMin = num(pick(r, 'autonomia_min'), a.autonomyMin)!;
          a.chargeTriggerFraction = frac(pick(r, 'gatilho_carga'), a.chargeTriggerFraction)!;
          a.chargeMin = num(pick(r, 'carga_min'), a.chargeMin)!;
          a.setupMin = num(pick(r, 'setup_min'), a.setupMin)!;
          a.chargeAtShiftStart = yes('carga_inicio_turno', a.chargeAtShiftStart);
          a.chargeAtShiftEnd = yes('carga_fim_turno', a.chargeAtShiftEnd);
          const hs = pick(r, 'carga_horarios');
          if (hs !== undefined && hs !== null && String(hs).trim() !== '') a.chargeAtHours = String(hs).split(/[;|]/).map((x) => num(x.trim().replace('h', ''))).filter((x): x is number => x !== undefined);
        }
      }
    }
    normalizeEquipment(sc);
  } else warn('Aba "Recursos" não encontrada – usando padrão.');

  // ---- Expedição (etapas) ----
  const wsE = findSheet(wb, ['Expedicao', 'Expedição', 'Dispatch']);
  if (wsE) {
    const steps: ExpStep[] = [];
    for (const r of table(wsE).rows) {
      const type = norm(pick(r, 'tipo')) as ExpStepType;
      if (!(type in EXP_LABEL)) {
        if (pick(r, 'tipo')) warn(`Expedicao: tipo de etapa "${pick(r, 'tipo')}" desconhecido.`);
        continue;
      }
      let extra: Record<string, unknown> = {};
      try {
        extra = JSON.parse(String(pick(r, 'parametros') ?? '{}'));
      } catch {
        warn(`Expedicao: parâmetros inválidos na etapa "${pick(r, 'tipo')}".`);
      }
      const ativo = norm(pick(r, 'ativo'));
      const label = pick(r, 'rotulo');
      steps.push({ ...extra, id: String(pick(r, 'etapa_id') ?? `e${steps.length}`), type, enabled: !ativo || ['s', 'sim', '1', 'true', 'x'].includes(ativo), ...(label ? { label: String(label) } : {}) } as unknown as ExpStep);
    }
    if (steps.length) {
      sc.expedition.steps = steps;
      found.push('Expedição');
    }
  }

  // ---- Processos personalizados ----
  const wsPr = findSheet(wb, ['Processos', 'Processes']);
  if (wsPr) {
    const procs = new Map<string, ProcessDef>();
    for (const r of table(wsPr).rows) {
      const pid = String(pick(r, 'processo_id', 'processo') ?? '').trim();
      const type = norm(pick(r, 'tipo')) as StepType;
      if (!pid || !(type in STEP_LABEL)) {
        if (pid) warn(`Processos: tipo de bloco "${pick(r, 'tipo')}" desconhecido.`);
        continue;
      }
      let def = procs.get(pid);
      if (!def) {
        def = { id: pid, name: String(pick(r, 'nome_processo', 'nome') ?? pid), trigger: 'unloadPallet', steps: [] };
        procs.set(pid, def);
      }
      let extra: Record<string, unknown> = {};
      let outs: Record<string, unknown> = {};
      try {
        extra = JSON.parse(String(pick(r, 'parametros') ?? '{}'));
        outs = JSON.parse(String(pick(r, 'saidas') ?? '{}'));
      } catch {
        warn(`Processos: parâmetros inválidos no bloco "${pick(r, 'bloco_id')}" do processo "${pid}".`);
      }
      const label = pick(r, 'rotulo');
      def.steps.push({ ...extra, ...outs, id: String(pick(r, 'bloco_id')), type, x: num(pick(r, 'x'), 0)!, y: num(pick(r, 'y'), 0)!, ...(label ? { label: String(label) } : {}) } as unknown as Step);
    }
    sc.processes = [...procs.values()];
    if (sc.processes.length) found.push('Processos');
  }

  // ---- Veículos ----
  const wsV = findSheet(wb, ['Veiculos', 'Veículos', 'Vehicles']);
  if (wsV) {
    const vs: VehicleType[] = [];
    for (const r of table(wsV).rows) {
      const name = String(pick(r, 'nome', 'tipo') ?? '').trim();
      if (!name) continue;
      const pm = num(pick(r, 'paletes_media'), 12)!;
      vs.push({
        id: `v${vs.length + 1}`, name, share: Math.max(0, frac(pick(r, 'participacao', 'percentual'), 1)!),
        dockTurnover: parseDist(pick(r, 'distribuicao') ?? 'constante', pick(r, 'p1', 'param1') ?? 180, pick(r, 'p2', 'param2'), pick(r, 'p3', 'param3'), sc.ops.dockTurnover, warn, `manobra de ${name}`),
        pallets: { mean: pm, sd: num(pick(r, 'paletes_desvio'), 0)!, max: num(pick(r, 'paletes_max'), Math.max(pm, 1))! },
        trailerLengthM: num(pick(r, 'comprimento_bau_m', 'bau_m'), 14)!,
      });
    }
    if (vs.length) {
      sc.vehicleTypes = vs;
      found.push('Veículos');
    }
  }

  // ---- Intervalos ----
  const wsB = findSheet(wb, ['Intervalos', 'Calendario', 'Calendário', 'Breaks']);
  if (wsB) {
    const bs: BreakSpec[] = [];
    for (const r of table(wsB).rows) {
      const start = parseHour(pick(r, 'inicio', 'inicio_h', 'hora'));
      const dur = num(pick(r, 'duracao_min', 'duracao'));
      if (start === undefined || dur === undefined) continue;
      const grRaw = String(pick(r, 'grupos', 'grupo') ?? '');
      const gr = norm(grRaw);
      const groups = !gr || gr.startsWith('todos') || gr === 'all' ? [...PEOPLE_ROLES] : [...new Set(grRaw.split(/[;|,]/).map((x) => ROLE_ALIASES[norm(x)]).filter(Boolean))];
      if (!groups.length) {
        warn(`Intervalo "${pick(r, 'nome')}": grupos inválidos (use todos, empilhadeira, operario, conferente).`);
        continue;
      }
      const esc = norm(pick(r, 'escalonamento', 'saida'));
      const stagger = esc.startsWith('metade') || esc === 'half' ? 'half' : esc.startsWith('perc') ? 'percent' : 'all';
      bs.push({ name: String(pick(r, 'nome') ?? 'Intervalo'), startHour: start % 24, durationMin: Math.max(0, dur), groups, stagger, percentPerWave: Math.min(100, Math.max(1, num(pick(r, 'percentual', 'percentual_por_vez'), 50)!)) });
    }
    sc.calendar.breaks = bs;
    if (bs.length) found.push('Intervalos');
  }

  // ---- Demanda ----
  const wsD = findSheet(wb, ['Demanda', 'Demand']);
  if (wsD) {
    found.push('Demanda');
    const inb = new Array(24).fill(0);
    const outb = new Array(24).fill(0);
    const ord = new Array(24).fill(0);
    for (const r of table(wsD).rows) {
      const h = num(pick(r, 'hora', 'hour'));
      if (h === undefined || h < 0 || h > 23) continue;
      inb[Math.floor(h)] = num(pick(r, 'caminhoes_entrada', 'entrada', 'caminhoes_recebimento'), 0)!;
      outb[Math.floor(h)] = num(pick(r, 'caminhoes_saida', 'saida', 'caminhoes_expedicao'), 0)!;
      ord[Math.floor(h)] = num(pick(r, 'pedidos', 'pedidos_hora'), 0)!;
    }
    sc.inboundTrucksPerHour = inb;
    sc.outboundTrucksPerHour = outb;
    sc.ordersPerHour = ord;
  } else warn('Aba "Demanda" não encontrada – usando perfil padrão.');

  // ---- Operações ----
  const wsO = findSheet(wb, ['Operacoes', 'Operações', 'Operations', 'Tempos']);
  if (wsO) {
    found.push('Operações');
    for (const r of table(wsO).rows) {
      const name = norm(pick(r, 'operacao', 'nome'));
      const pk = PICK_OPS.find(([, al]) => al.includes(name));
      if (pk) {
        const cur = pk[0] === 'delay' ? sc.picking.stockout.delay : sc.picking[pk[0]];
        const d = parseDist(pick(r, 'distribuicao'), pick(r, 'p1', 'param1'), pick(r, 'p2', 'param2'), pick(r, 'p3', 'param3'), cur, warn, name);
        if (pk[0] === 'delay') sc.picking.stockout.delay = d;
        else sc.picking[pk[0]] = d;
        continue;
      }
      const hit = OPS.find(([, al]) => al.includes(name));
      if (!hit) {
        if (name) warn(`Operação "${name}" desconhecida.`);
        continue;
      }
      sc.ops[hit[0]] = parseDist(pick(r, 'distribuicao'), pick(r, 'p1', 'param1'), pick(r, 'p2', 'param2'), pick(r, 'p3', 'param3'), sc.ops[hit[0]], warn, name);
    }
  } else warn('Aba "Operacoes" não encontrada – usando tempos padrão.');

  // ---- SKUs ----
  const wsS = findSheet(wb, ['SKUs', 'SKU', 'Produtos']);
  if (wsS) {
    found.push('SKUs');
    const skus: SkuSpec[] = [];
    for (const r of table(wsS).rows) {
      const sku = String(pick(r, 'sku', 'codigo') ?? '').trim();
      if (!sku) continue;
      const cls = String(pick(r, 'classe', 'abc') ?? 'C').trim().toUpperCase();
      skus.push({
        sku, description: String(pick(r, 'descricao') ?? ''), cls: cls === 'A' || cls === 'B' ? cls : 'C',
        share: Math.max(0, num(pick(r, 'giro_%', 'giro', 'participacao'), 1)!), cartonsPerPallet: num(pick(r, 'caixas_palete', 'caixas_por_palete'), 50)!,
      });
    }
    if (skus.length) {
      const tot = skus.reduce((s, k) => s + k.share, 0) || 1;
      skus.forEach((k) => (k.share = k.share / tot));
      sc.skus = skus;
    }
  } else warn('Aba "SKUs" não encontrada – curva ABC padrão.');

  // ---- Layout ----
  let layout: Layout | null = null;
  const wsL = findSheet(wb, ['Layout', 'Planta']);
  if (wsL) {
    const els: LayoutElement[] = [];
    for (const r of table(wsL).rows) {
      const type = ELEMENT_ALIASES[norm(pick(r, 'tipo', 'type'))];
      if (!type) {
        warn(`Layout: tipo "${pick(r, 'tipo')}" desconhecido.`);
        continue;
      }
      const length = num(pick(r, 'comprimento', 'compr', 'length'), type === 'rack' ? 30 : type === 'wall' ? 10 : 3.6)!;
      const width = num(pick(r, 'largura', 'profundidade', 'width'), type === 'rack' ? 2.3 : type === 'wall' ? 0.3 : 1)!;
      const bays = num(pick(r, 'vaos', 'baias'));
      const picking = norm(pick(r, 'picking', 'face_picking'));
      els.push({
        id: newId(type), type, name: String(pick(r, 'nome', 'id') ?? type), x: num(pick(r, 'x'), 0)!, z: num(pick(r, 'z', 'y'), 0)!, rot: num(pick(r, 'rot', 'rotacao'), 0)!,
        length, width, bays: bays !== undefined ? Math.round(bays) : type === 'rack' ? Math.max(1, Math.round(length / 2.8)) : undefined,
        levels: type === 'rack' ? Math.round(num(pick(r, 'niveis'), 4)!) : undefined, rows: type === 'rack' ? Math.round(num(pick(r, 'fileiras'), width > 1.6 ? 2 : 1)!) : undefined,
        pickFace: type === 'rack' ? ['s', 'sim', '1', 'true', 'x'].includes(picking) : undefined,
        speed: type === 'conveyor' ? num(pick(r, 'velocidade'), 0.6) : undefined,
        stageKind: type === 'stage' && ['s', 'sim', '1', 'true', 'x'].includes(norm(pick(r, 'stage_saida'))) ? 'out' : undefined,
        aisleFront: type === 'rack' && pick(r, 'rua_frente') ? String(pick(r, 'rua_frente')).trim().toUpperCase() : undefined,
        aisleBack: type === 'rack' && pick(r, 'rua_fundo') ? String(pick(r, 'rua_fundo')).trim().toUpperCase() : undefined,
        capacity: ['transit', 'stage', 'triage', 'charger'].includes(type) && num(pick(r, 'capacidade', 'capacity')) !== undefined ? Math.round(num(pick(r, 'capacidade', 'capacity'))!) : undefined,
        aisle: (type === 'aisle' || type === 'transit') && pick(r, 'rua', 'aisle') ? String(pick(r, 'rua', 'aisle')).trim().toUpperCase() : undefined,
        priority: type === 'triage' && num(pick(r, 'prioridade', 'priority')) !== undefined ? Math.round(num(pick(r, 'prioridade', 'priority'))!) : undefined,
      });
    }
    if (els.length) {
      found.push('Layout');
      let maxX = 0;
      let maxZ = 0;
      for (const e of els) {
        const pts = e.type === 'wall' || e.type === 'conveyor' ? linearEnds(e) : [toWorld(e, -e.length / 2, -e.width / 2), toWorld(e, e.length / 2, -e.width / 2), toWorld(e, e.length / 2, e.width / 2), toWorld(e, -e.length / 2, e.width / 2)];
        for (const p of pts) {
          maxX = Math.max(maxX, p.x);
          maxZ = Math.max(maxZ, p.z);
        }
      }
      layout = { name: 'Layout da planilha', floor: { width: Math.ceil(maxX + 2), depth: Math.ceil(maxZ + 2) }, elements: els };
    }
  }
  if (!layout && hasParams) {
    layout = generateLayout({ ...defaultLayoutParams(), ...gp });
    layout.name = 'Layout gerado dos parâmetros';
    found.push('Layout (gerado automaticamente)');
  }
  sc.replications = Math.max(1, sc.replications);
  return { scenario: sc, layout, warnings, found };
}

/* ------------------------------------------------------------------ */
/*  Exportação: modelo de planilha + resultados                        */
/* ------------------------------------------------------------------ */

const HEADER = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } } } as const;

function styleHeader(ws: ExcelJS.Worksheet) {
  const r = ws.getRow(1);
  r.eachCell((c) => {
    c.font = HEADER.font;
    c.fill = HEADER.fill as any;
  });
}

const distRow = (name: string, d: Dist, desc: string) => {
  const kind = { constant: 'constante', triangular: 'triangular', normal: 'normal', lognormal: 'lognormal', exponential: 'exponencial', uniform: 'uniforme' }[d.kind];
  return [name, kind, d.a, d.b ?? null, d.c ?? null, desc];
};

export async function buildWorkbook(sc: Scenario, layout: Layout | null): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Digital Twin Logístico';

  const info = wb.addWorksheet('Instrucoes');
  info.columns = [{ width: 110 }];
  [
    'DIGITAL TWIN LOGÍSTICO – Planilha de dimensionamento',
    '',
    'Expedicao (etapas da expedição: conferência, batimento, customização, embarque, registro, lacre; Parametros em JSON, edite de preferência na tela), Processos (blocos de ações genéricas: uma linha por bloco; Saidas e Parametros em JSON, editados de preferência no editor visual). Abas: Parametros (chave/valor), Recursos (empilhadeira, paleteira_manual, transpaleteira, amr, operario, conferente; AMR: Autonomia_min, Gatilho_carga, Carga_min, Setup_min, Carga_inicio_turno/fim_turno, Carga_horarios no formato h;h), Veiculos (tipos de veículo), Intervalos (pausas), Demanda (24 linhas), Operacoes (distribuições de tempo em segundos), SKUs (curva ABC) e Layout (opcional).',
    'Veiculos: Manobra/docagem em segundos (Distribuicao + P1..P3, ex.: constante 180 = 3 min); Participacao em % da frota. Sem linhas = um tipo único com os parâmetros gerais. Intervalos: Inicio = hora do dia (12 ou 12:30); Grupos = todos ou empilhadeira;operario;conferente; Escalonamento = todos (juntos) | metade (metade por vez) | percentual (use a coluna Percentual).',
    'Chegadas (Parametros): chegada_entrada_modo / chegada_saida_modo = aleatorio | intervalo | agendado, com intervalo_min, horarios (h;h) e atraso_*_prob/media_min/desvio_min.',
    'Se a aba Layout estiver vazia/ausente, o galpão é gerado a partir dos parâmetros docas_entrada, docas_saida, fileiras_rack, vaos_por_fileira, niveis, esteiras e estacoes.',
    'Distribuições aceitas: constante(a) | triangular(mín, moda, máx) | normal(média, desvio) | lognormal(média, desvio) | exponencial(média) | uniforme(mín, máx).',
    'Layout: X/Z em metros (origem no canto noroeste), Rot em graus (sentido horário). Para parede e esteira (X,Z) é o ponto inicial; demais elementos usam o centro. Tipos de área: rua (Rua = código), endereco_transitorio (Rua, Capacidade), stage, triagem (Capacidade, Prioridade) e carga_amr (Capacidade = vagas). Capacidade vazia = calculada pela área.',
    'Docas: Rot 0 = abertura voltada para o sul (+Z); Rot 180 = voltada para o norte. Porcentagens podem ser escritas como 85 ou 85% ou 0,85.',
  ].forEach((t, i) => {
    const row = info.addRow([t]);
    if (i === 0) row.font = { bold: true, size: 14 };
    row.alignment = { wrapText: true };
  });

  const p = wb.addWorksheet('Parametros');
  p.columns = [{ header: 'Parametro', width: 34 }, { header: 'Valor', width: 16 }, { header: 'Descricao', width: 80 }];
  const rows: [string, any, string][] = [
    ['nome', sc.name, 'Nome do cenário'],
    ['horas_turno', sc.shiftHours, 'Horas operacionais por dia'],
    ['hora_inicio', sc.startHour, 'Hora do dia em que a operação inicia (0–23)'],
    ['dias_simulacao', sc.days, 'Dias operacionais simulados por réplica'],
    ['aquecimento_h', sc.warmupHours, 'Período de aquecimento descartado das estatísticas (h)'],
    ['replicacoes', sc.replications, 'Número de réplicas Monte Carlo'],
    ['semente', sc.seed, 'Semente do gerador aleatório (reprodutibilidade)'],
    ['meta_utilizacao', sc.targetUtilization, 'Utilização máxima desejada (0–1)'],
    ['meta_espera_p95_min', sc.targetWaitP95Min, 'Espera máxima (percentil 95) em fila, em minutos'],
    ['nivel_servico', sc.serviceLevel, 'Nível de serviço para dimensionamento/estoque de segurança'],
    ['paletes_caminhao_entrada_media', sc.palletsPerTruckIn.mean, 'Paletes por caminhão (recebimento) – média'],
    ['paletes_caminhao_entrada_desvio', sc.palletsPerTruckIn.sd, 'Desvio-padrão'],
    ['paletes_caminhao_entrada_max', sc.palletsPerTruckIn.max, 'Capacidade máxima do caminhão'],
    ['paletes_caminhao_saida_media', sc.palletsPerTruckOut.mean, 'Paletes por caminhão (expedição) – média'],
    ['paletes_caminhao_saida_desvio', sc.palletsPerTruckOut.sd, 'Desvio-padrão'],
    ['paletes_caminhao_saida_max', sc.palletsPerTruckOut.max, 'Capacidade máxima do caminhão'],
    ['linhas_por_pedido', sc.linesPerOrder.mean, 'Linhas por pedido (1 + Poisson)'],
    ['caixas_por_linha_media', sc.cartonsPerLine.mean, 'Caixas por linha – média (lognormal)'],
    ['caixas_por_linha_desvio', sc.cartonsPerLine.sd, 'Caixas por linha – desvio'],
    ['vel_elevacao_ms', sc.liftSpeed, 'Velocidade de elevação do garfo (m/s)'],
    ['altura_nivel_m', sc.levelHeight, 'Altura entre níveis do rack (m)'],
    ['aceleracao_ms2', sc.accel, 'Aceleração/desaceleração (m/s²)'],
    ['espacamento_esteira_m', sc.conveyorSpacing, 'Espaçamento entre caixas na esteira (m)'],
    ['ocupacao_inicial', sc.initialOccupancy, 'Ocupação inicial das posições de palete (0–1)'],
    ['permanencia_dias', sc.dwellDays, 'Permanência média do palete no estoque (dias)'],
    ['enderecamento', sc.slotting === 'abc' ? 'abc' : sc.slotting === 'nearest' ? 'proximo' : 'aleatorio', 'abc | proximo | aleatorio'],
    ['fator_demanda', sc.demandFactor, 'Multiplicador global da demanda (sensibilidade)'],
    ['dano_paletes_pct', sc.receiving.damagePalletPct, 'Recebimento: % de paletes avariados (0–1); detectados na conferência'],
    ['dano_fracao_min', sc.receiving.damagedCartonsFraction.a, 'Fração de caixas avariadas num palete avariado – mínimo (0–1)'],
    ['dano_fracao_moda', sc.receiving.damagedCartonsFraction.b ?? 0.2, 'Fração de caixas avariadas – moda'],
    ['dano_fracao_max', sc.receiving.damagedCartonsFraction.c ?? 1, 'Fração de caixas avariadas – máximo (1 = palete inteiro vai para a triagem)'],
    ['dano_fator_conferencia', sc.receiving.damagedCheckFactor, 'Multiplicador do tempo de conferência de um palete avariado (1,5 = +50%)'],
    ['triagem_esvaziar_h', sc.receiving.triageClearEveryHours, 'As áreas de triagem são esvaziadas a cada N horas (0 = nunca)'],
    ['bau_profundidade', sc.receiving.trailerDepth ? 'S' : 'N', 'S = a distância dentro do baú depende do comprimento do veículo'],
    ['descarga_equipamentos', sc.receiving.unloadWith.map((k) => ({ forklift: 'empilhadeira', palletJack: 'paleteira_manual', palletTruck: 'transpaleteira', amr: 'amr' })[k]).join(';'), 'Equipamentos que podem descarregar o baú (o disponível é acionado), separados por ;'],
    ['armazenagem_modo', sc.storage.mode === 'phased' ? 'faseada' : 'direta', 'direta (empilhadeira do stage ao endereço) | faseada (etapa 1 sem elevação até a rua; etapa 2 elevação)'],
    ['armazenagem_etapa1_equipamentos', sc.storage.step1With.map((k) => ({ forklift: 'empilhadeira', palletJack: 'paleteira_manual', palletTruck: 'transpaleteira', amr: 'amr' })[k]).join(';'), 'Faseada: equipamentos da etapa 1, separados por ; (o disponível é acionado)'],
    ['separacao_modo', sc.picking.mode === 'pallet' ? 'palete' : 'legado', 'legado (esteira e embalagem) | palete (rota, leitura de endereço, limite do palete, furos)'],
    ['expedicao_modo', sc.expedition.mode === 'steps' ? 'etapas' : sc.expedition.mode === 'standard' ? 'padrao' : 'basico', 'basico (como antes) | padrao (bloco: conferir, batimento, customizar, embarcar, registrar, lacrar) | etapas (modelo do usuário na aba Expedicao)'],
    ['expedicao_paletes_por_carga', sc.expedition.palletsPerLoad, 'Paletes por carga expedida (cada caminhão de saída expede sempre essa quantidade; formatos padrao e etapas)'],
    ['veiculo_exclusivo', sc.vehicleExclusive ? 'S' : 'N', 'S = um equipamento (ou operário com paleteira) por vez dentro de cada veículo, em recebimento e expedição'],
    ['palete_full_pedidos_hora', sc.picking.full.ordersPerHour, 'Palete full: pedidos por hora (0 = desligado)'],
    ['palete_full_paletes_media', sc.picking.full.palletsPerOrder.mean, 'Palete full: paletes por pedido – média'],
    ['palete_full_paletes_desvio', sc.picking.full.palletsPerOrder.sd, 'Palete full: paletes por pedido – desvio'],
    ['palete_full_curva_a_pct', sc.picking.full.abc.a, 'Palete full: percentual dos paletes da curva A'],
    ['palete_full_curva_b_pct', sc.picking.full.abc.b, 'Palete full: percentual da curva B'],
    ['palete_full_curva_c_pct', sc.picking.full.abc.c, 'Palete full: percentual da curva C'],
    ['palete_full_modo', sc.picking.full.mode === 'phased' ? 'faseada' : 'direta', 'direta (empilhadeira do endereço ao stage) | faseada (empilhadeira baixa na rua; outro equipamento leva ao stage)'],
    ['palete_full_etapa2_equipamentos', sc.picking.full.step1With.map((k) => ({ forklift: 'empilhadeira', palletJack: 'paleteira_manual', palletTruck: 'transpaleteira', amr: 'amr' })[k]).join(';'), 'Palete full faseado: equipamentos que levam da rua ao stage'],
    ['expedicao_origem', sc.picking.loadFrom, 'De onde o caminhão carrega: rack | stage (paletes já separados)'],
    ['expedicao_equipamentos', sc.picking.loadWith.map((k) => ({ forklift: 'empilhadeira', palletJack: 'paleteira_manual', palletTruck: 'transpaleteira', amr: 'amr' })[k]).join(';'), 'Carga a partir do stage: equipamentos que levam o palete ao caminhão'],
    ['picking_area_modo', sc.picking.area.mode === 'custom' ? 'personalizada' : sc.picking.area.mode === 'faces' ? 'faces' : 'chao', 'Área de picking: chao (endereços próximos ao chão) | faces (racks com face de picking) | personalizada (lista de endereços)'],
    ['picking_area_niveis', sc.picking.area.levels, 'Níveis a partir do chão (modos chao e faces)'],
    ['picking_area_enderecos', sc.picking.area.addresses.join(', '), 'Modo personalizada: endereços da área de picking (ex.: A011, B021)'],
    ['pedido_caixas_media', sc.picking.boxesPerOrder.mean, 'Separação por palete: caixas por pedido – média'],
    ['pedido_caixas_desvio', sc.picking.boxesPerOrder.sd, 'Caixas por pedido – desvio'],
    ['curva_a_pct', sc.picking.abc.a, 'Percentual das caixas do pedido que são da curva A'],
    ['curva_b_pct', sc.picking.abc.b, 'Percentual da curva B'],
    ['curva_c_pct', sc.picking.abc.c, 'Percentual da curva C'],
    ['palete_limite_media', sc.picking.palletLimit.mean, 'Limite de caixas por palete de separação – média'],
    ['palete_limite_desvio', sc.picking.palletLimit.sd, 'Limite de caixas por palete – desvio'],
    ['rota_separacao', sc.picking.route === 'zigzag' ? 'zigzag' : 'u', 'u (um lado na ida, o outro na volta) | zigzag (caixa mais próxima, qualquer lado)'],
    ['separadores_por_pedido', sc.picking.pickersPerOrder, 'Separadores por pedido (o pedido é dividido por ruas)'],
    ['furo_modo', sc.picking.stockout.mode === 'positions' ? 'posicoes' : sc.picking.stockout.mode === 'pct' ? 'percentual' : 'off', 'Furo de estoque: off | percentual | posicoes'],
    ['furo_pct', sc.picking.stockout.pct, 'Furo por percentual: probabilidade de o endereço estar vazio ao chegar'],
    ['furo_enderecos', sc.picking.stockout.addresses.join(', '), 'Furo por posições: endereços vazios (ex.: A015, B023)'],
    ['processos_personalizados', sc.useCustomProcesses ? 'S' : 'N', 'S = o primeiro processo da aba Processos conduz cada palete do recebimento (blocos de ações genéricas)'],
    ['limite_espera_doca_min', sc.dockWaitThresholdMin, 'Espera na doca acima da qual o caminhão conta como gargalo (min)'],
    ['amr_trabalha_intervalos', sc.calendar.amrWorksDuringBreaks ? 'S' : 'N', 'S = AMR continuam trabalhando nos intervalos das pessoas'],
    ...(['entrada', 'saida'] as const).flatMap((dir): [string, any, string][] => {
      const a = dir === 'entrada' ? sc.arrivalsIn : sc.arrivalsOut;
      const lbl = dir === 'entrada' ? 'recebimento' : 'expedição';
      return [
        [`chegada_${dir}_modo`, a.mode === 'fixed' ? 'intervalo' : a.mode === 'scheduled' ? 'agendado' : 'aleatorio', `Chegadas (${lbl}): aleatorio (taxa por hora, aba Demanda) | intervalo (a cada X min) | agendado (horários)`],
        [`chegada_${dir}_intervalo_min`, a.intervalMin, `Modo intervalo: minutos entre chegadas (${lbl})`],
        [`chegada_${dir}_horarios`, a.scheduleHours.join(';'), `Modo agendado: horários do dia separados por ; (ex.: 6;6,5;7 ou 06:30;07:00)`],
        [`atraso_${dir}_prob`, a.delayProb, `Probabilidade de atraso (${lbl}); vale para intervalo/agendado`],
        [`atraso_${dir}_media_min`, a.delayMin.a, 'Atraso médio quando atrasado (min, lognormal)'],
        [`atraso_${dir}_desvio_min`, a.delayMin.b ?? 0, 'Desvio-padrão do atraso (min)'],
      ];
    }),
  ];
  if (layout) {
    const cnt = (t: string) => layout.elements.filter((e) => e.type === t).length;
    rows.push(['docas_entrada', cnt('dockIn'), 'Usado apenas se a aba Layout estiver vazia']);
    rows.push(['docas_saida', cnt('dockOut'), '']);
  }
  rows.forEach((r) => p.addRow(r));
  styleHeader(p);

  const ex = wb.addWorksheet('Expedicao');
  ex.columns = ['Ordem', 'Etapa_Id', 'Tipo', 'Ativo', 'Rotulo', 'Parametros'].map((h) => ({ header: h, width: h === 'Parametros' ? 90 : 18 }));
  (sc.expedition?.steps ?? []).forEach((s, i) => {
    const { id: _i, type: _t, enabled: _e, label: _l, ...rest } = s as unknown as Record<string, unknown>;
    void [_i, _t, _e, _l];
    ex.addRow([i + 1, s.id, s.type, s.enabled ? 'S' : 'N', s.label ?? null, JSON.stringify(rest)]);
  });
  styleHeader(ex);

  const pr = wb.addWorksheet('Processos');
  pr.columns = ['Processo_Id', 'Nome_Processo', 'Bloco_Id', 'Tipo', 'X', 'Y', 'Rotulo', 'Saidas', 'Parametros'].map((h) => ({ header: h, width: h === 'Parametros' || h === 'Saidas' ? 60 : 18 }));
  for (const p of sc.processes ?? [])
    for (const s of p.steps) {
      const outs: Record<string, string> = {};
      for (const q of portsOf(s)) {
        const t = (s as unknown as Record<string, string | undefined>)[q.key];
        if (t) outs[q.key] = t;
      }
      const { id: _i, type: _t, x: _x, y: _y, label: _l, next: _n, nextBad: _b, nextNo: _o, extracted: _e, nextNone: _z, ...rest } = s as unknown as Record<string, unknown>;
      void [_i, _t, _x, _y, _l, _n, _b, _o, _e, _z];
      pr.addRow([p.id, p.name, s.id, s.type, Math.round(s.x), Math.round(s.y), s.label ?? null, JSON.stringify(outs), JSON.stringify(rest)]);
    }
  styleHeader(pr);

  const v = wb.addWorksheet('Veiculos');
  v.columns = ['Nome', 'Participacao', 'Distribuicao', 'P1', 'P2', 'P3', 'Paletes_media', 'Paletes_desvio', 'Paletes_max', 'Comprimento_bau_m'].map((h) => ({ header: h, width: 16 }));
  for (const t of sc.vehicleTypes) {
    const d = distRow(t.name, t.dockTurnover, '');
    v.addRow([t.name, t.share, d[1], d[2], d[3], d[4], t.pallets.mean, t.pallets.sd, t.pallets.max, t.trailerLengthM]);
  }
  styleHeader(v);

  const ib = wb.addWorksheet('Intervalos');
  ib.columns = ['Nome', 'Inicio', 'Duracao_min', 'Grupos', 'Escalonamento', 'Percentual'].map((h) => ({ header: h, width: 18 }));
  for (const b of sc.calendar.breaks)
    ib.addRow([b.name, b.startHour, b.durationMin, b.groups.length === PEOPLE_ROLES.length ? 'todos' : b.groups.map((g) => ROLE_NAMES_PT[g]).join(';'), b.stagger === 'half' ? 'metade' : b.stagger === 'percent' ? 'percentual' : 'todos', b.percentPerWave]);
  styleHeader(ib);

  const r = wb.addWorksheet('Recursos');
  r.columns = ['Tipo', 'Quantidade', 'Vel_vazio', 'Vel_carregado', 'Disponibilidade', 'Custo_hora', 'Capacidade_paletes', 'Capacidade_kg', 'Eleva', 'Operador', 'Autonomia_min', 'Gatilho_carga', 'Carga_min', 'Setup_min', 'Carga_inicio_turno', 'Carga_fim_turno', 'Carga_horarios', 'Fonte'].map((h) => ({ header: h, width: h === 'Fonte' ? 60 : 16 }));
  const sn = (b: boolean) => (b ? 'S' : 'N');
  const eqNames: Record<string, string> = { forklift: 'empilhadeira', palletJack: 'paleteira_manual', palletTruck: 'transpaleteira', amr: 'amr' };
  for (const e of [sc.forklifts, ...(sc.equipment ?? [])])
    r.addRow([eqNames[e.kind], e.count, e.speedEmpty, e.speedLoaded, e.availability, e.costPerHour, e.palletsPerTrip, e.capacityKg, sn(e.canLift), sn(e.needsOperator),
      e.amr?.autonomyMin ?? null, e.amr?.chargeTriggerFraction ?? null, e.amr?.chargeMin ?? null, e.amr?.setupMin ?? null, e.amr ? sn(e.amr.chargeAtShiftStart) : null, e.amr ? sn(e.amr.chargeAtShiftEnd) : null, e.amr ? e.amr.chargeAtHours.join(';') : null, e.source ?? null]);
  for (const [t, s] of [['operario', sc.workers], ['conferente', sc.checkers]] as const)
    r.addRow([t, s.count, s.speedEmpty, s.speedLoaded, s.availability, s.costPerHour, null, s.capacityKg ?? null]);
  styleHeader(r);

  const d = wb.addWorksheet('Demanda');
  d.columns = [{ header: 'Hora', width: 8 }, { header: 'Caminhoes_entrada', width: 20 }, { header: 'Caminhoes_saida', width: 18 }, { header: 'Pedidos', width: 12 }];
  for (let h = 0; h < 24; h++) d.addRow([h, +sc.inboundTrucksPerHour[h].toFixed(3), +sc.outboundTrucksPerHour[h].toFixed(3), +sc.ordersPerHour[h].toFixed(3)]);
  styleHeader(d);

  const o = wb.addWorksheet('Operacoes');
  o.columns = [{ header: 'Operacao', width: 22 }, { header: 'Distribuicao', width: 16 }, { header: 'P1', width: 10 }, { header: 'P2', width: 10 }, { header: 'P3', width: 10 }, { header: 'Descricao', width: 60 }];
  o.addRow(distRow('descarga_palete', sc.ops.unloadPallet, 'Retirar palete do caminhão (s)'));
  o.addRow(distRow('conferencia_palete', sc.ops.checkPallet, 'Conferência no recebimento (s) – só se houver conferentes'));
  o.addRow(distRow('guarda_posicao', sc.ops.putawayPosition, 'Posicionamento no rack, além da elevação (s)'));
  o.addRow(distRow('carga_palete', sc.ops.loadPallet, 'Carregar palete no caminhão (s)'));
  o.addRow(distRow('separacao_caixa', sc.ops.pickCarton, 'Separar uma caixa (s)'));
  o.addRow(distRow('manobra_doca', sc.ops.dockTurnover, 'Manobra/troca de caminhão na doca (s)'));
  o.addRow(distRow('embalagem_pedido', sc.ops.packOrder, 'Consolidação do pedido na estação (s)'));
  o.addRow(distRow('leitura_endereco', sc.picking.scan, 'Separação por palete: ler o código do endereço (s)'));
  o.addRow(distRow('pegar_caixa', sc.picking.pick, 'Separação por palete: pegar uma caixa (s)'));
  o.addRow(distRow('colocar_caixa', sc.picking.place, 'Separação por palete: colocar a caixa no palete (s)'));
  o.addRow(distRow('furo_reposicao', sc.picking.stockout.delay, 'Furo de estoque: tempo perdido até a reposição (s)'));
  o.addRow(distRow('triagem_caixa', sc.ops.triageCarton, 'Triagem: mover uma caixa avariada para o palete de avarias (s por caixa)'));
  styleHeader(o);

  const s = wb.addWorksheet('SKUs');
  s.columns = [{ header: 'SKU', width: 14 }, { header: 'Descricao', width: 28 }, { header: 'Classe', width: 8 }, { header: 'Giro_%', width: 10 }, { header: 'Caixas_palete', width: 14 }];
  for (const k of sc.skus) s.addRow([k.sku, k.description, k.cls, +(k.share * 100).toFixed(2), k.cartonsPerPallet]);
  styleHeader(s);

  const l = wb.addWorksheet('Layout');
  l.columns = ['Tipo', 'Nome', 'X', 'Z', 'Rot', 'Comprimento', 'Largura', 'Vaos', 'Niveis', 'Fileiras', 'Picking', 'Velocidade', 'Capacidade', 'Rua', 'Prioridade', 'Rua_frente', 'Rua_fundo', 'Stage_saida'].map((h) => ({ header: h, width: h === 'Nome' ? 30 : 13 }));
  const tname: Record<string, string> = { rack: 'rack', dockIn: 'doca_entrada', dockOut: 'doca_saida', conveyor: 'esteira', wall: 'parede', zone: 'zona', station: 'estacao', parking: 'estacionamento', aisle: 'rua', transit: 'endereco_transitorio', stage: 'stage', triage: 'triagem', charger: 'carga_amr' };
  for (const e of layout?.elements ?? [])
    l.addRow([tname[e.type], e.name, +e.x.toFixed(2), +e.z.toFixed(2), +e.rot.toFixed(1), +e.length.toFixed(2), +e.width.toFixed(2), e.bays ?? null, e.levels ?? null, e.rows ?? null, e.pickFace ? 'S' : null, e.speed ?? null, e.capacity ?? null, e.aisle ?? null, e.priority ?? null, e.aisleFront ?? null, e.aisleBack ?? null, e.stageKind === 'out' ? 'S' : null]);
  styleHeader(l);
  return wb;
}

export async function exportTemplate(sc: Scenario, layout: Layout | null): Promise<ArrayBuffer> {
  const wb = await buildWorkbook(sc, layout);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

export async function exportResults(
  sc: Scenario, res: import('../model/types').ExperimentResult, cap: import('../analysis/capacity').CapacityReport | null,
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const k = wb.addWorksheet('KPIs');
  k.columns = ['Indicador', 'Média', 'Desvio', 'IC95% ±', 'Mín', 'P50', 'P90', 'P95', 'Máx'].map((h) => ({ header: h, width: h === 'Indicador' ? 32 : 12 }));
  for (const [key, st] of Object.entries(res.kpis)) k.addRow([key, st.mean, st.sd, st.ci95, st.min, st.p50, st.p90, st.p95, st.max]);
  styleHeader(k);
  const h = wb.addWorksheet('Horario');
  h.columns = ['Hora', 'Paletes_entrada', 'Paletes_saida', 'Pedidos', 'Util_empilhadeiras', 'Util_operarios', 'Fila_empilhadeiras'].map((x) => ({ header: x, width: 20 }));
  res.hourly.forEach((x) => h.addRow([x.hour, x.palletsIn, x.palletsOut, x.orders, x.utilForklift, x.utilWorker, x.queueForklift]));
  styleHeader(h);
  const vs = wb.addWorksheet('Veiculos');
  vs.columns = ['Tipo', 'Veiculos_por_dia', 'Manobra_media_min', 'Espera_doca_media_min'].map((x) => ({ header: x, width: 24 }));
  res.vehicleStats.forEach((v) => vs.addRow([v.name, v.trucks, v.dockTurnMean, v.dockWaitMean]));
  styleHeader(vs);
  if (cap) {
    const c = wb.addWorksheet('Dimensionamento');
    c.columns = ['Recurso', 'Atual', 'Necessário (média)', 'Necessário (pico)', 'Demanda/h (média)', 'Demanda/h (pico)', 'Capacidade/h', 'ρ média', 'ρ pico', 'Espera P95 pico (min)', 'Obs.'].map((x) => ({ header: x, width: x === 'Obs.' ? 80 : 20 }));
    cap.rows.forEach((r) => c.addRow([r.name, r.current, r.requiredAvg, r.requiredPeak, r.demandPerHourAvg, r.demandPerHourPeak, r.capacityPerHour, r.rhoAvg, r.rhoPeak, r.waitP95MinPeak, r.note]));
    styleHeader(c);
    const st = wb.addWorksheet('Armazenagem');
    st.columns = [{ header: 'Indicador', width: 40 }, { header: 'Valor', width: 16 }];
    Object.entries(cap.storage).forEach(([a, b]) => st.addRow([a, b]));
    styleHeader(st);
  }
  wb.addWorksheet('Cenario').addRow([JSON.stringify(sc)]);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
