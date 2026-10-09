import type { ExperimentResult, Scenario } from '../model/types';
import type { CapacityReport } from './capacity';

export interface Insight {
  level: 'ok' | 'warn' | 'bad' | 'info';
  text: string;
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

/** Interpreta resultados da simulação + análise analítica e aponta gargalos e ações. */
export function diagnose(sc: Scenario, res: ExperimentResult, cap: CapacityReport | null): Insight[] {
  const k = res.kpis;
  const out: Insight[] = [];
  const U = sc.targetUtilization;
  const W = sc.targetWaitP95Min;
  const rows = [
    { key: 'forklift', name: 'Empilhadeiras', u: k.utilForklift.mean, wait: k.waitForkliftP95.mean, n: sc.forklifts.count },
    { key: 'worker', name: 'Operários de picking', u: k.utilWorker.mean, wait: k.waitWorkerP95.mean, n: sc.workers.count },
    { key: 'dockIn', name: 'Docas de recebimento', u: k.utilDockIn.mean, wait: k.dockWaitInP95.mean, n: 0 },
    { key: 'dockOut', name: 'Docas de expedição', u: k.utilDockOut.mean, wait: k.dockWaitOutP95.mean, n: 0 },
    { key: 'conveyor', name: 'Esteiras', u: k.utilConveyor.mean, wait: 0, n: 0 },
  ].filter((r) => r.u > 0);
  const worst = [...rows].sort((a, b) => b.u - a.u)[0];
  if (worst) {
    out.push({
      level: worst.u > 0.95 ? 'bad' : worst.u > U ? 'warn' : 'ok',
      text: `Gargalo: ${worst.name} com utilização média de ${pct(worst.u)} (meta ${pct(U)}) e espera P95 de ${worst.wait.toFixed(1)} min.`,
    });
  }
  for (const r of rows) {
    const capRow = cap?.rows.find((c) => c.key === r.key);
    if (r.u > U || r.wait > W * (r.key.startsWith('dock') ? 3 : 1)) {
      const rec = capRow ? ` Dimensionamento analítico sugere ${capRow.requiredAvg} (demanda média) a ${capRow.requiredPeak} (pico) para atender às metas.` : '';
      out.push({ level: r.u > 0.95 ? 'bad' : 'warn', text: `${r.name}: utilização ${pct(r.u)}, espera P95 ${r.wait.toFixed(1)} min — acima da meta.${rec}` });
    } else if (r.u < 0.35 && (r.key === 'forklift' || r.key === 'worker') && r.n > 1) {
      out.push({ level: 'info', text: `${r.name}: apenas ${pct(r.u)} de utilização – possível ociosidade/superdimensionamento (${r.n} unidades).` });
    }
  }
  if (k.backlogOrders.mean > 5) out.push({ level: 'bad', text: `Fila de pedidos acumulada no fim da simulação: ~${k.backlogOrders.mean.toFixed(0)} pedidos aguardando — a operação não está sustentável.` });
  if (k.backlogPallets.mean > 15) out.push({ level: 'warn', text: `Backlog de ~${k.backlogPallets.mean.toFixed(0)} paletes pendentes ao final: empilhadeiras/docas insuficientes para o fluxo.` });
  if (k.stockoutRate.mean > 0.01) out.push({ level: 'bad', text: `Ruptura: ${pct(k.stockoutRate.mean)} das retiradas de paletes não encontraram estoque (expedição maior que o recebimento).` });
  if (k.overflowRate.mean > 0.005) out.push({ level: 'bad', text: `Falta de posições: ${pct(k.overflowRate.mean)} dos paletes recebidos não tiveram endereço livre. Ocupação máxima ${pct(k.occupancyMax.mean)}.` });
  else if (k.occupancyMax.mean > 0.92) out.push({ level: 'warn', text: `Ocupação máxima do estoque de ${pct(k.occupancyMax.mean)} — próximo do limite; risco de estouro de posições.` });
  if (cap && cap.storage.daysToFull > 0 && cap.storage.daysToFull < 60) out.push({ level: 'warn', text: `Saldo diário de entrada − saída = +${cap.storage.netDailyDrift.toFixed(0)} paletes/dia: o armazém lota em ~${cap.storage.daysToFull.toFixed(0)} dias.` });
  if (k.palletsPerForkliftHour.mean > 0) out.push({ level: 'info', text: `Produtividade: ${k.palletsPerForkliftHour.mean.toFixed(1)} paletes/h por empilhadeira; ${k.linesPerWorkerHour.mean.toFixed(1)} linhas/h por operário; custo ≈ R$ ${k.costPerPallet.mean.toFixed(2)} por palete movimentado.` });
  if (out.every((o) => o.level === 'ok' || o.level === 'info')) out.unshift({ level: 'ok', text: 'Todas as metas de utilização e espera foram atendidas no cenário simulado.' });
  return out;
}
