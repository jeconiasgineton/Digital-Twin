import type { ExperimentResult, Layout, Scenario } from '../model/types';
import type { SweepParam, SweepPoint } from './runner';
import { runExperiment, runSweep } from './runner';

let worker: Worker | null = null;
let seq = 0;

function getWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  return worker;
}

export function cancelWork() {
  worker?.terminate();
  worker = null;
}

function call<T>(msg: any, onProgress?: (d: number, t: number) => void, fallback?: () => T): Promise<T> {
  const w = getWorker();
  if (!w) return Promise.resolve(fallback!());
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (d.id !== id) return;
      if (d.type === 'progress') onProgress?.(d.done, d.total);
      else {
        w.removeEventListener('message', onMsg);
        if (d.type === 'done') resolve(d.result);
        else reject(new Error(d.message));
      }
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', (ev) => reject(new Error(ev.message)), { once: true });
    w.postMessage({ id, ...msg });
  });
}

export const runInWorker = (sc: Scenario, layout: Layout, onProgress?: (d: number, t: number) => void) =>
  call<ExperimentResult>({ kind: 'run', sc, layout }, onProgress, () => runExperiment(sc, layout, onProgress));

export const sweepInWorker = (sc: Scenario, layout: Layout, param: SweepParam, values: number[], onProgress?: (d: number, t: number) => void) =>
  call<SweepPoint[]>({ kind: 'sweep', sc, layout, param, values }, onProgress, () => runSweep(sc, layout, param, values, onProgress));
