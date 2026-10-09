/// <reference lib="webworker" />
import { runExperiment, runSweep, type SweepParam } from './runner';
import type { Layout, Scenario } from '../model/types';

type Msg =
  | { id: number; kind: 'run'; sc: Scenario; layout: Layout }
  | { id: number; kind: 'sweep'; sc: Scenario; layout: Layout; param: SweepParam; values: number[] };

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (m.kind === 'run') {
      const res = runExperiment(m.sc, m.layout, (done, total) => (self as any).postMessage({ id: m.id, type: 'progress', done, total }));
      (self as any).postMessage({ id: m.id, type: 'done', result: res });
    } else {
      const res = runSweep(m.sc, m.layout, m.param, m.values, (done, total) => (self as any).postMessage({ id: m.id, type: 'progress', done, total }));
      (self as any).postMessage({ id: m.id, type: 'done', result: res });
    }
  } catch (err) {
    (self as any).postMessage({ id: m.id, type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
