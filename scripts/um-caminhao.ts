import { defaultScenario, hourlyProfile } from '../src/model/defaults';
import { defaultLayoutParams, generateLayout } from '../src/model/layoutGen';
import { runExperiment } from '../src/sim/runner';
const sc = defaultScenario();
sc.inboundTrucksPerHour = hourlyProfile(1, sc.startHour, sc.shiftHours, 'flat'); // 1 caminhão/dia
sc.days = 10; sc.replications = 20;
const r = runExperiment(sc, generateLayout(defaultLayoutParams()));
const k = r.kpis;
console.log('caminhões entrada/dia: média', k.trucksInPerDay.mean.toFixed(2), 'min', k.trucksInPerDay.min.toFixed(2), 'max', k.trucksInPerDay.max.toFixed(2));
console.log('paletes recebidos/dia', k.palletsInPerDay.mean.toFixed(1), '| expedidos/dia', k.palletsOutPerDay.mean.toFixed(1));
console.log('util empilhadeira', (k.utilForklift.mean*100).toFixed(0)+'%', '| doca entrada', (k.utilDockIn.mean*100).toFixed(1)+'%', '| ocupação média', (k.occupancyMean.mean*100).toFixed(0)+'%', '| ruptura', (k.stockoutRate.mean*100).toFixed(1)+'%');
