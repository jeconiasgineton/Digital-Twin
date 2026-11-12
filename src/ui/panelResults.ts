import { diagnose } from '../analysis/diagnose';
import { exportResults } from '../io/excel';
import type { Aggregated, ExperimentResult } from '../model/types';
import type { AppCtx } from './ctx';
import { histogram, seriesChart } from './charts';
import { download, fmt, h, pct } from './dom';

type Fmt = (v: number) => string;
const KPI_ROWS: [keyof Aggregated, string, Fmt][] = [
  ['palletsInPerDay', 'Paletes recebidos / dia', (v) => fmt(v, 0)],
  ['palletsOutPerDay', 'Paletes expedidos / dia', (v) => fmt(v, 0)],
  ['ordersPerDay', 'Pedidos concluídos / dia', (v) => fmt(v, 0)],
  ['cartonsPerDay', 'Caixas separadas / dia', (v) => fmt(v, 0)],
  ['trucksInPerDay', 'Caminhões descarregados / dia', (v) => fmt(v, 1)],
  ['trucksOutPerDay', 'Caminhões carregados / dia', (v) => fmt(v, 1)],
  ['utilForklift', 'Utilização empilhadeiras', (v) => pct(v, 1)],
  ['utilWorker', 'Utilização operários', (v) => pct(v, 1)],
  ['utilDockIn', 'Utilização docas entrada', (v) => pct(v, 1)],
  ['utilDockOut', 'Utilização docas saída', (v) => pct(v, 1)],
  ['utilConveyor', 'Utilização esteiras', (v) => pct(v, 1)],
  ['waitForkliftMean', 'Espera por empilhadeira (min)', (v) => fmt(v, 2)],
  ['waitForkliftP95', '… P95 (min)', (v) => fmt(v, 2)],
  ['waitWorkerMean', 'Espera por operário (min)', (v) => fmt(v, 2)],
  ['dockWaitIn', 'Espera de caminhão p/ doca entrada (min)', (v) => fmt(v, 1)],
  ['dockWaitOut', 'Espera de caminhão p/ doca saída (min)', (v) => fmt(v, 1)],
  ['truckTurnaroundIn', 'Tempo no pátio – recebimento (min)', (v) => fmt(v, 1)],
  ['truckTurnaroundOut', 'Tempo no pátio – expedição (min)', (v) => fmt(v, 1)],
  ['dockWaitOverPctIn', 'Caminhões c/ espera acima do limite – recebimento', (v) => pct(v, 1)],
  ['dockWaitOverPctOut', 'Caminhões c/ espera acima do limite – expedição', (v) => pct(v, 1)],
  ['trucksDelayedPct', 'Veículos agendados que chegaram atrasados', (v) => pct(v, 1)],
  ['truckDelayMean', 'Atraso médio dos atrasados (min)', (v) => fmt(v, 1)],
  ['productiveHoursPerDay', 'Horas úteis / dia / empilhadeira', (v) => fmt(v, 2)],
  ['breakHoursPerDay', 'Intervalos / dia / empilhadeira (h)', (v) => fmt(v, 2)],
  ['nonWorkingHoursPerDay', 'Horas não úteis / dia', (v) => fmt(v, 1)],
  ['damagedPalletPct', 'Paletes avariados (% dos conferidos)', (v) => pct(v, 1)],
  ['damagedPalletsPerDay', 'Paletes avariados / dia', (v) => fmt(v, 1)],
  ['damagedCartonsPerDay', 'Caixas avariadas / dia', (v) => fmt(v, 0)],
  ['wholePalletTriagePerDay', 'Paletes inteiros para a triagem / dia', (v) => fmt(v, 2)],
  ['triageOverflowPerDay', 'Paletes sem espaço na triagem / dia', (v) => fmt(v, 2)],
  ['checkCycleMean', 'Conferência + triagem por palete (min)', (v) => fmt(v, 1)],
  ['stageWaitMean', 'Espera por espaço no stage (min)', (v) => fmt(v, 1)],
  ['stageOccupancyMax', 'Ocupação máxima do stage (paletes)', (v) => fmt(v, 0)],
  ['utilMover', 'Utilização paleteiras/transpaleteiras/AMR', (v) => pct(v, 1)],
  ['phasedShare', 'Paletes guardados em duas etapas', (v) => pct(v, 0)],
  ['transitWaitMean', 'Espera da etapa 1 por espaço na rua (min)', (v) => fmt(v, 1)],
  ['transitOccupancyMax', 'Ocupação máxima dos endereços transitórios', (v) => fmt(v, 0)],
  ['utilAmr', 'Utilização dos AMR', (v) => pct(v, 1)],
  ['amrChargesPerDay', 'Cargas de AMR / dia', (v) => fmt(v, 1)],
  ['amrChargeShare', 'Tempo dos AMR em carga (ida + carga + setup)', (v) => pct(v, 1)],
  ['chargerWaitMean', 'Espera por vaga na estação de carga (min)', (v) => fmt(v, 1)],
  ['boxesPerPickerHour', 'Caixas / hora trabalhada do separador', (v) => fmt(v, 0)],
  ['pickPalletsPerDay', 'Paletes separados / dia', (v) => fmt(v, 1)],
  ['boxesPerPallet', 'Caixas por palete separado', (v) => fmt(v, 1)],
  ['pickPalletTimeMean', 'Palete: da 1ª à última caixa (min)', (v) => fmt(v, 1)],
  ['pickRouteTimeU', 'Rota por separador se fosse em U (min)', (v) => fmt(v, 2)],
  ['pickRouteTimeZigzag', 'Rota por separador se fosse em zigue-zague (min)', (v) => fmt(v, 2)],
  ['stockoutPicksPerDay', 'Visitas a endereço vazio / dia', (v) => fmt(v, 1)],
  ['stockoutTimeLostPerDay', 'Tempo perdido com furos (min/dia)', (v) => fmt(v, 1)],
  ['putawayLeadMean', 'Lead time doca→endereço (min)', (v) => fmt(v, 1)],
  ['orderCycleMean', 'Ciclo do pedido (min)', (v) => fmt(v, 1)],
  ['orderCycleP95', '… P95 (min)', (v) => fmt(v, 1)],
  ['occupancyMean', 'Ocupação média do estoque', (v) => pct(v, 1)],
  ['occupancyMax', 'Ocupação máxima', (v) => pct(v, 1)],
  ['stockoutRate', 'Taxa de ruptura', (v) => pct(v, 2)],
  ['overflowRate', 'Taxa de falta de posição', (v) => pct(v, 2)],
  ['palletsPerForkliftHour', 'Paletes / h / empilhadeira', (v) => fmt(v, 1)],
  ['linesPerWorkerHour', 'Linhas / h / operário', (v) => fmt(v, 1)],
  ['kmPerForklift', 'km / dia / empilhadeira', (v) => fmt(v, 1)],
  ['kmPerWorker', 'km / dia / operário', (v) => fmt(v, 1)],
  ['costPerPallet', 'Custo por palete (R$)', (v) => fmt(v, 2)],
  ['backlogOrders', 'Pedidos na fila no fim', (v) => fmt(v, 0)],
  ['backlogPallets', 'Paletes pendentes no fim', (v) => fmt(v, 0)],
];

