import type { AppCtx } from './ctx';
import { fmt, h, pct } from './dom';
import { validate } from '../sim/world';

/** Aba "Simulação": opções visuais e indicadores instantâneos (atualizados em tempo real). */
export function renderSimPanel(ctx: AppCtx): { el: HTMLElement; update: () => void } {
  const root = h('div');
  const issues = validate(ctx.layout, ctx.scenario);
  const rows: Record<string, HTMLElement> = {};
  const bar = (key: string) => {
    const fill = h('div', { style: { width: '0%', height: '100%', background: 'var(--acc)', borderRadius: '4px', transition: 'width .3s' } });
    const wrap = h('div', { style: { height: '8px', background: 'var(--bg3)', borderRadius: '4px', overflow: 'hidden', margin: '3px 0 8px' } }, fill);
    rows[key] = fill;
    return wrap;
  };
  const val = (key: string) => (rows[key] = h('b', null, '–'));

  if (issues.length) root.append(
    h('ul', { class: 'issues' }, issues.map((i) => h('li', { class: i.level === 'erro' ? 'err' : '' }, `${i.level === 'erro' ? '⛔' : '⚠️'} ${i.msg}`))));
  root.append(
    h('details', { open: true }, h('summary', null, 'Indicadores ao vivo'), h('div', { class: 'body' },
      h('div', { class: 'row sp' }, h('span', null, 'Empilhadeiras ocupadas'), val('fkBusy')),
      bar('fkUtil'),
      h('div', { class: 'row sp' }, h('span', null, 'Operários ocupados'), val('wkBusy')),
      bar('wkUtil'),
      h('div', { class: 'row sp' }, h('span', null, 'Ocupação do estoque'), val('occ')),
      bar('occBar'),
      h('div', { class: 'row sp' }, h('span', null, 'Fila de paletes (empilhadeiras)'), val('qFk')),
      h('div', { class: 'row sp' }, h('span', null, 'Fila de pedidos (picking)'), val('qWk')),
      h('div', { class: 'row sp' }, h('span', null, 'Caminhões aguardando doca (ent./saída)'), val('qDock')),
      h('div', { class: 'row sp' }, h('span', null, 'Paletes guardados / expedidos'), val('pallets')),
      h('div', { class: 'row sp' }, h('span', null, 'Pedidos concluídos'), val('orders')),
      h('div', { class: 'row sp' }, h('span', null, 'Rupturas / falta de posição'), val('exc')),
      h('p', { class: 'note' }, 'A simulação ao vivo executa o mesmo motor estocástico usado no Monte Carlo (uma réplica). Mude a semente na aba Dados para ver outra realização.'),
    )),
    h('details', { open: true }, h('summary', null, 'Visualização'), h('div', { class: 'body' },
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: ctx.playback.heatOn, onchange: (e: Event) => ctx.playback.setHeat((e.target as HTMLInputElement).checked) }), 'Mapa de calor de tráfego (acumulado)'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: ctx.view.showLabels, onchange: (e: Event) => ctx.view.setLabels((e.target as HTMLInputElement).checked) }), 'Rótulos dos elementos'),
      h('label', { class: 'f' }, h('span', null, 'Transparência das paredes'), (() => { const i = h('input', { type: 'range', min: '0.05', max: '1', step: '0.05', value: String(ctx.view.wallOpacity) }); i.addEventListener('input', () => ctx.view.setWallOpacity(parseFloat(i.value))); return i; })()),
      h('div', { class: 'row' },
        h('button', { class: 'b', onclick: () => { const a = h('a', { href: ctx.view.screenshot(), download: 'digital-twin.png' }); a.click(); } }, '📷 Capturar imagem'),
        h('button', { class: 'b', onclick: () => ctx.playback.reset(ctx.scenario, ctx.layout) }, '↺ Reiniciar simulação'),
      ),
    )),
  );

  const update = () => {
    const m = ctx.playback.model;
    if (!m) return;
    const s = m.snapshot();
    const set = (k: string, t: string) => rows[k] && (rows[k].textContent = t);
    set('fkBusy', `${s.forkliftsBusy} / ${ctx.scenario.forklifts.count}`);
    set('wkBusy', `${s.workersBusy} / ${ctx.scenario.workers.count}`);
    set('occ', pct(s.occupancy));
    set('qFk', String(s.queueForklift));
    set('qWk', String(s.queueWorker));
    set('qDock', `${s.queueDockIn} / ${s.queueDockOut}`);
    set('pallets', `${s.palletsIn} / ${s.palletsOut}`);
    set('orders', fmt(s.orders, 0));
    set('exc', `${s.stockouts} / ${s.overflow}`);
    const w = (k: string, v: number) => rows[k] && (rows[k].style.width = `${Math.min(100, v * 100)}%`);
    w('fkUtil', ctx.scenario.forklifts.count ? s.forkliftsBusy / ctx.scenario.forklifts.count : 0);
    w('wkUtil', ctx.scenario.workers.count ? s.workersBusy / ctx.scenario.workers.count : 0);
    w('occBar', s.occupancy);
  };
  return { el: root, update };
}
