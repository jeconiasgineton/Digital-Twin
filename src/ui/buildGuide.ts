import { SimModel } from '../sim/model';
import { validate } from '../sim/world';
import type { AppCtx } from './ctx';
import { h, fmt, toast as toastFn } from './dom';

/**
 * "Montagem do modelo": guia para construir um galpão do zero, passo a passo.
 * Cada passo mostra se já está feito (calculado do modelo atual) e leva à aba onde se faz.
 * "Testar agora" roda 1 dia simulado com o que já existe e mostra o que aconteceu.
 */
type Status = 'ok' | 'falta' | 'opcional';

interface Step {
  title: string;
  help: string;
  status: (ctx: AppCtx) => Status;
  /** texto do botão e o que ele faz de fato (ativa a ferramenta, leva ao campo ou à aba) */
  go: string;
  act: (ctx: AppCtx) => void;
}

/** ativa uma ferramenta de desenho e avisa como usá-la */
const tool = (t: Parameters<AppCtx['editor']['setTool']>[0], msg: string) => (ctx: AppCtx) => {
  ctx.openTab('layout');
  ctx.editor.setTool(t);
  toastFn(msg);
};
/** leva o foco para o topo do painel de Layout (onde ficam o nome e o tamanho do galpão) */
const toTopOfLayout = (ctx: AppCtx) => {
  ctx.openTab('layout');
  document.getElementById('panel')?.scrollTo({ top: 0, behavior: 'smooth' });
};
const toDataTab = (ctx: AppCtx) => ctx.openTab('data');

const count = (ctx: AppCtx, type: string) => ctx.layout.elements.filter((e) => e.type === type).length;
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const equipUnits = (ctx: AppCtx) => ctx.scenario.forklifts.count + ctx.scenario.equipment.reduce((n, e) => n + e.count, 0);

const STEPS: Step[] = [
  {
    title: '1. Galpão (área do piso)',
    help: 'Defina o piso e o nome do galpão. A aba Layout tem a largura e a profundidade do piso.',
    status: (ctx) => (ctx.layout.floor.width >= 10 && ctx.layout.floor.depth >= 10 ? 'ok' : 'falta'),
    go: 'Definir tamanho do galpão', act: toTopOfLayout,
  },
  {
    title: '2. Docas de entrada',
    help: 'Pelo menos uma doca de entrada para os caminhões chegarem. Depois de clicar no botão, clique na planta para colocar a doca.',
    status: (ctx) => (count(ctx, 'dockIn') >= 1 ? 'ok' : 'falta'),
    go: 'Ativar a ferramenta Doca de entrada', act: tool('dockIn', 'Clique na planta para colocar a doca de entrada.'),
  },
  {
    title: '3. Chegada de caminhões',
    help: 'Quantos caminhões chegam por hora e quantos paletes trazem. Na aba Dados, seção "Demanda por hora" e "Veículos e chegadas".',
    status: (ctx) => (sum(ctx.scenario.inboundTrucksPerHour) > 0 ? 'ok' : 'falta'),
    go: 'Ir para Dados (chegadas)', act: toDataTab,
  },
  {
    title: '4. Equipamentos',
    help: 'Empilhadeiras e demais equipamentos que descarregam e guardam. Na aba Dados, seção "Equipamentos (catálogo)".',
    status: (ctx) => (equipUnits(ctx) > 0 ? 'ok' : 'falta'),
    go: 'Ir para Dados (equipamentos)', act: toDataTab,
  },
  {
    title: '5. Racks (armazenagem)',
    help: 'Onde os paletes ficam guardados. Use a ferramenta "Rack" para desenhar os porta-paletes.',
    status: (ctx) => (count(ctx, 'rack') >= 1 ? 'ok' : 'falta'),
    go: 'Ativar a ferramenta Rack', act: tool('rack', 'Clique e arraste na planta para desenhar o rack.'),
  },
  {
    title: '6. Saída e expedição (opcional)',
    help: 'Docas de saída, caminhões de saída e pedidos. Pode ser feito depois do teste de descarga.',
    status: (ctx) => (count(ctx, 'dockOut') >= 1 && sum(ctx.scenario.outboundTrucksPerHour) > 0 ? 'ok' : 'opcional'),
    go: 'Ativar a ferramenta Doca de saída', act: tool('dockOut', 'Clique na planta para colocar a doca de saída.'),
  },
];