export function renderResultsPanel(ctx: AppCtx): HTMLElement {
  const sc = ctx.scenario;
  const root = h('div');
  const prog = h('div', { class: 'progress', style: { display: 'none' } }, h('div'));
  const btn = h('button', { class: 'b pri', disabled: ctx.busy, onclick: async () => {
    prog.style.display = 'block';
    (prog.firstChild as HTMLElement).style.width = '0%';
    await ctx.runMonteCarlo();
    prog.style.display = 'none';
  } }, `▶ Executar Monte Carlo (${sc.replications} réplicas × ${sc.days} dias)`);
  root.append(
    h('div', { class: 'row sp' }, btn, ctx.result ? h('button', { class: 'b', onclick: async () => {
      const buf = await exportResults(sc, ctx.result!, ctx.capacity);
      download('resultados-digital-twin.xlsx', buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } }, '📊 Exportar .xlsx') : null),
    prog,
  );
  (ctx as any).progressEl = prog;
  const res = ctx.result;
  if (!res) {
    root.append(h('p', { class: 'note' }, 'Executa várias réplicas independentes (variáveis aleatórias com sementes distintas) e calcula média, desvio-padrão, intervalo de confiança de 95% (t de Student) e percentis P50/P90/P95 de cada indicador.'));
    return root;
  }
  const k = res.kpis;
  const U = sc.targetUtilization;
  const card = (label: string, v: string, sub: string, cls = '') => h('div', { class: `card ${cls}` }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, v), h('div', { class: 's' }, sub));
  const uc = (u: number) => (u > 0.95 ? 'bad' : u > U ? 'warn' : 'ok');
  root.append(
    h('p', { class: 'note' }, `${res.replications} réplicas · ${(res.elapsedMs / 1000).toFixed(1)} s · IC 95% pelo t de Student`),
    h('div', { class: 'cards' },
      card('Paletes recebidos/dia', fmt(k.palletsInPerDay.mean, 0), `± ${fmt(k.palletsInPerDay.ci95, 1)} (IC95%)`),
      card('Paletes expedidos/dia', fmt(k.palletsOutPerDay.mean, 0), `± ${fmt(k.palletsOutPerDay.ci95, 1)}`),
      card('Pedidos/dia', fmt(k.ordersPerDay.mean, 0), `ciclo médio ${fmt(k.orderCycleMean.mean, 1)} min · P95 ${fmt(k.orderCycleP95.mean, 1)}`),
      card('Empilhadeiras', pct(k.utilForklift.mean), `espera P95 ${fmt(k.waitForkliftP95.mean, 1)} min`, uc(k.utilForklift.mean)),
      card('Operários', pct(k.utilWorker.mean), `espera P95 ${fmt(k.waitWorkerP95.mean, 1)} min`, sc.workers.count ? uc(k.utilWorker.mean) : ''),
      card('Docas ent. / saída', `${pct(k.utilDockIn.mean)} / ${pct(k.utilDockOut.mean)}`, `espera P95 ${fmt(k.dockWaitInP95.mean, 0)} / ${fmt(k.dockWaitOutP95.mean, 0)} min`),
      card('Ocupação do estoque', pct(k.occupancyMean.mean), `máx. ${pct(k.occupancyMax.mean)}`, k.overflowRate.mean > 0.005 ? 'bad' : ''),
      card('Custo por palete', `R$ ${fmt(k.costPerPallet.mean, 2)}`, `R$ ${fmt(k.totalCost.mean, 0)} no período`),
    ),
    ...(res.vehicleStats.length > 1 || sc.vehicleTypes.length ? [h('div', null,
          h('h3', null, 'Por tipo de veículo'),
          h('table', null,
            h('thead', null, h('tr', null, ['Tipo', 'Veículos/dia', 'Manobra média (min)', 'Espera por doca (min)'].map((t) => h('th', null, t)))),
            h('tbody', null, res.vehicleStats.map((v) => h('tr', null, h('td', null, v.name), h('td', null, fmt(v.trucks, 1)), h('td', null, fmt(v.dockTurnMean, 1)), h('td', null, fmt(v.dockWaitMean, 1)))))),
        )] : []),
    h('h3', null, 'Diagnóstico'),
    ...diagnose(sc, res, ctx.capacity).map((i) => h('div', { class: `insight ${i.level === 'info' ? '' : i.level}` }, i.text)),
    h('h3', { style: { marginTop: '14px' } }, 'Gráficos'),
    ...charts(ctx, res),
    h('h3', { style: { marginTop: '14px' } }, 'Todos os indicadores'),
    h('div', { style: { overflowX: 'auto' } }, h('table', null,
      h('thead', null, h('tr', null, ['Indicador', 'Média', '± IC95%', 'Desvio', 'P50', 'P90', 'P95'].map((t) => h('th', null, t)))),
      h('tbody', null, KPI_ROWS.map(([key, name, f]) => {
        const s = k[key];
        return h('tr', null, h('td', null, name), h('td', null, h('b', null, f(s.mean))), h('td', null, f(s.ci95)), h('td', null, f(s.sd)), h('td', null, f(s.p50)), h('td', null, f(s.p90)), h('td', null, f(s.p95)));
      })),
    )),
  );
  return root;
}

