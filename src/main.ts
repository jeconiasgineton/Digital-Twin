import './styles.css';
import { analyzeCapacity } from './analysis/capacity';
import { defaultScenario } from './model/defaults';
import { defaultLayoutParams, generateLayout } from './model/layoutGen';
import type { ExperimentResult, Layout, Scenario } from './model/types';
import { runInWorker } from './sim/client';
import type { SweepPoint } from './sim/runner';
import type { AppCtx } from './ui/ctx';
import { download, fmt, h, toast } from './ui/dom';
import { Editor, TOOL_LABEL, type Tool } from './ui/editor';
import { loadExcelFile, pickExcel, downloadTemplate, renderDataPanel } from './ui/panelData';
import { renderLayoutPanel } from './ui/panelLayout';
import { renderResultsPanel } from './ui/panelResults';
import { renderSimPanel } from './ui/panelSim';
import { renderSizingPanel } from './ui/panelSizing';
import { Playback } from './view/playback';
import { SceneView } from './view/scene';

const $ = (id: string) => document.getElementById(id)!;

/* ------------------------------ estado ------------------------------ */
let scenario: Scenario = defaultScenario();
let layout: Layout = generateLayout(defaultLayoutParams());

const view = new SceneView($('viewport'));
view.levelHeight = scenario.levelHeight;
view.setLayout(layout);
view.setMode('3d');
const playback = new Playback(view);

let currentTab = 'layout';
let simPanel: { el: HTMLElement; update: () => void } | null = null;
let progressEl: HTMLElement | null = null;

const ctx: AppCtx = {
  get scenario() { return scenario; },
  get layout() { return layout; },
  result: null,
  capacity: null,
  sweeps: {} as Record<string, SweepPoint[]>,
  view,
  editor: null as unknown as Editor,
  playback,
  busy: false,
  scenarioChanged() { schedule(); },
  layoutChanged() { schedule(); },
  loadLayout(l, fit) {
    layout = l;
    if (!layout.floor) layout.floor = { width: 80, depth: 50 };
    view.levelHeight = scenario.levelHeight;
    view.setLayout(layout);
    ctx.editor.resetHistory();
    ctx.editor.setSelection([]);
    if (fit) view.fit();
    schedule(0);
  },
  loadScenario(s) {
    scenario = s;
    ctx.sweeps = {};
    ctx.result = null;
    schedule(0);
  },
  rerender() { renderPanel(); },
  openTab(name) { openTab(name); },
  async runMonteCarlo() {
    if (ctx.busy) return;
    ctx.busy = true;
    const sc = JSON.parse(JSON.stringify(scenario)) as Scenario;
    try {
      const res: ExperimentResult = await runInWorker(sc, layout, (d, t) => {
        const bar = document.querySelector('#panel .progress > div') as HTMLElement | null;
        if (bar) bar.style.width = `${(d / t) * 100}%`;
      });
      ctx.result = res;
      toast(`Monte Carlo concluído: ${res.replications} réplicas em ${(res.elapsedMs / 1000).toFixed(1)} s.`);
    } catch (e) {
      console.error(e);
      toast('Falha na simulação: ' + (e as Error).message, 'err');
    } finally {
      ctx.busy = false;
      renderPanel();
    }
  },
};
void progressEl;

ctx.editor = new Editor(view, () => layout, {
  changed: () => schedule(),
  selected: () => { if (currentTab === 'layout') rafRender(); },
  toolChanged: (t) => updateTools(t),
});

/* ---------------------- recalculo com debounce ---------------------- */
let timer = 0;
function schedule(delay = 450) {
  clearTimeout(timer);
  timer = window.setTimeout(recompute, delay);
}

function recompute() {
  try {
    ctx.capacity = analyzeCapacity(scenario, layout);
  } catch (e) {
    console.warn('análise falhou', e);
    ctx.capacity = null;
  }
  const wasPlaying = playback.playing;
  view.levelHeight = scenario.levelHeight;
  try {
    playback.reset(scenario, layout);
  } catch (e) {
    console.warn('simulação ao vivo falhou', e);
  }
  playback.playing = wasPlaying;
  updatePlayBtn();
  if (currentTab === 'sizing' || currentTab === 'layout' || currentTab === 'sim') renderPanel();
}

let raf = 0;
function rafRender() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(renderPanel);
}

/* ------------------------------ painéis ------------------------------ */
const TABS: [string, string][] = [['layout', 'Layout'], ['data', 'Dados'], ['sim', 'Simulação'], ['results', 'Resultados'], ['sizing', 'Dimensionar']];

function renderTabs() {
  const t = $('tabs');
  t.innerHTML = '';
  for (const [k, label] of TABS) t.append(h('button', { class: k === currentTab ? 'on' : '', onclick: () => openTab(k) }, label));
}

