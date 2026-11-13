import type { Dist, EquipmentKind } from './types';

/**
 * Expedição: o que acontece com uma carga (os paletes de um caminhão de saída) entre a separação e a partida.
 * Etapas: conferir, bater com o pedido, customizar paletes, embarcar, registrar e lacrar. Por padrão vem pronta
 * ("padrão"); o usuário pode escolher o formato de etapas configuráveis e montar o próprio modelo.
 */

export type ExpStepType = 'conference' | 'reconcile' | 'customize' | 'board' | 'register' | 'seal' | 'task';
export type ExpPerson = 'checker' | 'worker';

export const EXP_LABEL: Record<ExpStepType, string> = {
  conference: 'Conferir a separação', reconcile: 'Batimento (pedido × separado)', customize: 'Customizar paletes', board: 'Embarcar',
  register: 'Registro documental e sistêmico', seal: 'Lacrar o baú', task: 'Tarefa livre',
};

export const EXP_HELP: Record<ExpStepType, string> = {
  conference: 'O conferente confere os paletes no stage de expedição: simultânea (enquanto a separação acontece) ou depois que a carga está completa. Palete full: tempo fixo; palete de picking: tempo por caixa.',
  reconcile: 'Ao final da separação, o conferente faz o batimento: o que foi separado é o que está no pedido? Pode haver divergência (percentual das cargas) com tempo de correção.',
  customize: 'Operários rearranjam paletes vindos do picking antes do embarque. Você define o percentual de paletes de picking em cada carga e o tempo por palete. O embarque só começa depois.',
  board: 'Leva cada palete do stage ao interior do veículo com os equipamentos permitidos (o disponível é acionado). Um equipamento por vez dentro do baú; carrega do fundo para a porta.',
  register: 'Depois de embarcar todos os paletes, o conferente faz o registro documental e sistêmico.',
  seal: 'O conferente lacra o baú. O motorista pode acompanhar ou não: não afeta o tempo.',
  task: 'Tarefa livre com uma pessoa e um tempo (ex.: fotografar a carga).',
};

interface Base {
  id: string;
  enabled: boolean;
  label?: string;
}
export interface ConferenceStep extends Base {
  type: 'conference';
  /** simultânea: confere cada palete assim que chega ao stage; posterior: confere depois de a carga estar completa */
  timing: 'simultaneous' | 'later';
  resource: ExpPerson;
  /** tempo fixo por palete full (s) */
  fullTime: Dist;
  /** tempo por caixa de um palete de picking (s) */
  perBox: Dist;
}
export interface ReconcileStep extends Base {
  type: 'reconcile';
  resource: ExpPerson;
  time: Dist;
  /** percentual de cargas com divergência (0 = sempre bate) */
  divergencePct: number;
  correctionTime: Dist;
}
export interface CustomizeStep extends Base {
  type: 'customize';
  resource: ExpPerson;
  /** percentual de paletes de picking (que precisam de customização) em cada carga */
  pickPct: number;
  /** tempo por palete customizado (s) */
  time: Dist;
}
export interface BoardStep extends Base {
  type: 'board';
  with: EquipmentKind[];
}
export interface RegisterStep extends Base {
  type: 'register';
  resource: ExpPerson;
  time: Dist;
}
export interface SealStep extends Base {
  type: 'seal';
  resource: ExpPerson;
  time: Dist;
}
export interface TaskStep extends Base {
  type: 'task';
  resource: ExpPerson;
  time: Dist;
}
export type ExpStep = ConferenceStep | ReconcileStep | CustomizeStep | BoardStep | RegisterStep | SealStep | TaskStep;

export interface ExpeditionSpec {
  /** básico: como era (carga do rack ou do stage conforme a separação) · padrão: bloco pronto · etapas: modelo do usuário */
  mode: 'basic' | 'standard' | 'steps';
  /** paletes por carga expedida (um caminhão de saída leva sempre essa quantidade) */
  palletsPerLoad: number;
  steps: ExpStep[];
}

const tri = (a: number, b: number, c: number): Dist => ({ kind: 'triangular', a, b, c });

/**
 * Tempos padrão (premissas). Referências públicas encontradas: verificação manual de palete de 3 a 5 min (fornecedor
 * de visão computacional) e 15 a 45 min por porta em carga paletizada; não há dado público separado para registro e
 * lacre. Por isso os valores abaixo são premissas coerentes com essas faixas e todos são editáveis.
 */
export const EXPEDITION_SOURCE =
  'Premissas: referências públicas indicam 3–5 min por palete na verificação manual (fornecedor) e 15–45 min por porta em carga paletizada; não há dado público separado para registro, lacre e customização. Edite com os tempos da sua operação.';