function charts(ctx: AppCtx, res: ExperimentResult): HTMLElement[] {
  const sc = ctx.scenario;
  const hs = res.hourly;
  const labels = hs.map((x) => `${(sc.startHour + x.hour) % 24}h`);
  const out: HTMLElement[] = [];
  const wrap = (svg: SVGElement) => svg as unknown as HTMLElement;
  if (hs.length) {
    out.push(
      wrap(seriesChart([
        { name: 'Paletes entrada', values: hs.map((x) => x.palletsIn), type: 'bar' },
        { name: 'Paletes saída', values: hs.map((x) => x.palletsOut), type: 'bar' },
      ], { title: 'Vazão por hora do dia (média de dias e réplicas)', xLabels: labels, h: 180 })),
      wrap(seriesChart([
        { name: 'Empilhadeiras', values: hs.map((x) => x.utilForklift), type: 'line' },
        { name: 'Operários', values: hs.map((x) => x.utilWorker), type: 'line' },
      ], { title: 'Utilização por hora', xLabels: labels, yMax: 1.05, yFmt: (v) => `${(v * 100).toFixed(0)}%`, hline: { y: sc.targetUtilization, label: 'meta' }, h: 180 })),
      wrap(seriesChart([{ name: 'Fila de paletes', values: hs.map((x) => x.queueForklift), type: 'area', color: '#f59e0b' }], { title: 'Fila para empilhadeiras (paletes aguardando)', xLabels: labels, h: 150 })),
    );
  }
  if (res.occupancySeries.length > 2) {
    const o = res.occupancySeries.filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 80)) === 0);
    out.push(wrap(seriesChart([{ name: 'Ocupação', values: o.map((x) => x.occ), type: 'area', color: '#a78bfa' }], { title: 'Ocupação do estoque ao longo do tempo (média)', yMax: 1, yMin: 0, yFmt: (v) => `${(v * 100).toFixed(0)}%`, xLabels: o.map((x, i, a) => { const d = Math.floor(x.t / 3600 / sc.shiftHours) + 1; return i === 0 || Math.floor(a[i - 1].t / 3600 / sc.shiftHours) + 1 !== d ? `d${d}` : ''; }), xTitle: 'dia operacional', allLabels: true, h: 160 })));
  }
  out.push(
    wrap(histogram(res.samples.orderCycle, { title: 'Distribuição do ciclo de pedido (min)', unit: 'min' })),
    wrap(histogram(res.samples.forkliftWait, { title: 'Distribuição da espera por empilhadeira (min)', unit: 'min' })),
    wrap(histogram(res.samples.putawayLead, { title: 'Lead time doca → endereçamento (min)', unit: 'min' })),
  );
  return out;
}
