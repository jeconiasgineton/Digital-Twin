import { PROCESS_TEMPLATES, STEP_LABEL, TRIGGER_LABEL, TRIGGER_SHORT, duplicateProcess, validateProcess } from '../model/process';
import type { AppCtx } from './ctx';
import { h, selField } from './dom';
import { openProcessEditor } from './processEditor';

let chosenTemplate = PROCESS_TEMPLATES[1].id;

/** aba "Processos": ativar processos personalizados, escolher modelos e abrir o editor visual */
export function renderProcessPanel(ctx: AppCtx): HTMLElement {
  const sc = ctx.scenario;
  const root = h('div');
  const ch = () => ctx.scenarioChanged();
  const reopen = () => ctx.rerender();

  root.append(
    h('p', { class: 'note' }, 'Combine ações genéricas (movimentar, elevar, recuperar, conferir, separar…) em um fluxo de blocos e setas. Nenhuma ação é "de recebimento" ou "de triagem": o que muda é o item, os locais, os recursos e os tempos.'),
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: sc.useCustomProcesses, onchange: (ev: Event) => { sc.useCustomProcesses = (ev.target as HTMLInputElement).checked; ch(); reopen(); } }),
      'Usar os processos personalizados (recebimento, separação, palete full e expedição)'),
    h('p', { class: 'note' }, sc.useCustomProcesses
      ? 'Ativo: para cada tipo de processo (recebimento, separação por palete, palete full, expedição) vale o primeiro da lista, no lugar do fluxo padrão. Tipos sem processo seguem o fluxo padrão. Processos de separação/palete full entregam ao stage de expedição, então o caminhão passa a carregar a partir do stage.'
      : 'Desligado: vale o fluxo padrão. Os processos abaixo só são usados se você ativar.'),
  );

  const list = sc.processes.map((p, i) => {
    const iss = validateProcess(p);
    const errs = iss.filter((x) => x.level === 'erro').length;
    return h('div', { class: 'card', style: { textAlign: 'left' } },
      h('div', { class: 'row sp' }, h('b', null, `${i + 1}. ${p.name}`), h('span', { class: 'pill' }, TRIGGER_SHORT[p.trigger]), h('span', { class: `pill ${errs ? 'bad' : iss.length ? 'warn' : 'ok'}` }, errs ? `${errs} erro(s)` : iss.length ? `${iss.length} aviso(s)` : 'OK')),
      h('p', { class: 'note' }, `${TRIGGER_LABEL[p.trigger]} · ${p.steps.length} blocos: ${[...new Set(p.steps.map((s) => STEP_LABEL[s.type]))].join(', ')}`),
      h('div', { class: 'row' },
        h('button', { class: 'b pri sm', onclick: () => openProcessEditor(ctx, p, reopen) }, 'Editar (blocos e setas)'),
        h('button', { class: 'b sm', onclick: () => { sc.processes.splice(i + 1, 0, duplicateProcess(p)); ch(); reopen(); } }, 'Duplicar'),
        sc.processes.findIndex((q) => q.trigger === p.trigger) < i ? h('button', { class: 'b sm', title: 'Em cada tipo de processo vale o primeiro da lista', onclick: () => { const [x] = sc.processes.splice(i, 1); sc.processes.splice(sc.processes.findIndex((q) => q.trigger === p.trigger), 0, x); ch(); reopen(); } }, 'Usar este') : null,
        h('button', { class: 'b danger sm', onclick: () => { sc.processes.splice(i, 1); ch(); reopen(); } }, 'Excluir')),
    );
  });
  root.append(h('b', null, 'Processos'), ...(list.length ? list : [h('p', { class: 'note' }, 'Nenhum processo ainda. Crie um a partir de um modelo.')]));

  const tpl = PROCESS_TEMPLATES.find((t) => t.id === chosenTemplate)!;
  root.append(
    h('b', null, 'Novo processo a partir de um modelo'),
    selField('Modelo', () => chosenTemplate, (v) => { chosenTemplate = v; reopen(); }, PROCESS_TEMPLATES.map((t) => [t.id, `${TRIGGER_SHORT[t.trigger]} · ${t.name}`] as [string, string])),
    h('p', { class: 'note' }, tpl.description),
    h('button', { class: 'b', onclick: () => { sc.processes.push(tpl.make(sc)); ch(); reopen(); } }, '+ Criar a partir do modelo'),
    h('p', { class: 'note' }, 'Os modelos já vêm preenchidos com os equipamentos e as avarias da configuração atual. Depois, abra o editor para mudar o que quiser.'),
  );
  return root;
}