function openTab(k: string) {
  currentTab = k;
  renderTabs();
  renderPanel();
}

function renderPanel() {
  const p = $('panel');
  const top = p.scrollTop;
  p.innerHTML = '';
  simPanel = null;
  switch (currentTab) {
    case 'layout': p.append(renderLayoutPanel(ctx)); break;
    case 'data': p.append(renderDataPanel(ctx)); break;
    case 'sim': simPanel = renderSimPanel(ctx); p.append(simPanel.el); simPanel.update(); break;
    case 'results': p.append(renderResultsPanel(ctx)); break;
    case 'sizing': p.append(renderSizingPanel(ctx)); break;
  }
  p.scrollTop = top;
}

/* ------------------------------ ferramentas ------------------------------ */
const ICONS: Record<Tool, string> = {
  select: '<path d="M5 3l12 8-5 1.2L9.5 18z"/>',
  rack: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9.3h18M3 14.6h18M9 4v16M15 4v16"/>',
  wall: '<path d="M3 20V6h6v6h6V4h6v16"/>',
  conveyor: '<rect x="2" y="9" width="20" height="6" rx="3"/><path d="M7 12h.01M12 12h.01M17 12h.01"/>',
  dockIn: '<path d="M4 20V8l8-4 8 4v12"/><path d="M12 10v7m-3-3l3 3 3-3"/>',
  dockOut: '<path d="M4 20V8l8-4 8 4v12"/><path d="M12 17v-7m-3 3l3-3 3 3"/>',
  zone: '<rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3 2.5"/>',
  station: '<path d="M4 18h16M6 18v-7h12v7M9 11V7h6v4"/>',
  parking: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M10 16V8h3a2.5 2.5 0 010 5h-3"/>',
};
const TOOL_ORDER: Tool[] = ['select', 'rack', 'wall', 'conveyor', 'dockIn', 'dockOut', 'zone', 'station', 'parking'];
const HINTS: Record<Tool, string> = {
  select: 'Clique para selecionar · arraste para mover · R gira · Del exclui · botão direito move a câmera',
  rack: 'Arraste para desenhar um rack (comprimento = distância arrastada) ou clique para inserir um padrão',
  wall: 'Clique para cada vértice da parede · duplo-clique/Enter termina · Shift trava em 0°/90° · Esc cancela',
  conveyor: 'Arraste do início ao fim da esteira (o início é o ponto de indução dos operários)',
  dockIn: 'Clique perto de uma parede – a doca encaixa e se orienta automaticamente',
  dockOut: 'Clique perto de uma parede – a doca encaixa e se orienta automaticamente',
  zone: 'Arraste para definir uma zona (staging, conferência…). Nomes com "staging/conferência/expedição" ficam azuis',
  station: 'Clique para inserir uma estação de embalagem/expedição (limita a consolidação de pedidos)',
  parking: 'Arraste para definir a área onde empilhadeiras/operários ficam estacionados no início',
};

