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
    { key: 'checker', name: 'Conferentes', u: k.utilChecker.mean, wait: 0, n: sc.checkers.count },
    { key: 'mover', name: 'Paleteiras / transpaleteiras / AMR', u: k.utilMover.mean, wait: 0, n: 0 },
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
  const row = (key: string) => cap?.rows.find((r) => r.key === key);
  const need = (key: string) => {
    const r = row(key);
    return r ? ` O dimensionamento analítico (estimativa) indica ${r.requiredPeak} ${r.unit} no pico; hoje há ${r.current}.` : '';
  };
  // stage: o espaço de espera do recebimento limita a descarga
  if (k.stageWaitMean.mean > 1) out.push({ level: k.stageWaitMean.mean > 5 ? 'bad' : 'warn', text: `Stage cheio: os paletes esperam em média ${k.stageWaitMean.mean.toFixed(1)} min por espaço no stage (ocupação máxima ${k.stageOccupancyMax.mean.toFixed(0)} paletes), o que mantém as docas ocupadas. Aumente a capacidade do stage ou a produtividade da conferência.${need('stage')}` });
  // rua cheia (faseada)
  if (sc.storage.mode === 'phased' && k.transitWaitMean.mean > 1) out.push({ level: k.transitWaitMean.mean > 5 ? 'bad' : 'warn', text: `Rua cheia: a etapa 1 espera em média ${k.transitWaitMean.mean.toFixed(1)} min por espaço nos endereços transitórios (máx. ${k.transitOccupancyMax.mean.toFixed(0)} paletes). Aumente a capacidade dos transitórios, crie mais transitórios nas ruas ou reforce as empilhadeiras da etapa 2.${need('transit')}` });
  // triagem lotada
  if (k.triageOverflowPerDay.mean > 0.05) out.push({ level: 'bad', text: `Triagem lotada: ~${k.triageOverflowPerDay.mean.toFixed(1)} paletes por dia não couberam em nenhuma área de triagem. Aumente a capacidade, crie outra área de triagem ou colete com mais frequência.${need('triage')}` });
  // avarias
  if (k.damagedPalletPct.mean > 0) out.push({ level: k.damagedPalletPct.mean > 0.05 ? 'warn' : 'info', text: `Avarias: ${pct(k.damagedPalletPct.mean)} dos paletes conferidos (${k.damagedPalletsPerDay.mean.toFixed(1)}/dia, ${k.damagedCartonsPerDay.mean.toFixed(0)} caixas/dia; ${k.wholePalletTriagePerDay.mean.toFixed(2)} paletes inteiros/dia). Conferência + triagem levam ${k.checkCycleMean.mean.toFixed(1)} min por palete.` });
  // AMR
  if (k.amrChargesPerDay.mean > 0) {
    const bad = k.chargerWaitMean.mean > 2 || k.amrChargeShare.mean > 0.3;
    out.push({ level: bad ? 'warn' : 'info', text: `AMR: ${k.amrChargesPerDay.mean.toFixed(1)} cargas/dia; ${pct(k.amrChargeShare.mean)} do tempo em carga/setup${k.chargerWaitMean.mean > 0.1 ? `; espera por vaga de ${k.chargerWaitMean.mean.toFixed(1)} min` : ''}. ${k.chargerWaitMean.mean > 2 ? 'Faltam vagas na estação de carga.' : k.amrChargeShare.mean > 0.3 ? 'Muito tempo carregando: aumente a autonomia ou o nº de AMR.' : ''}${need('charger')}` });
  }
  // docas e atrasos
  const over = Math.max(k.dockWaitOverPctIn.mean, k.dockWaitOverPctOut.mean);
  if (over > 0.1) out.push({ level: over > 0.3 ? 'bad' : 'warn', text: `Docas: ${pct(k.dockWaitOverPctIn.mean)} dos caminhões de recebimento e ${pct(k.dockWaitOverPctOut.mean)} dos de expedição esperam mais de ${sc.dockWaitThresholdMin} min por uma doca.` });
  if (k.trucksDelayedPct.mean > 0.05) out.push({ level: 'info', text: `${pct(k.trucksDelayedPct.mean)} dos veículos agendados chegaram atrasados (atraso médio ${k.truckDelayMean.mean.toFixed(0)} min); atrasos concentram a chegada e pressionam as docas.` });
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
