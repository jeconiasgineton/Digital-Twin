import type { Layout } from './types';

/** galpão em branco: piso vazio, sem racks, ruas, docas nem equipamentos desenhados */
export const blankLayout = (name = 'Novo galpão'): Layout => ({ name, floor: { width: 60, depth: 40 }, elements: [] });

import { defaultScenario } from './defaults';
import type { Scenario } from './types';

/**
 * Cenário em branco: sem chegadas, sem pedidos e sem equipamentos (o usuário adiciona aos poucos).
 * O restante dos parâmetros (horário, metas, tempos de operação) segue o padrão e pode ser editado.
 */
export function blankScenario(): Scenario {
  const sc = defaultScenario();
  const zero = (n = 24) => new Array(n).fill(0);
  sc.inboundTrucksPerHour = zero();
  sc.outboundTrucksPerHour = zero();
  sc.ordersPerHour = zero();
  sc.forklifts.count = 0;
  for (const e of sc.equipment) e.count = 0;
  sc.workers.count = 0;
  sc.checkers.count = 0;
  return sc;
}