function renderTools() {
  const n = $('tools');
  n.innerHTML = '';
  TOOL_ORDER.forEach((t, i) => {
    if (i === 1) n.append(h('div', { class: 'tsep' }));
    const b = h('button', { class: 'tool', title: TOOL_LABEL[t], 'data-tool': t, onclick: () => ctx.editor.setTool(t) });
    b.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[t]}</svg><span>${TOOL_LABEL[t].split(' ')[0]}</span>`;
    n.append(b);
  });
  n.append(h('div', { class: 'tsep' }));
  const mk = (label: string, title: string, svg: string, fn: () => void) => {
    const b = h('button', { class: 'tool', title, onclick: fn });
    b.innerHTML = `<svg viewBox="0 0 24 24">${svg}</svg><span>${label}</span>`;
    return b;
  };
  n.append(
    mk('Desfazer', 'Desfazer (Ctrl+Z)', '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>', () => ctx.editor.undo()),
    mk('Refazer', 'Refazer (Ctrl+Y)', '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>', () => ctx.editor.redo()),
  );
}

function updateTools(t: Tool) {
  document.querySelectorAll('#tools .tool[data-tool]').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.tool === t));
  $('hint').textContent = HINTS[t];
}

/* ------------------------------ topo + HUD ------------------------------ */
function renderTop() {
  const t = $('top');
  t.append(
    h('div', { class: 'brand', html: '<svg width="22" height="22" viewBox="0 0 32 32"><path d="M16 5l10 5.5v11L16 27 6 21.5v-11z" fill="none" stroke="#38bdf8" stroke-width="2.2"/><path d="M6 10.5l10 5.5 10-5.5M16 16v11" stroke="#f59e0b" stroke-width="2.2" fill="none"/></svg><span>Digital Twin <b>Logístico</b></span>' }),
    h('button', { class: 'b pri', onclick: () => pickExcel(ctx) }, '📥 Importar Excel'),
    h('button', { class: 'b', onclick: () => downloadTemplate(ctx) }, '📄 Modelo .xlsx'),
    h('div', { class: 'sep' }),
    h('button', { class: 'b', onclick: () => { ctx.loadScenario(defaultScenario()); ctx.loadLayout(generateLayout(defaultLayoutParams()), true); toast('Exemplo carregado.'); } }, 'Exemplo'),
    h('button', { class: 'b', onclick: () => { openTab('results'); ctx.runMonteCarlo(); } }, '▶ Rodar Monte Carlo'),
    h('div', { style: { flex: '1' } }),
    h('span', { class: 'note', id: 'status' }, 'Arraste uma planilha .xlsx para a tela'),
  );
}

const SPEEDS = [1, 10, 60, 300, 1200, 4000];
function renderHud() {
  const hud = $('hud');
  const clock = h('div', { class: 'clock' }, '00:00', h('small', null, 'dia 1'));
  const play = h('button', { class: 'b pri', id: 'playbtn', onclick: () => { playback.playing = !playback.playing; updatePlayBtn(); } }, '⏸ Pausar');
  const speedBtns = SPEEDS.map((s) => h('button', { class: 'b sm' + (s === playback.speed ? ' on' : ''), 'data-s': s, onclick: () => { playback.speed = s; document.querySelectorAll('#hud [data-s]').forEach((b) => b.classList.toggle('on', Number((b as HTMLElement).dataset.s) === s)); } }, `${s}×`));
  const live = h('div', { class: 'live' });
  const more = h('div');
  let collapsed = false;
  const toggle = h('button', { class: 'b sm', title: 'Recolher/expandir painel', onclick: () => { collapsed = !collapsed; more.style.display = collapsed ? 'none' : ''; toggle.textContent = collapsed ? '▾' : '▴'; } }, '▴');
  hud.append(h('div', { class: 'hudcard' }, clock, h('div', { class: 'ctrl' }, play, h('button', { class: 'b sm', title: 'Reiniciar', onclick: () => playback.reset(scenario, layout) }, '↺'), toggle), more));
  more.append(h('div', { class: 'ctrl' }, speedBtns), live);
  playback.onUpdate = () => {
    const c = playback.clockString();
    clock.firstChild!.textContent = c.hhmm;
    (clock.querySelector('small') as HTMLElement).textContent = `dia ${c.day}`;
    const s = playback.model.snapshot();
    const kv: [string, string][] = [
      ['Paletes recebidos', fmt(s.palletsIn, 0)], ['Paletes expedidos', fmt(s.palletsOut, 0)], ['Pedidos', fmt(s.orders, 0)],
      ['Fila empilh.', fmt(s.queueForklift, 0)], ['Fila pedidos', fmt(s.queueWorker, 0)], ['Estoque', `${(s.occupancy * 100).toFixed(0)}%`],
    ];
    live.innerHTML = '';
    kv.forEach(([k, v]) => live.append(h('span', null, k), h('span', null, v)));
    simPanel?.update();
  };
  const vb = h('div', { id: 'viewbtns' },
    h('button', { class: 'b', onclick: () => view.setMode('3d') }, '3D'),
    h('button', { class: 'b', onclick: () => view.setMode('2d') }, '2D planta'),
    h('button', { class: 'b', title: 'Enquadrar', onclick: () => view.fit() }, '⤢'),
  );
  $('stage').append(vb);
}

function updatePlayBtn() {
  const b = document.getElementById('playbtn');
  if (b) b.textContent = playback.playing ? '⏸ Pausar' : '▶ Iniciar';
}

/* ------------------------------ inicialização ------------------------------ */
renderTop();
renderTools();
renderTabs();
renderHud();
updateTools('select');
view.onFrame((dt) => playback.tick(dt));
window.addEventListener('keydown', (e) => {
  const tg = e.target as HTMLElement;
  if (e.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tg.tagName)) {
    e.preventDefault();
    playback.playing = !playback.playing;
    updatePlayBtn();
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  if (/\.xlsx?m?$/i.test(f.name)) loadExcelFile(ctx, f);
  else if (/\.json$/i.test(f.name)) f.text().then((t) => { try { ctx.loadLayout(JSON.parse(t), true); } catch { toast('JSON inválido', 'err'); } });
});

playback.playing = true;
recompute();
openTab('layout');
(window as any).__dt = { ctx, view, playback, download };
