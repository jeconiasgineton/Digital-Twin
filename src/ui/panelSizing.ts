import type { AppCtx } from './ctx';
import { seriesChart } from './charts';
import { fmt, h, pct, toast } from './dom';
import { sweepInWorker } from '../sim/client';
import type { SweepParam, SweepPoint } from '../sim/runner';

const STATUS: Record<string, [string, string]> = { ok: ['ok', 'OK'], atencao: ['warn', 'Atenção'], critico: ['bad', 'Crítico'] };

export function renderSizingPanel(ctx: AppCtx): HTMLElement {
  const root = h('div');
  const cap = ctx.capacity;
  const sc = ctx.scenario;
  if (!cap) {
    root.append(h('p', { class: 'note' }, 'Calculando…'));
    return root;
  }
  root.append(
    h('details', { open: true }, h('summary', null, 'Dimensionamento analítico (instantâneo)'), h('div', { class: 'body' },
      h('p', { class: 'note' }, `Teoria de filas M/G/c (Allen–Cunneen) com chegadas em lote (Poisson composto). Metas: ρ ≤ ${pct(sc.targetUtilization)} e P(espera > ${sc.targetWaitP95Min} min) ≤ ${pct(1 - sc.serviceLevel)}.`),
      h('div', { style: { overflowX: 'auto' } }, h('table', null,
        h('thead', null, h('tr', null, ['Recurso', 'Atual', 'Nec. média', 'Nec. pico', 'ρ pico', 'Cap./h', 'Estado'].map((t) => h('th', null, t)))),
        h('tbody', null, cap.rows.map((r) => {
          const [cls, txt] = STATUS[r.status];
          return h('tr', { title: r.note }, h('td', null, r.name), h('td', null, fmt(r.current, 0)), h('td', null, fmt(r.requiredAvg, 0)), h('td', null, h('b', null, fmt(r.requiredPeak, 0))), h('td', { class: cls }, pct(r.rhoPeak)), h('td', null, fmt(r.capacityPerHour, 0)), h('td', null, h('span', { class: `pill ${cls}` }, txt)));
        })),
      )),
      ...cap.rows.map((r) => h('p', { class: 'note' }, h('b', null, r.name + ': '), r.note, ` Demanda: ${fmt(r.demandPerHourAvg, 0)}/h (média), ${fmt(r.demandPerHourPeak, 0)}/h (pico). Espera P95 no pico: ${Number.isFinite(r.waitP95MinPeak) ? fmt(r.waitP95MinPeak, 1) + ' min' : 'fila instável'}.`)),
    )),
    h('details', { open: true }, h('summary', null, 'Capacidade de armazenagem'), h('div', { class: 'body' },
      h('div', { class: 'cards' },
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Posições de palete'), h('div', { class: 'v' }, fmt(cap.storage.positions, 0))),
        h('div', { class: `card ${cap.storage.expectedOccupancy > 0.9 ? 'bad' : cap.storage.expectedOccupancy > 0.8 ? 'warn' : 'ok'}` }, h('div', { class: 'k' }, 'Ocupação esperada (Little)'), h('div', { class: 'v' }, pct(cap.storage.expectedOccupancy)), h('div', { class: 's' }, `${fmt(cap.storage.expectedPallets, 0)} paletes = λ·W`)),
        h('div', { class: `card ${cap.storage.pOverflow > 0.05 ? 'bad' : cap.storage.pOverflow > 0.005 ? 'warn' : 'ok'}` }, h('div', { class: 'k' }, 'P(estouro de posições)'), h('div', { class: 'v' }, pct(cap.storage.pOverflow, 2)), h('div', { class: 's' }, 'modelo M/G/∞ (Poisson)')),
        h('div', { class: 'card' }, h('div', { class: 'k' }, `Posições p/ ${pct(sc.serviceLevel)} de serviço`), h('div', { class: 'v' }, fmt(cap.storage.positionsForServiceLevel, 0)), h('div', { class: 's' }, `inclui estoque de segurança ${fmt(cap.storage.safetyStockPallets, 0)}`)),
      ),
      h('p', { class: 'note' }, `Fluxo diário: entram ${fmt(cap.storage.dailyInPallets, 0)} e saem ${fmt(cap.storage.dailyOutPallets, 0)} paletes (saldo ${cap.storage.netDailyDrift >= 0 ? '+' : ''}${fmt(cap.storage.netDailyDrift, 0)}/dia).` + (cap.storage.daysToFull > 0 ? ` O armazém lota em ~${fmt(cap.storage.daysToFull, 0)} dias.` : '')),
      h('p', { class: 'note' }, `Distâncias médias de navegação: doca entrada→rack ${fmt(cap.travel.dockToRackIn, 0)} m · rack→doca saída ${fmt(cap.travel.rackToDockOut, 0)} m · rack picking→esteira ${fmt(cap.travel.rackToInduction, 0)} m.`),
    )),
    sweepSection(ctx),
    h('details', null, h('summary', null, 'Premissas do modelo'), h('div', { class: 'body' }, h('ul', { class: 'note', style: { paddingLeft: '18px', margin: 0 } }, cap.assumptions.map((a) => h('li', null, a))))),
  );
  return root;
}

