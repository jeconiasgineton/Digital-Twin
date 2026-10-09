import { defaultScenario } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { SimModel } from '../src/sim/model';
const layout = generateLayout(defaultLayoutParams());
for (const av of [1, 0.92]) {
  const sc = defaultScenario(); sc.days = 3; sc.workers.availability = av; sc.forklifts.availability = av;
  const m = new SimModel(sc, layout, 3);
  const r = m.runAll();
  const k = r.kpis;
  console.log('avail', av, 'util w', k.utilWorker.toFixed(2), 'wait w p95', k.waitWorkerP95.toFixed(1), 'backlog', k.backlogOrders, 'orders/day', k.ordersPerDay.toFixed(0), 'fk util', k.utilForklift.toFixed(2), 'lines/h/worker', k.linesPerWorkerHour.toFixed(1));
  console.log('down times', m.workers.items.map(i => Math.round(i.downTime/3600*10)/10).join(','), 'busyH', m.workers.items.map(i => Math.round(i.busyTime/3600*10)/10).join(','));
}
