import type { Dist, EquipmentKind, Scenario } from './types';

/**
 * Processos personalizados: o usuário combina ações genéricas (movimentar, elevar, recuperar, conferir, separar…)
 * em um fluxo de blocos e setas. Nenhuma ação é "de recebimento" ou "de triagem": o que muda é o item, o local
 * de origem/destino, os recursos e os tempos.
 */

export type ItemKind = 'pallet' | 'carton' | 'bundle';
export const ITEM_LABEL: Record<ItemKind, string> = { pallet: 'Palete', carton: 'Caixa', bundle: 'Fardo' };

/** equipamentos do catálogo ou pessoas */
export type ResourceKind = EquipmentKind | 'worker' | 'checker';
export const RESOURCE_LABEL: Record<ResourceKind, string> = {
  forklift: 'Empilhadeira', palletJack: 'Paleteira manual', palletTruck: 'Transpaleteira elétrica', amr: 'AMR', worker: 'Operário', checker: 'Conferente',
};
export const RESOURCE_KINDS: ResourceKind[] = ['forklift', 'palletJack', 'palletTruck', 'amr', 'worker', 'checker'];

export type PlaceKind = 'trailer' | 'dock' | 'stage' | 'transit' | 'triage' | 'rack' | 'area' | 'here';
export const PLACE_LABEL: Record<PlaceKind, string> = {
  trailer: 'Dentro do veículo', dock: 'Doca', stage: 'Stage', transit: 'Rua (endereço transitório)', triage: 'Área de triagem',
  rack: 'Endereço no rack', area: 'Área do layout…', here: 'Onde está agora',
};
export interface PlaceRef {
  kind: PlaceKind;
  /** kind = 'area': id do elemento do layout */
  areaId?: string;
}

export type StepType = 'start' | 'move' | 'lift' | 'retrieve' | 'palletize' | 'depalletize' | 'separate' | 'check' | 'decide' | 'address' | 'wait' | 'end';

export const STEP_LABEL: Record<StepType, string> = {
  start: 'Início', move: 'Movimentar', lift: 'Elevar', retrieve: 'Recuperar', palletize: 'Paletizar', depalletize: 'Despaletizar', separate: 'Separar',
  check: 'Conferir', decide: 'Decidir', address: 'Endereçar', wait: 'Aguardar', end: 'Fim',
};

export const STEP_HELP: Record<StepType, string> = {
  start: 'Dispara o processo para cada palete que sai do veículo de recebimento.',
  move: 'Leva o item de um local a outro com os recursos escolhidos (descarga, levar à triagem, etapa 1…).',
  lift: 'Eleva o palete até a posição do endereço (ou retira dela), levando-o do local atual.',
  retrieve: 'Retira caixas/fardos do palete atual e cria um novo item com elas.',
  palletize: 'Agrupa caixas/fardos em um palete.',
  depalletize: 'Desfaz o palete em caixas/fardos.',
  separate: 'Divide o palete por condição: o que está bom segue; o avariado vai para um segundo palete.',
  check: 'Inspeciona o item: tempo de conferência e chance de avaria.',
  decide: 'Escolhe o caminho conforme uma condição (avariado, sorteio, quantidade).',
  address: 'Define o endereço de destino (rua + estante + nível) pela regra de armazenagem.',
  wait: 'Aguarda um tempo.',
  end: 'Encerra o item.',
};

interface Pos {
  id: string;
  x: number;
  y: number;
  label?: string;
}

