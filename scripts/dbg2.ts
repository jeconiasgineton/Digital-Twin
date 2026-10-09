import { sizeServers, ggcMetrics } from '../src/math/queueing';
const lamPeakPerH = 67, meanS = 171, scv = 0.1;
for (const ca2 of [1, 6, 12, 18]) {
  const s = sizeServers({ lambda: lamPeakPerH / 3600, meanS, scvS: scv, availability: 0.94, targetUtil: 0.85, waitTarget: 600, confidence: 0.95, ca2 });
  const m = ggcMetrics(5, lamPeakPerH / 3600 / 0.94, meanS, scv, ca2);
  console.log('ca2', ca2, 'servers', s.servers, 'P95 wait @5 =', (m.waitQuantile(0.95) / 60).toFixed(1), 'min');
}