const ICON: Record<Status, string> = { ok: '✅', falta: '⬜', opcional: '➖' };
const LABEL: Record<Status, string> = { ok: 'feito', falta: 'falta', opcional: 'opcional' };

export function renderBuildGuide(ctx: AppCtx): HTMLElement {
  const root = h('div', { class: 'build' });
  const statuses = STEPS.map((s) => s.status(ctx));
  const done = statuses.filter((s) => s === 'ok').length;
  const required = statuses.filter((s) => s !== 'opcional').length;

  // resultado do último teste (fica na tela até o próximo teste ou a próxima mudança de aba)
  const result = h('div', { class: 'build-result' });
  const runTest = () => {
    result.replaceChildren(h('p', { class: 'note' }, 'Simulando 1 dia com o que já existe…'));
    setTimeout(() => {
      try {
        const sc = JSON.parse(JSON.stringify(ctx.scenario));
        sc.days = 1;
        sc.warmupHours = 0;
        sc.replications = 1;
        const k = new SimModel(sc, ctx.layout, sc.seed).runAll().kpis;
        const issues = validate(ctx.layout, ctx.scenario).filter((i) => i.level === 'erro');
        const lines: [string, string][] = [
          ['Caminhões de entrada', fmt(k.trucksInPerDay, 1)],
          ['Paletes recebidos', fmt(k.palletsInPerDay, 1)],
          ['Empilhadeiras ocupadas', `${fmt(k.utilForklift * 100, 0)}%`],
          ['Paletes expedidos por dia', fmt(k.palletsOutPerDay, 1)],
          ['Caminhões de saída', fmt(k.trucksOutPerDay, 1)],
          ['Pedidos atendidos', fmt(k.ordersPerDay, 0)],
        ];
        const gotPallets = k.palletsInPerDay > 0;
        result.replaceChildren(
          h('b', null, gotPallets ? 'Teste de 1 dia concluído: a descarga funcionou.' : 'Teste de 1 dia concluído, mas nenhum palete foi recebido.'),
          h('table', null, h('tbody', null, lines.map(([a, b]) => h('tr', null, h('td', null, a), h('td', { style: { textAlign: 'right' } }, b))))),
          issues.length ? h('ul', { class: 'issues' }, issues.map((i) => h('li', { class: 'err' }, `⛔ ${i.msg}`))) : h('p', { class: 'note' }, 'Nenhum erro de validação.'),
          ...(gotPallets ? [] : [h('p', { class: 'note' }, 'Verifique se há docas de entrada, chegadas de caminhões e equipamentos com quantidade maior que 0.')]),
        );
      } catch (e) {
        result.replaceChildren(h('p', { class: 'note' }, `Não foi possível simular: ${(e as Error).message}`));
      }
    }, 20);
  };

  root.append(
    h('div', { class: 'row sp' },
      h('b', null, `Montagem do modelo · ${done} de ${STEPS.length} passos feitos`),
      h('span', { class: `pill ${done >= required ? 'ok' : 'warn'}` }, done >= required ? 'pronto para testar' : `faltam ${required - done}`)),
    h('div', { class: 'build-steps' }, STEPS.map((s, i) => {
      const st = statuses[i];
      return h('div', { class: `build-step ${st}` },
        h('div', { class: 'row sp' },
          h('span', null, `${ICON[st]} ${s.title}`),
          h('span', { class: 'note' }, LABEL[st])),
        h('p', { class: 'note' }, s.help),
        h('button', { class: 'b sm', onclick: () => s.act(ctx) }, s.go),
      );
    })),
    h('div', { class: 'row' },
      h('button', { class: 'b pri', onclick: runTest }, '▶ Testar agora (1 dia simulado)'),
      h('span', { class: 'note' }, 'Roda com o que já existe, sem esperar o Monte Carlo.')),
    result,
  );
  return root;
}