export interface StartStep extends Pos { type: 'start'; next?: string }
export interface MoveStep extends Pos { type: 'move'; item: ItemKind; from: PlaceRef; to: PlaceRef; with: ResourceKind[]; handling: Dist; next?: string }
export interface LiftStep extends Pos { type: 'lift'; direction: 'put' | 'take'; with: ResourceKind[]; handling: Dist; next?: string }
export interface RetrieveStep extends Pos {
  type: 'retrieve'; item: 'carton' | 'bundle'; quantity: { mode: 'all' | 'count' | 'fraction'; value: number }; with: ResourceKind[]; perItem: Dist;
  next?: string; /** saída: o item retirado */ extracted?: string;
}
export interface PalletizeStep extends Pos { type: 'palletize'; with: ResourceKind[]; perItem: Dist; next?: string }
export interface DepalletizeStep extends Pos { type: 'depalletize'; item: 'carton' | 'bundle'; with: ResourceKind[]; perItem: Dist; next?: string }
export interface SeparateStep extends Pos { type: 'separate'; with: ResourceKind[]; perItem: Dist; next?: string; /** saída: avariados */ nextBad?: string }
export interface CheckStep extends Pos {
  type: 'check'; with: ResourceKind[]; time: Dist; damagePct: number; damagedFraction: Dist; damagedFactor: number; next?: string;
}
export type DecideCondition = 'damaged' | 'wholeDamaged' | 'prob' | 'countAbove';
export interface DecideStep extends Pos { type: 'decide'; condition: DecideCondition; value: number; next?: string; /** saída: não */ nextNo?: string }
export interface AddressStep extends Pos { type: 'address'; mode: 'put' | 'take'; next?: string; /** saída: sem posição */ nextNone?: string }
export interface WaitStep extends Pos { type: 'wait'; time: Dist; next?: string }
export interface EndStep extends Pos { type: 'end' }

export type Step = StartStep | MoveStep | LiftStep | RetrieveStep | PalletizeStep | DepalletizeStep | SeparateStep | CheckStep | DecideStep | AddressStep | WaitStep | EndStep;

export interface ProcessDef {
  id: string;
  name: string;
  /** o que dispara o processo: cada palete que sai do veículo de recebimento */
  trigger: 'unloadPallet';
  steps: Step[];
}

/** portas de saída de um bloco: campo, rótulo */
export interface Port {
  key: 'next' | 'nextBad' | 'nextNo' | 'extracted' | 'nextNone';
  label: string;
}

export function portsOf(s: Step): Port[] {
  switch (s.type) {
    case 'end': return [];
    case 'separate': return [{ key: 'next', label: 'bons' }, { key: 'nextBad', label: 'avariados' }];
    case 'decide': return [{ key: 'next', label: 'sim' }, { key: 'nextNo', label: 'não' }];
    case 'retrieve': return [{ key: 'next', label: 'palete' }, { key: 'extracted', label: 'retirado' }];
    case 'address': return [{ key: 'next', label: 'ok' }, { key: 'nextNone', label: 'sem posição' }];
    default: return [{ key: 'next', label: '' }];
  }
}

export const getPort = (s: Step, key: Port['key']): string | undefined => (s as unknown as Record<string, string | undefined>)[key];
export const setPort = (s: Step, key: Port['key'], to: string | undefined) => { (s as unknown as Record<string, string | undefined>)[key] = to; };

let seq = 0;
export const newStepId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;

const c = (a: number): Dist => ({ kind: 'constant', a });
const tri = (a: number, b: number, d: number): Dist => ({ kind: 'triangular', a, b, c: d });

/** bloco novo com valores padrão sensatos */
export function makeStep(type: StepType, x = 0, y = 0, sc?: Scenario): Step {
  const id = newStepId();
  const base = { id, x, y };
  const unload = sc?.ops.unloadPallet ?? tri(35, 55, 95);
  switch (type) {
    case 'start': return { ...base, type, next: undefined };
    case 'move': return { ...base, type, item: 'pallet', from: { kind: 'here' }, to: { kind: 'stage' }, with: ['forklift'], handling: unload };
    case 'lift': return { ...base, type, direction: 'put', with: ['forklift'], handling: sc?.ops.putawayPosition ?? tri(25, 40, 80) };
    case 'retrieve': return { ...base, type, item: 'carton', quantity: { mode: 'all', value: 1 }, with: ['worker'], perItem: sc?.ops.pickCarton ?? tri(6, 9, 16) };
    case 'palletize': return { ...base, type, with: ['worker'], perItem: c(8) };
    case 'depalletize': return { ...base, type, item: 'carton', with: ['worker'], perItem: c(8) };
    case 'separate': return { ...base, type, with: ['checker'], perItem: sc?.ops.triageCarton ?? c(8) };
    case 'check': return {
      ...base, type, with: ['checker'], time: sc?.ops.checkPallet ?? tri(30, 45, 90), damagePct: sc?.receiving.damagePalletPct ?? 0.03,
      damagedFraction: sc?.receiving.damagedCartonsFraction ?? tri(0.05, 0.2, 1), damagedFactor: sc?.receiving.damagedCheckFactor ?? 1.5,
    };
    case 'decide': return { ...base, type, condition: 'damaged', value: 0.5 };
    case 'address': return { ...base, type, mode: 'put' };
    case 'wait': return { ...base, type, time: c(30) };
    case 'end': return { ...base, type };
  }
}

