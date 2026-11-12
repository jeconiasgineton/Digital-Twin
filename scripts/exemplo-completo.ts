import { writeFileSync } from 'node:fs';
import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { defaultBreak, presetVehicle } from '../src/model/traffic';
import { exportTemplate } from '../src/io/excel';

/** Cenário de demonstração que liga todos os processos: veículos, chegadas agendadas, intervalos, recebimento com avarias, armazenagem faseada e AMR. */
export function exemploCompleto() {
  const sc = defaultScenario();
  sc.name = 'Exemplo completo (todos os processos)';
  sc.replications = 10;
  sc.days = 3;

  // veículos e chegadas
  const carreta = { ...presetVehicle('carreta'), share: 0.6, dockTurnover: { kind: 'triangular' as const, a: 120, b: 180, c: 300 } };
  const truck = { ...presetVehicle('truck'), share: 0.4, dockTurnover: { kind: 'triangular' as const, a: 40, b: 60, c: 120 } };
  sc.vehicleTypes = [carreta, truck];
  sc.arrivalsIn = { mode: 'fixed', intervalMin: 30, scheduleHours: [], delayProb: 0.2, delayMin: { kind: 'lognormal', a: 25, b: 15 } };
  sc.dockWaitThresholdMin = 10;

  // pessoas, intervalos e equipamentos
  sc.checkers.count = 4;
  sc.forklifts.count = 6;
  sc.calendar.breaks = [{ ...defaultBreak('almoco'), stagger: 'half' }, { ...defaultBreak('cafe') }];
  sc.equipment[1].count = 3; // transpaleteira elétrica
  sc.equipment[2].count = 2; // AMR
  sc.equipment[2].amr!.chargeAtShiftEnd = true;
  sc.calendar.amrWorksDuringBreaks = true;

  // recebimento e armazenagem
  sc.receiving.damagePalletPct = 0.03;
  sc.receiving.unloadWith = ['forklift', 'palletTruck'];
  sc.storage = { mode: 'phased', step1With: ['palletTruck', 'amr'] };

  const layout = generateLayout(defaultLayoutParams());
  layout.name = 'Galpão do exemplo completo';
  return { sc, layout };
}

if (process.argv[1]?.endsWith('exemplo-completo.ts')) {
  const { sc, layout } = exemploCompleto();
  exportTemplate(sc, layout).then((buf) => {
    writeFileSync('examples/exemplo-completo.xlsx', Buffer.from(buf));
    console.log('examples/exemplo-completo.xlsx gerado');
  });
}
