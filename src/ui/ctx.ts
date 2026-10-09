import type { ExperimentResult, Layout, Scenario } from '../model/types';
import type { CapacityReport } from '../analysis/capacity';
import type { SweepPoint } from '../sim/runner';
import type { Playback } from '../view/playback';
import type { SceneView } from '../view/scene';
import type { Editor } from './editor';

export interface AppCtx {
  scenario: Scenario;
  layout: Layout;
  result: ExperimentResult | null;
  capacity: CapacityReport | null;
  sweeps: Record<string, SweepPoint[]>;
  view: SceneView;
  editor: Editor;
  playback: Playback;
  /** parâmetros do cenário mudaram */
  scenarioChanged(): void;
  /** layout mudou */
  layoutChanged(kind?: string): void;
  loadLayout(l: Layout, fit?: boolean): void;
  loadScenario(s: Scenario): void;
  rerender(): void;
  openTab(name: string): void;
  runMonteCarlo(): Promise<void>;
  busy: boolean;
}