/* ----------------------------------------------------------------- grafo */

export function stepById(p: ProcessDef, id: string | undefined): Step | undefined {
  return id ? p.steps.find((s) => s.id === id) : undefined;
}

export function connect(p: ProcessDef, fromId: string, port: Port['key'], toId: string | undefined) {
  const s = stepById(p, fromId);
  if (!s || !portsOf(s).some((q) => q.key === port)) return false;
  if (toId && (!stepById(p, toId) || toId === fromId)) return false;
  const target = stepById(p, toId);
  if (target?.type === 'start') return false; // ninguém aponta para o início
  setPort(s, port, toId);
  return true;
}

export function removeStep(p: ProcessDef, id: string) {
  p.steps = p.steps.filter((s) => s.id !== id);
  for (const s of p.steps) for (const q of portsOf(s)) if (getPort(s, q.key) === id) setPort(s, q.key, undefined);
}

export function addStep(p: ProcessDef, type: StepType, x: number, y: number, sc?: Scenario): Step {
  const s = makeStep(type, x, y, sc);
  p.steps.push(s);
  return s;
}

/** itens alcançáveis a partir do início */
export function reachable(p: ProcessDef): Set<string> {
  const seen = new Set<string>();
  const start = p.steps.find((s) => s.type === 'start');
  const stack = start ? [start.id] : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const s = stepById(p, id);
    if (s) for (const q of portsOf(s)) {
      const t = getPort(s, q.key);
      if (t) stack.push(t);
    }
  }
  return seen;
}

export interface ProcessIssue {
  level: 'erro' | 'aviso';
  msg: string;
  stepId?: string;
}

export function validateProcess(p: ProcessDef): ProcessIssue[] {
  const out: ProcessIssue[] = [];
  const starts = p.steps.filter((s) => s.type === 'start');
  if (starts.length !== 1) out.push({ level: 'erro', msg: starts.length ? 'O processo tem mais de um bloco Início.' : 'O processo não tem bloco Início.' });
  const start = starts[0];
  if (start && !getPort(start, 'next')) out.push({ level: 'erro', msg: 'O bloco Início não está ligado a nenhum bloco.', stepId: start.id });
  const reach = reachable(p);
  for (const s of p.steps) {
    const name = s.label || STEP_LABEL[s.type];
    if (!reach.has(s.id)) out.push({ level: 'aviso', msg: `"${name}" não é alcançado a partir do Início.`, stepId: s.id });
    for (const q of portsOf(s)) {
      if (getPort(s, q.key)) continue;
      // saídas opcionais: o que sobra termina o item
      const optional = (q.key === 'nextNone' || q.key === 'extracted' || q.key === 'nextBad') ;
      out.push({ level: optional ? 'aviso' : 'erro', msg: `"${name}": a saída ${q.label ? `"${q.label}" ` : ''}não está ligada${optional ? ' (o item será encerrado ali)' : ''}.`, stepId: s.id });
    }
    if (s.type === 'move' && s.with.length === 0) out.push({ level: 'erro', msg: `"${name}": escolha ao menos um recurso.`, stepId: s.id });
    if ((s.type === 'lift' || s.type === 'check' || s.type === 'separate' || s.type === 'retrieve' || s.type === 'palletize' || s.type === 'depalletize') && s.with.length === 0) out.push({ level: 'erro', msg: `"${name}": escolha ao menos um recurso.`, stepId: s.id });
    if (s.type === 'move' && s.to.kind === 'area' && !s.to.areaId) out.push({ level: 'erro', msg: `"${name}": escolha a área de destino.`, stepId: s.id });
    if (s.type === 'move' && s.item === 'pallet' && s.with.some((r) => r === 'worker' || r === 'checker') && s.with.length === s.with.filter((r) => r === 'worker' || r === 'checker').length)
      out.push({ level: 'aviso', msg: `"${name}": palete movimentado só por pessoas (sem equipamento).`, stepId: s.id });
  }
  if (!p.steps.some((s) => s.type === 'end')) out.push({ level: 'aviso', msg: 'O processo não tem bloco Fim (itens sem saída são encerrados no último bloco).' });
  // o primeiro movimento deve tirar o palete do veículo, senão o caminhão nunca é liberado
  const first = start ? stepById(p, getPort(start, 'next')) : undefined;
  if (first && !(first.type === 'move' && first.from.kind === 'trailer')) out.push({ level: 'aviso', msg: 'O primeiro bloco deveria ser "Movimentar" saindo de "Dentro do veículo": é ele que libera o caminhão.', stepId: first.id });
  return out;
}