function sweepSection(ctx: AppCtx) {
  const sc = ctx.scenario;
  const box = h('div');
  const status = h('div', { class: 'progress', style: { display: 'none' } }, h('div'));
  const run = async (param: SweepParam, values: number[]) => {
    if (ctx.busy) return;
    ctx.busy = true;
    status.style.display = 'block';
    try {
      const pts = await sweepInWorker(sc, ctx.layout, param, values, (d, t) => ((status.firstChild as HTMLElement).style.width = `${(d / t) * 100}%`));
      ctx.sweeps[param] = pts;
      renderSweeps();
    } catch (e) {
      toast('Falha na varredura: ' + (e as Error).message, 'err');
    } finally {
      ctx.busy = false;
      status.style.display = 'none';
    }
  };
  const around = (n: number, lo = 2, hi = 5) => {
    const arr: number[] = [];
    for (let v = Math.max(1, n - lo); v <= n + hi; v++) arr.push(v);
    return arr;
  };
  const renderSweeps = () => {
    box.innerHTML = '';
    for (const [param, title, unit] of [['forklifts', 'Nº de empilhadeiras', ''], ['workers', 'Nº de operários', ''], ['demand', 'Demanda (sensibilidade)', '']] as [SweepParam, string, string][]) {
      const pts: SweepPoint[] | undefined = ctx.sweeps[param];
      if (!pts) continue;
      void unit;
      const first = pts.find((p) => p.ok);
      const util = param === 'workers' ? 'utilWorker' : 'utilForklift';
      const wait = param === 'workers' ? 'waitWorkerP95' : 'waitForkliftP95';
      box.append(
        h('h3', { style: { marginTop: '12px' } }, title),
        h('div', { class: first ? 'insight ok' : 'insight bad' }, param === 'demand'
          ? (first ? `Capacidade operacional: a configuração atual sustenta demanda até ${[...pts].reverse().find((p) => p.ok)?.label ?? '—'} do cenário base mantendo as metas.${pts.every((p) => p.ok) ? ' (todos os pontos testados atendem — aumente a faixa)' : ''}` : 'A configuração atual não atende às metas em nenhum nível de demanda testado.')
          : (first ? `Menor quantidade que atende às metas (ρ ≤ ${pct(sc.targetUtilization)}, espera P95 ≤ ${sc.targetWaitP95Min} min): ${first.label}.` : 'Nenhuma quantidade testada atende às metas — amplie a faixa ou revise tempos/layout.')),
        seriesChart([{ name: 'Utilização', values: pts.map((p) => p.kpis[util].mean), type: 'line' }], { title: 'Utilização média', xLabels: pts.map((p) => p.label), yMax: 1.05, yFmt: (v) => `${(v * 100).toFixed(0)}%`, hline: { y: sc.targetUtilization, label: 'meta' }, h: 150 }) as unknown as HTMLElement,
        seriesChart([{ name: 'Espera P95 (min)', values: pts.map((p) => p.kpis[wait].mean), type: 'line', color: '#f59e0b' }], { title: 'Espera P95 em fila (min)', xLabels: pts.map((p) => p.label), hline: { y: sc.targetWaitP95Min, label: 'meta' }, h: 150 }) as unknown as HTMLElement,
        h('table', null,
          h('thead', null, h('tr', null, ['Valor', 'Util.', 'Espera P95', 'Paletes/dia', 'Custo/palete', 'Metas'].map((t) => h('th', null, t)))),
          h('tbody', null, pts.map((p) => h('tr', null, h('td', null, p.label), h('td', null, pct(p.kpis[util].mean)), h('td', null, fmt(p.kpis[wait].mean, 1)), h('td', null, fmt(p.kpis.palletsInPerDay.mean + p.kpis.palletsOutPerDay.mean, 0)), h('td', null, fmt(p.kpis.costPerPallet.mean, 2)), h('td', { class: p.ok ? 'ok' : 'bad' }, p.ok ? '✔' : '✘')))),
        ),
      );
    }
  };
  renderSweeps();
  return h('details', { open: true }, h('summary', null, 'Dimensionamento e capacidade por simulação'), h('div', { class: 'body' },
    h('p', { class: 'note' }, 'Executa Monte Carlo variando um parâmetro (sementes comuns entre cenários) e aponta a menor configuração que cumpre as metas.'),
    h('div', { class: 'row' },
      h('button', { class: 'b', onclick: () => run('forklifts', around(sc.forklifts.count)) }, 'Varrer empilhadeiras'),
      h('button', { class: 'b', onclick: () => run('workers', around(sc.workers.count, 3, 6)) }, 'Varrer operários'),
      h('button', { class: 'b', onclick: () => run('demand', [0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8]) }, 'Sensibilidade da demanda'),
    ),
    status,
    box,
  ));
}