let seq = 0;
export const newExpId = () => `e${Date.now().toString(36)}${(seq++).toString(36)}`;

export function makeExpStep(type: ExpStepType): ExpStep {
  const id = newExpId();
  switch (type) {
    case 'conference': return { id, type, enabled: true, timing: 'simultaneous', resource: 'checker', fullTime: tri(30, 60, 120), perBox: tri(2, 3, 5) };
    case 'reconcile': return { id, type, enabled: true, resource: 'checker', time: tri(60, 180, 420), divergencePct: 0, correctionTime: tri(300, 600, 1200) };
    case 'customize': return { id, type, enabled: true, resource: 'worker', pickPct: 0.3, time: tri(180, 300, 600) };
    case 'board': return { id, type, enabled: true, with: ['forklift'] };
    case 'register': return { id, type, enabled: true, resource: 'checker', time: tri(120, 300, 600) };
    case 'seal': return { id, type, enabled: true, resource: 'checker', time: tri(60, 120, 240) };
    case 'task': return { id, type, enabled: true, resource: 'worker', time: tri(30, 60, 120), label: 'Tarefa' };
  }
}

/** a ordem do bloco padrão */
export const STANDARD_ORDER: ExpStepType[] = ['conference', 'reconcile', 'customize', 'board', 'register', 'seal'];

export const defaultExpeditionSteps = (): ExpStep[] => STANDARD_ORDER.map(makeExpStep);

export const defaultExpedition = (): ExpeditionSpec => ({ mode: 'basic', palletsPerLoad: 28, steps: defaultExpeditionSteps() });

/**
 * Etapas efetivas: no formato "padrão" a estrutura e a ordem são as do bloco pronto (com os parâmetros que o usuário
 * editou); no formato "etapas configuráveis" vale a lista do usuário, só as ativas.
 */
export function effectiveSteps(e: ExpeditionSpec): ExpStep[] {
  if (e.mode === 'steps') return e.steps.filter((s) => s.enabled);
  return STANDARD_ORDER.map((t) => ({ ...(e.steps.find((s) => s.type === t) ?? makeExpStep(t)), enabled: true }) as ExpStep);
}

export interface ExpIssue {
  level: 'erro' | 'aviso';
  msg: string;
}

export function validateExpedition(e: ExpeditionSpec): ExpIssue[] {
  const out: ExpIssue[] = [];
  if (e.mode === 'basic') return out;
  const steps = effectiveSteps(e);
  const idx = (t: ExpStepType) => steps.findIndex((s) => s.type === t);
  if (e.palletsPerLoad < 1) out.push({ level: 'erro', msg: 'Expedição: a carga precisa ter ao menos 1 palete.' });
  const board = steps.find((s) => s.type === 'board');
  if (!board) out.push({ level: 'erro', msg: 'Expedição sem etapa "Embarcar": nenhuma carga seria embarcada.' });
  else if (board.type === 'board' && board.with.length === 0) out.push({ level: 'erro', msg: 'Expedição: escolha ao menos um equipamento para o embarque.' });
  if (steps.filter((s) => s.type === 'board').length > 1) out.push({ level: 'aviso', msg: 'Expedição com mais de uma etapa "Embarcar": só a primeira é usada.' });
  for (const t of ['conference', 'reconcile', 'customize'] as const) if (idx('board') >= 0 && idx(t) > idx('board')) out.push({ level: 'aviso', msg: `Expedição: "${EXP_LABEL[t]}" vem depois do embarque (a regra é conferir e customizar antes de embarcar).` });
  for (const t of ['register', 'seal'] as const) if (idx('board') >= 0 && idx(t) >= 0 && idx(t) < idx('board')) out.push({ level: 'aviso', msg: `Expedição: "${EXP_LABEL[t]}" vem antes do embarque (a regra é depois de embarcar todos os paletes).` });
  if (idx('seal') >= 0 && idx('register') >= 0 && idx('seal') < idx('register')) out.push({ level: 'aviso', msg: 'Expedição: o lacre vem antes do registro (normalmente o registro é feito antes de lacrar).' });
  for (const s of steps) {
    if (s.type === 'customize' && (s.pickPct < 0 || s.pickPct > 1)) out.push({ level: 'erro', msg: 'Customização: o percentual de paletes de picking deve estar entre 0 e 100%.' });
    if (s.type === 'reconcile' && (s.divergencePct < 0 || s.divergencePct > 1)) out.push({ level: 'erro', msg: 'Batimento: o percentual de divergência deve estar entre 0 e 100%.' });
  }
  return out;
}