/* ---------------------------------------------------------------- modelos */

function build(name: string, make: (add: <T extends StepType>(t: T, x: number, y: number) => Step) => void, sc?: Scenario): ProcessDef {
  const p: ProcessDef = { id: `p${Date.now().toString(36)}${(seq++).toString(36)}`, name, trigger: 'unloadPallet', steps: [] };
  make((t, x, y) => addStep(p, t, x, y, sc));
  return p;
}

const link = (a: Step, b: Step, port: Port['key'] = 'next') => setPort(a, port, b.id);

export interface ProcessTemplate {
  id: string;
  name: string;
  description: string;
  make: (sc?: Scenario) => ProcessDef;
}

/** recursos que podem descarregar, conforme a configuração do recebimento */
const unloadWith = (sc?: Scenario): ResourceKind[] => (sc?.receiving.unloadWith.length ? [...sc.receiving.unloadWith] : ['forklift']);
const moversOnly = (sc?: Scenario): ResourceKind[] => {
  const k = (sc?.storage.step1With ?? ['palletTruck', 'palletJack', 'amr']).filter((x) => x !== 'forklift');
  return k.length ? k : ['palletTruck', 'palletJack', 'amr'];
};
const triageWith: ResourceKind[] = ['palletJack', 'palletTruck', 'amr', 'forklift'];

