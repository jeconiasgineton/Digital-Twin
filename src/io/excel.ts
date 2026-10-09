import ExcelJS from 'exceljs';
import type { Dist, DistKind, Layout, LayoutElement, Scenario, SkuSpec } from '../model/types';
import { defaultScenario } from '../model/defaults';
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

const OPS: [keyof Scenario['ops'], string[]][] = [
  ['unloadPallet', ['descarga_palete', 'descarga', 'unload']],
  ['checkPallet', ['conferencia_palete', 'conferencia']],
  ['putawayPosition', ['guarda_posicao', 'posicionamento', 'putaway']],
  ['loadPallet', ['carga_palete', 'carregamento', 'load']],
  ['pickCarton', ['separacao_caixa', 'picking_caixa', 'picking']],
  ['dockTurnover', ['manobra_doca', 'troca_caminhao']],
  ['packOrder', ['embalagem_pedido', 'embalagem', 'consolidacao']],
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
};

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
      const spec = t.startsWith('empilh') || t.startsWith('forklift') ? sc.forklifts : t.startsWith('oper') || t.startsWith('pick') || t.startsWith('worker') ? sc.workers : t.startsWith('conf') ? sc.checkers : null;
      if (!spec) {
        if (t) warn(`Recurso "${t}" desconhecido (use empilhadeira, operario ou conferente).`);
        continue;
      }
      spec.count = Math.max(0, Math.round(num(pick(r, 'quantidade', 'qtd'), spec.count)!));
      spec.speedEmpty = num(pick(r, 'vel_vazio', 'velocidade_vazio', 'velocidade'), spec.speedEmpty)!;
      spec.speedLoaded = num(pick(r, 'vel_carregado', 'velocidade_carregado'), spec.speedLoaded)!;
      spec.availability = Math.min(1, Math.max(0.05, frac(pick(r, 'disponibilidade', 'disponibilidade_%'), spec.availability)!));
      spec.costPerHour = num(pick(r, 'custo_hora', 'custo_h', 'custo'), spec.costPerHour)!;
    }
  } else warn('Aba "Recursos" não encontrada – usando padrão.');

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
    'Abas: Parametros (chave/valor), Recursos, Demanda (24 linhas), Operacoes (distribuições de tempo em segundos), SKUs (curva ABC) e Layout (opcional).',
    'Se a aba Layout estiver vazia/ausente, o galpão é gerado a partir dos parâmetros docas_entrada, docas_saida, fileiras_rack, vaos_por_fileira, niveis, esteiras e estacoes.',
    'Distribuições aceitas: constante(a) | triangular(mín, moda, máx) | normal(média, desvio) | lognormal(média, desvio) | exponencial(média) | uniforme(mín, máx).',
    'Layout: X/Z em metros (origem no canto noroeste), Rot em graus (sentido horário). Para parede e esteira (X,Z) é o ponto inicial; demais elementos usam o centro.',
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
  ];
  if (layout) {
    const cnt = (t: string) => layout.elements.filter((e) => e.type === t).length;
    rows.push(['docas_entrada', cnt('dockIn'), 'Usado apenas se a aba Layout estiver vazia']);
    rows.push(['docas_saida', cnt('dockOut'), '']);
  }
  rows.forEach((r) => p.addRow(r));
  styleHeader(p);

  const r = wb.addWorksheet('Recursos');
  r.columns = [{ header: 'Tipo', width: 16 }, { header: 'Quantidade', width: 12 }, { header: 'Vel_vazio', width: 12 }, { header: 'Vel_carregado', width: 14 }, { header: 'Disponibilidade', width: 16 }, { header: 'Custo_hora', width: 12 }];
  for (const [t, s] of [['empilhadeira', sc.forklifts], ['operario', sc.workers], ['conferente', sc.checkers]] as const)
    r.addRow([t, s.count, s.speedEmpty, s.speedLoaded, s.availability, s.costPerHour]);
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
  styleHeader(o);

  const s = wb.addWorksheet('SKUs');
  s.columns = [{ header: 'SKU', width: 14 }, { header: 'Descricao', width: 28 }, { header: 'Classe', width: 8 }, { header: 'Giro_%', width: 10 }, { header: 'Caixas_palete', width: 14 }];
  for (const k of sc.skus) s.addRow([k.sku, k.description, k.cls, +(k.share * 100).toFixed(2), k.cartonsPerPallet]);
  styleHeader(s);

  const l = wb.addWorksheet('Layout');
  l.columns = ['Tipo', 'Nome', 'X', 'Z', 'Rot', 'Comprimento', 'Largura', 'Vaos', 'Niveis', 'Fileiras', 'Picking', 'Velocidade'].map((h) => ({ header: h, width: h === 'Nome' ? 30 : 13 }));
  const tname: Record<string, string> = { rack: 'rack', dockIn: 'doca_entrada', dockOut: 'doca_saida', conveyor: 'esteira', wall: 'parede', zone: 'zona', station: 'estacao', parking: 'estacionamento' };
  for (const e of layout?.elements ?? [])
    l.addRow([tname[e.type], e.name, +e.x.toFixed(2), +e.z.toFixed(2), +e.rot.toFixed(1), +e.length.toFixed(2), +e.width.toFixed(2), e.bays ?? null, e.levels ?? null, e.rows ?? null, e.pickFace ? 'S' : null, e.speed ?? null]);
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