export const PROCESS_TEMPLATES: ProcessTemplate[] = [
  {
    id: 'rec-direto',
    name: 'Recebimento direto (sem conferência)',
    description: 'Descarrega o palete na doca, define o endereço e a empilhadeira o guarda.',
    make: (sc) => build('Recebimento direto', (add) => {
      const s = add('start', 40, 40);
      const m = add('move', 40, 150) as MoveStep;
      m.from = { kind: 'trailer' };
      m.to = { kind: 'dock' };
      m.with = unloadWith(sc);
      const a = add('address', 40, 280);
      const l = add('lift', 40, 400);
      const e = add('end', 40, 520);
      link(s, m); link(m, a); link(a, l); link(l, e);
      link(a, e, 'nextNone');
    }, sc),
  },
  {
    id: 'rec-conf-direta',
    name: 'Recebimento com conferência e triagem (armazenagem direta)',
    description: 'Descarrega no stage, confere, separa as caixas avariadas em outro palete (levado à triagem) e guarda o palete bom.',
    make: (sc) => build('Recebimento com conferência', (add) => {
      const s = add('start', 40, 40);
      const m1 = add('move', 40, 150) as MoveStep;
      m1.from = { kind: 'trailer' }; m1.to = { kind: 'stage' }; m1.with = unloadWith(sc);
      const ck = add('check', 40, 280);
      const sp = add('separate', 40, 410);
      const ad = add('address', 40, 540);
      const lf = add('lift', 40, 660);
      const e1 = add('end', 40, 780);
      const m2 = add('move', 330, 540) as MoveStep;
      m2.from = { kind: 'here' }; m2.to = { kind: 'triage' }; m2.with = triageWith; m2.handling = { kind: 'constant', a: 0 };
      const e2 = add('end', 330, 680);
      link(s, m1); link(m1, ck); link(ck, sp); link(sp, ad); link(ad, lf); link(lf, e1); link(ad, e1, 'nextNone');
      link(sp, m2, 'nextBad'); link(m2, e2);
    }, sc),
  },
  {
    id: 'rec-conf-faseada',
    name: 'Recebimento com conferência e triagem (armazenagem faseada)',
    description: 'Como o anterior, mas o palete bom vai primeiro à rua do destino (etapa 1, sem elevação) e depois a empilhadeira eleva (etapa 2).',
    make: (sc) => build('Recebimento faseado', (add) => {
      const s = add('start', 40, 40);
      const m1 = add('move', 40, 150) as MoveStep;
      m1.from = { kind: 'trailer' }; m1.to = { kind: 'stage' }; m1.with = unloadWith(sc);
      const ck = add('check', 40, 280);
      const sp = add('separate', 40, 410);
      const ad = add('address', 40, 540);
      const m3 = add('move', 40, 660) as MoveStep;
      m3.from = { kind: 'here' }; m3.to = { kind: 'transit' }; m3.with = moversOnly(sc); m3.handling = { kind: 'constant', a: 0 };
      const lf = add('lift', 40, 790);
      const e1 = add('end', 40, 910);
      const m2 = add('move', 330, 540) as MoveStep;
      m2.from = { kind: 'here' }; m2.to = { kind: 'triage' }; m2.with = triageWith; m2.handling = { kind: 'constant', a: 0 };
      const e2 = add('end', 330, 680);
      link(s, m1); link(m1, ck); link(ck, sp); link(sp, ad); link(ad, m3); link(m3, lf); link(lf, e1); link(ad, e1, 'nextNone');
      link(sp, m2, 'nextBad'); link(m2, e2);
    }, sc),
  },
];

export const templateById = (id: string) => PROCESS_TEMPLATES.find((t) => t.id === id);

export function duplicateProcess(p: ProcessDef): ProcessDef {
  return JSON.parse(JSON.stringify({ ...p, id: `p${Date.now().toString(36)}${(seq++).toString(36)}`, name: `${p.name} (cópia)` })) as ProcessDef;
}

/** organiza os blocos em camadas a partir do Início (da esquerda/cima para baixo); blocos soltos vão para o fim */
export function autoLayout(p: ProcessDef, dx = 260, dy = 130, x0 = 40, y0 = 40) {
  const depth = new Map<string, number>();
  const start = p.steps.find((s) => s.type === 'start');
  const queue: string[] = start ? [start.id] : [];
  if (start) depth.set(start.id, 0);
  while (queue.length) {
    const id = queue.shift()!;
    const s = stepById(p, id)!;
    for (const q of portsOf(s)) {
      const t = getPort(s, q.key);
      if (t && !depth.has(t)) {
        depth.set(t, depth.get(id)! + 1);
        queue.push(t);
      }
    }
  }
  const maxD = Math.max(0, ...depth.values());
  const col = new Map<number, number>();
  for (const s of p.steps) {
    const d = depth.get(s.id) ?? maxD + 1;
    const c = col.get(d) ?? 0;
    col.set(d, c + 1);
    s.x = x0 + c * dx;
    s.y = y0 + d * dy;
  }
}

export const STEP_COLOR: Record<StepType, string> = {
  start: '#34d399', end: '#94a3b8', move: '#38bdf8', lift: '#a78bfa', retrieve: '#f59e0b', palletize: '#fb923c', depalletize: '#fb923c',
  separate: '#f472b6', check: '#facc15', decide: '#60a5fa', address: '#2dd4bf', wait: '#cbd5e1',
};
