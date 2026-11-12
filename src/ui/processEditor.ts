import { distMean } from '../math/rng';
import {
  ITEM_LABEL, PLACE_LABEL, RESOURCE_KINDS, RESOURCE_LABEL, STEP_COLOR, STEP_HELP, STEP_LABEL, addStep, autoLayout, connect, getPort, portsOf, removeStep, stepById,
  validateProcess, type PlaceKind, type PlaceRef, type ProcessDef, type ResourceKind, type Step, type StepType,
} from '../model/process';
import type { Dist, DistKind } from '../model/types';
import type { AppCtx } from './ctx';
import { h, numField, selField, textField } from './dom';
import { DIST_KINDS, DIST_LABELS } from './panelData';

const NS = 'http://www.w3.org/2000/svg';
const NW = 220; // largura do bloco
const NH = 66; // altura do bloco

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...kids: (SVGElement | string)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of kids) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

const PALETTE: StepType[] = ['move', 'lift', 'retrieve', 'palletize', 'depalletize', 'separate', 'check', 'decide', 'address', 'wait', 'end'];

/* ----------------------------------------------------------- resumos */

function placeText(ref: PlaceRef, ctx: AppCtx): string {
  if (ref.kind === 'area') return ctx.layout.elements.find((e) => e.id === ref.areaId)?.name ?? 'Área (escolha)';
  return PLACE_LABEL[ref.kind];
}

const resText = (w: ResourceKind[]) => (w.length ? w.map((r) => RESOURCE_LABEL[r]).join(' / ') : 'sem recurso');
const sec = (d: Dist) => `${distMean(d).toFixed(0)} s`;

function summary(s: Step, ctx: AppCtx): [string, string] {
  switch (s.type) {
    case 'move': return [`${ITEM_LABEL[s.item]}: ${placeText(s.from, ctx)} → ${placeText(s.to, ctx)}`, `${resText(s.with)} · ${sec(s.handling)}`];
    case 'lift': return [s.direction === 'put' ? 'Guardar no endereço (elevar)' : 'Retirar do endereço', `${resText(s.with)} · ${sec(s.handling)}`];
    case 'retrieve': return [`${s.quantity.mode === 'all' ? 'Todas as' : s.quantity.mode === 'count' ? `${s.quantity.value}` : `${Math.round(s.quantity.value * 100)}% das`} ${s.item === 'carton' ? 'caixas' : 'fardos'}`, `${resText(s.with)} · ${sec(s.perItem)}/un.`];
    case 'palletize': return ['Agrupar em palete', `${resText(s.with)} · ${sec(s.perItem)}/un.`];
    case 'depalletize': return [`Desfazer em ${s.item === 'carton' ? 'caixas' : 'fardos'}`, `${resText(s.with)} · ${sec(s.perItem)}/un.`];
    case 'separate': return ['Separar avariados em outro palete', `${resText(s.with)} · ${sec(s.perItem)}/caixa`];
    case 'check': return [`Conferir · avaria ${(s.damagePct * 100).toFixed(1)}%`, `${resText(s.with)} · ${sec(s.time)}`];
    case 'decide': return [s.condition === 'damaged' ? 'Está avariado?' : s.condition === 'wholeDamaged' ? 'Todo avariado?' : s.condition === 'prob' ? `Sorteio ${(s.value * 100).toFixed(0)}%` : `Mais de ${s.value} itens?`, ''];
    case 'address': return [s.mode === 'put' ? 'Reservar posição (regra ABC)' : 'Escolher posição a retirar', ''];
    case 'wait': return ['Aguardar', sec(s.time)];
    case 'start': return ['Cada palete que sai do veículo', ''];
    case 'end': return ['Encerra o item', ''];
  }
}

/* --------------------------------------------------------- inspetor */

function distEditor(label: string, get: () => Dist, set: (d: Dist) => void, redraw: () => void): HTMLElement {
  const d = get();
  const sel = h('select', null, DIST_KINDS.map(([k, n]) => h('option', { value: k, selected: k === d.kind }, n)));
  sel.addEventListener('change', () => {
    const k = sel.value as DistKind;
    const m = distMean(d) || 1;
    set(k === 'triangular' ? { kind: k, a: m * 0.7, b: m, c: m * 1.5 } : k === 'uniform' ? { kind: k, a: m * 0.7, b: m * 1.3 } : k === 'normal' || k === 'lognormal' ? { kind: k, a: m, b: m * 0.25 } : { kind: k, a: m });
    redraw();
  });
  const labels = DIST_LABELS[d.kind];
  const mk = (idx: 'a' | 'b' | 'c', ph: string) => {
    if (!ph) return null;
    const i = h('input', { type: 'number', step: 'any', value: String(+(d[idx] ?? 0).toFixed(3)), title: ph, placeholder: ph, style: { width: '64px' } });
    i.addEventListener('change', () => {
      const v = parseFloat(i.value);
      if (Number.isFinite(v)) {
        set({ ...get(), [idx]: v } as Dist);
        redraw();
      }
    });
    return i;
  };
  return h('div', { class: 'ins-row' }, h('span', { class: 'note' }, label), h('div', { class: 'row' }, sel, mk('a', labels[0]), mk('b', labels[1]), mk('c', labels[2])));
}

function placeEditor(label: string, ref: PlaceRef, set: (r: PlaceRef) => void, ctx: AppCtx, redraw: () => void, allowed: PlaceKind[]): HTMLElement {
  const sel = h('select', null, allowed.map((k) => h('option', { value: k, selected: k === ref.kind }, PLACE_LABEL[k])));
  sel.addEventListener('change', () => { set({ kind: sel.value as PlaceKind, areaId: undefined }); redraw(); });
  const kids: HTMLElement[] = [h('span', { class: 'note' }, label), sel];
  if (ref.kind === 'area') {
    const areas = ctx.layout.elements.filter((e) => e.type !== 'wall' && e.type !== 'rack' && e.type !== 'conveyor');
    const a = h('select', null, [h('option', { value: '' }, 'escolha…'), ...areas.map((e) => h('option', { value: e.id, selected: e.id === ref.areaId }, `${e.name} (${e.type})`))]);
    a.addEventListener('change', () => { set({ kind: 'area', areaId: a.value || undefined }); redraw(); });
    kids.push(a);
  }
  return h('div', { class: 'ins-row' }, ...kids);
}

function resourceEditor(label: string, get: () => ResourceKind[], set: (r: ResourceKind[]) => void, redraw: () => void, kinds: ResourceKind[] = RESOURCE_KINDS): HTMLElement {
  return h('div', { class: 'ins-row' }, h('span', { class: 'note' }, label),
    h('div', { class: 'row' }, kinds.map((k) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: get().includes(k), onchange: (ev: Event) => {
      set((ev.target as HTMLInputElement).checked ? [...new Set([...get(), k])] : get().filter((x) => x !== k));
      redraw();
    } }), RESOURCE_LABEL[k]))));
}

function inspector(s: Step, ctx: AppCtx, redraw: () => void, remove: () => void): HTMLElement {
  const f: HTMLElement[] = [h('p', { class: 'note' }, STEP_HELP[s.type]), textField('Nome do bloco (opcional)', () => s.label ?? '', (v) => { s.label = v.trim() || undefined; redraw(); })];
  const ch = () => ctx.scenarioChanged();
  const dist = (label: string, key: string) => f.push(distEditor(label, () => (s as any)[key], (d) => { (s as any)[key] = d; ch(); }, redraw));
  const all: PlaceKind[] = ['trailer', 'dock', 'stage', 'transit', 'triage', 'rack', 'area', 'here'];
  switch (s.type) {
    case 'move':
      f.push(
        selField('O que movimentar', () => s.item, (v) => { s.item = v; ch(); redraw(); }, [['pallet', 'Palete'], ['carton', 'Caixa'], ['bundle', 'Fardo']]),
        placeEditor('De', s.from, (r) => { s.from = r; ch(); }, ctx, redraw, all),
        placeEditor('Para', s.to, (r) => { s.to = r; ch(); }, ctx, redraw, all.filter((k) => k !== 'trailer')),
        resourceEditor('Com quê (o disponível é acionado)', () => s.with, (r) => { s.with = r; ch(); }, redraw),
      );
      dist(s.item === 'pallet' ? 'Tempo de manuseio (s)' : 'Tempo de manuseio por item (s)', 'handling');
      f.push(h('p', { class: 'note' }, 'Stage, rua e triagem têm capacidade: o item reserva espaço e espera se estiver cheio. "Dentro do veículo" libera o caminhão quando todos os paletes saem.'));
      break;
    case 'lift':
      f.push(
        selField('Ação', () => s.direction, (v) => { s.direction = v; ch(); redraw(); }, [['put', 'Guardar: levar ao endereço e elevar'], ['take', 'Retirar da posição do endereço']]),
        resourceEditor('Com quê', () => s.with, (r) => { s.with = r; ch(); }, redraw, ['forklift', 'palletJack', 'palletTruck', 'amr']),
      );
      dist('Tempo de posicionamento (s)', 'handling');
      f.push(h('p', { class: 'note' }, 'Precisa de um bloco Endereçar antes: ele define a rua, a estante e o nível.'));
      break;
    case 'retrieve':
      f.push(
        selField('Retirar', () => s.item, (v) => { s.item = v; ch(); }, [['carton', 'Caixas'], ['bundle', 'Fardos']]),
        selField('Quantidade', () => s.quantity.mode, (v) => { s.quantity = { mode: v, value: v === 'fraction' ? 0.5 : 1 }; ch(); redraw(); }, [['all', 'Todas'], ['count', 'Um número'], ['fraction', 'Uma fração']]),
      );
      if (s.quantity.mode !== 'all') f.push(numField(s.quantity.mode === 'count' ? 'Quantidade' : 'Fração (0–1)', () => s.quantity.value, (v) => { s.quantity = { ...s.quantity, value: v }; ch(); redraw(); }, { step: s.quantity.mode === 'count' ? 1 : 0.05, min: 0 }));
      f.push(resourceEditor('Com quê', () => s.with, (r) => { s.with = r; ch(); }, redraw));
      dist('Tempo por item (s)', 'perItem');
      break;
    case 'palletize':
      f.push(resourceEditor('Com quê', () => s.with, (r) => { s.with = r; ch(); }, redraw));
      dist('Tempo por item (s)', 'perItem');
      break;
    case 'depalletize':
      f.push(selField('Desfazer em', () => s.item, (v) => { s.item = v; ch(); }, [['carton', 'Caixas'], ['bundle', 'Fardos']]), resourceEditor('Com quê', () => s.with, (r) => { s.with = r; ch(); }, redraw));
      dist('Tempo por item (s)', 'perItem');
      break;
    case 'separate':
      f.push(resourceEditor('Quem separa', () => s.with, (r) => { s.with = r; ch(); }, redraw));
      dist('Tempo por caixa movida (s)', 'perItem');
      f.push(h('p', { class: 'note' }, 'Saída "bons": o palete original segue. Saída "avariados": o segundo palete (ou o próprio palete, se nenhuma caixa estiver boa).'));
      break;
    case 'check':
      f.push(
        resourceEditor('Quem confere', () => s.with, (r) => { s.with = r; ch(); }, redraw),
        numField('Chance de avaria', () => s.damagePct * 100, (v) => { s.damagePct = Math.min(1, Math.max(0, v / 100)); ch(); redraw(); }, { step: 0.5, min: 0, max: 100, unit: '%' }),
        numField('Acréscimo no tempo se avariado', () => (s.damagedFactor - 1) * 100, (v) => { s.damagedFactor = 1 + Math.max(0, v) / 100; ch(); }, { step: 10, min: 0, unit: '%' }),
      );
      dist('Tempo de conferência (s)', 'time');
      dist('Fração de caixas avariadas (0–1)', 'damagedFraction');
      break;
    case 'decide':
      f.push(selField('Condição', () => s.condition, (v) => { s.condition = v; ch(); redraw(); }, [['damaged', 'Está avariado'], ['wholeDamaged', 'Está todo avariado'], ['prob', 'Sorteio (probabilidade)'], ['countAbove', 'Tem mais itens que…']]));
      if (s.condition === 'prob') f.push(numField('Probabilidade de "sim"', () => s.value * 100, (v) => { s.value = Math.min(1, Math.max(0, v / 100)); ch(); redraw(); }, { step: 5, min: 0, max: 100, unit: '%' }));
      if (s.condition === 'countAbove') f.push(numField('Itens', () => s.value, (v) => { s.value = v; ch(); redraw(); }, { step: 1, min: 0 }));
      break;
    case 'address':
      f.push(selField('Ação', () => s.mode, (v) => { s.mode = v; ch(); redraw(); }, [['put', 'Reservar posição livre para guardar'], ['take', 'Escolher posição ocupada para retirar']]));
      break;
    case 'wait':
      dist('Tempo (s)', 'time');
      break;
    default:
      break;
  }
  if (s.type !== 'start') f.push(h('button', { class: 'b danger sm', onclick: remove }, 'Excluir bloco'));
  return h('div', { class: 'ins' }, ...f);
}

/* ------------------------------------------------------------ editor */

/** abre o editor visual de blocos e setas para um processo */
export function openProcessEditor(ctx: AppCtx, def: ProcessDef, onClose: () => void) {
  const sc = ctx.scenario;
  let selStep: string | undefined = def.steps.find((s) => s.type === 'start')?.id;
  let selEdge: { from: string; port: string } | undefined;
  const view = { x: 40, y: 20, k: 1 };
  let connecting: { from: string; port: string; x: number; y: number } | null = null;

  const back = h('div', { class: 'modal-back pe-back', tabindex: '-1' });
  const nameIn = textField('Nome do processo', () => def.name, (v) => { def.name = v.trim() || def.name; ctx.scenarioChanged(); });
  const issuesBox = h('div', { class: 'pe-issues' });
  const insBox = h('div', { class: 'pe-ins' });
  const canvas = svg('svg', { class: 'pe-canvas' });
  const g = svg('g');
  canvas.append(
    svg('defs', {}, svg('marker', { id: 'arr', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, svg('path', { d: 'M0 0L10 5L0 10z', fill: '#8b97ad' }))),
    g,
  );

  const portPos = (s: Step, key: string): { x: number; y: number } => {
    const ps = portsOf(s);
    const i = Math.max(0, ps.findIndex((p) => p.key === key));
    return { x: s.x + (NW * (i + 1)) / (ps.length + 1), y: s.y + NH };
  };
  const inPos = (s: Step) => ({ x: s.x + NW / 2, y: s.y });
  const edgePath = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dy = Math.max(40, Math.abs(b.y - a.y) / 2);
    return `M${a.x},${a.y} C${a.x},${a.y + dy} ${b.x},${b.y - dy} ${b.x},${b.y}`;
  };
  const toWorld = (ev: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left - view.x) / view.k, y: (ev.clientY - r.top - view.y) / view.k };
  };

  const redrawIssues = () => {
    const iss = validateProcess(def);
    issuesBox.replaceChildren(
      h('b', null, iss.length ? `Verificação (${iss.filter((i) => i.level === 'erro').length} erro(s), ${iss.filter((i) => i.level === 'aviso').length} aviso(s))` : '✅ Processo válido'),
      ...iss.map((i) => h('div', { class: `pe-iss ${i.level}`, onclick: () => { if (i.stepId) { selStep = i.stepId; selEdge = undefined; draw(); } } }, `${i.level === 'erro' ? '⛔' : '⚠️'} ${i.msg}`)),
    );
  };

  const redrawInspector = () => {
    const s = stepById(def, selStep);
    insBox.replaceChildren(
      h('b', null, s ? STEP_LABEL[s.type] : 'Nenhum bloco selecionado'),
      s ? inspector(s, ctx, draw, () => { removeStep(def, s.id); selStep = undefined; ctx.scenarioChanged(); draw(); }) : h('p', { class: 'note' }, 'Clique num bloco para editar. Arraste um bloco para movê-lo; arraste da bolinha de saída até outro bloco para ligar. Selecione uma seta e tecle Delete para desligar.'),
    );
  };

  const draw = () => {
    g.replaceChildren();
    g.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
    // setas
    for (const s of def.steps) for (const p of portsOf(s)) {
      const to = stepById(def, getPort(s, p.key));
      if (!to) continue;
      const d = edgePath(portPos(s, p.key), inPos(to));
      const sel = selEdge?.from === s.id && selEdge.port === p.key;
      const path = svg('path', { d, fill: 'none', stroke: sel ? '#38bdf8' : '#8b97ad', 'stroke-width': sel ? 3 : 2, 'marker-end': 'url(#arr)' });
      const hit = svg('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': 14, style: 'cursor:pointer' });
      hit.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); selEdge = { from: s.id, port: p.key }; selStep = undefined; draw(); });
      g.append(path, hit);
    }
    if (connecting) {
      const s = stepById(def, connecting.from)!;
      g.append(svg('path', { d: edgePath(portPos(s, connecting.port), { x: connecting.x, y: connecting.y }), fill: 'none', stroke: '#38bdf8', 'stroke-width': 2, 'stroke-dasharray': '5 4' }));
    }
    // blocos
    for (const s of def.steps) {
      const [t1, t2] = summary(s, ctx);
      const color = STEP_COLOR[s.type];
      const sel = selStep === s.id;
      const node = svg('g', { transform: `translate(${s.x},${s.y})`, style: 'cursor:grab' });
      node.append(
        svg('rect', { width: NW, height: NH, rx: 9, fill: '#172238', stroke: sel ? '#38bdf8' : '#25314a', 'stroke-width': sel ? 2.5 : 1.5 }),
        svg('rect', { width: 6, height: NH, rx: 3, fill: color }),
        svg('text', { x: 14, y: 20, fill: '#e5e9f2', 'font-size': 12.5, 'font-weight': 700 }, s.label || STEP_LABEL[s.type]),
        svg('text', { x: 14, y: 38, fill: '#8b97ad', 'font-size': 10.5 }, t1.length > 36 ? `${t1.slice(0, 35)}…` : t1),
        svg('text', { x: 14, y: 54, fill: '#8b97ad', 'font-size': 10 }, t2.length > 40 ? `${t2.slice(0, 39)}…` : t2),
      );
      if (s.type !== 'start') node.append(svg('circle', { cx: NW / 2, cy: 0, r: 5, fill: '#0b1220', stroke: '#8b97ad', 'stroke-width': 1.5 }));
      portsOf(s).forEach((p) => {
        const pp = portPos(s, p.key);
        const cx = pp.x - s.x;
        const dot = svg('circle', { cx, cy: NH, r: 6, fill: getPort(s, p.key) ? '#8b97ad' : '#38bdf8', stroke: '#0b1220', 'stroke-width': 1.5, style: 'cursor:crosshair' });
        dot.addEventListener('pointerdown', (ev) => {
          ev.stopPropagation();
          const w = toWorld(ev);
          connecting = { from: s.id, port: p.key, x: w.x, y: w.y };
          canvas.setPointerCapture(ev.pointerId);
        });
        node.append(dot);
        if (p.label) node.append(svg('text', { x: cx, y: NH + 17, fill: '#8b97ad', 'font-size': 9.5, 'text-anchor': 'middle' }, p.label));
      });
      node.addEventListener('pointerdown', (ev) => {
        if ((ev.target as Element).tagName === 'circle') return;
        ev.stopPropagation();
        selStep = s.id;
        selEdge = undefined;
        const w0 = toWorld(ev);
        const ox = s.x;
        const oy = s.y;
        const move = (e: PointerEvent) => {
          const w = toWorld(e);
          s.x = Math.round(ox + w.x - w0.x);
          s.y = Math.round(oy + w.y - w0.y);
          draw();
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); ctx.scenarioChanged(); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        draw();
      });
      g.append(node);
    }
    redrawInspector();
    redrawIssues();
  };

  // conectar arrastando da porta; mover o quadro; zoom
  canvas.addEventListener('pointermove', (ev) => {
    if (!connecting) return;
    const w = toWorld(ev);
    connecting.x = w.x;
    connecting.y = w.y;
    draw();
  });
  canvas.addEventListener('pointerup', (ev) => {
    if (!connecting) return;
    const w = toWorld(ev);
    const target = def.steps.find((s) => w.x >= s.x && w.x <= s.x + NW && w.y >= s.y - 8 && w.y <= s.y + NH);
    if (target) connect(def, connecting.from, connecting.port as 'next', target.id);
    connecting = null;
    ctx.scenarioChanged();
    draw();
  });
  canvas.addEventListener('pointerdown', (ev) => {
    if (connecting) return;
    selStep = undefined;
    selEdge = undefined;
    const sx = ev.clientX;
    const sy = ev.clientY;
    const ox = view.x;
    const oy = view.y;
    const move = (e: PointerEvent) => { view.x = ox + e.clientX - sx; view.y = oy + e.clientY - sy; draw(); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    draw();
  });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    const my = ev.clientY - r.top;
    const k = Math.min(2.2, Math.max(0.3, view.k * (ev.deltaY < 0 ? 1.1 : 0.9)));
    view.x = mx - ((mx - view.x) / view.k) * k;
    view.y = my - ((my - view.y) / view.k) * k;
    view.k = k;
    draw();
  }, { passive: false });

  const fit = () => {
    if (!def.steps.length) return;
    const r = canvas.getBoundingClientRect();
    const x0 = Math.min(...def.steps.map((s) => s.x));
    const y0 = Math.min(...def.steps.map((s) => s.y));
    const x1 = Math.max(...def.steps.map((s) => s.x + NW));
    const y1 = Math.max(...def.steps.map((s) => s.y + NH + 24));
    const k = Math.min(1.2, Math.max(0.3, Math.min((r.width - 40) / (x1 - x0), (r.height - 40) / (y1 - y0))));
    view.k = k;
    view.x = (r.width - (x1 - x0) * k) / 2 - x0 * k;
    view.y = 20 - y0 * k;
    draw();
  };

  const keyHandler = (ev: KeyboardEvent) => {
    const tag = (ev.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (ev.key === 'Escape') (ev.target as HTMLElement).blur();
      ev.stopPropagation();
      return;
    }
    ev.stopImmediatePropagation(); // o editor de layout não deve reagir enquanto este está aberto
    if (ev.key === 'Escape') close();
    else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (selEdge) {
        connect(def, selEdge.from, selEdge.port as 'next', undefined);
        selEdge = undefined;
      } else if (selStep && stepById(def, selStep)?.type !== 'start') {
        removeStep(def, selStep);
        selStep = undefined;
      }
      ctx.scenarioChanged();
      draw();
    }
  };
  document.addEventListener('keydown', keyHandler, true);
  const close = () => {
    document.removeEventListener('keydown', keyHandler, true);
    back.remove();
    ctx.scenarioChanged();
    onClose();
  };

  const palette = h('div', { class: 'pe-palette' },
    h('b', null, 'Ações'),
    ...PALETTE.map((t) => h('button', { class: 'b pe-act', title: STEP_HELP[t], onclick: () => {
      const r = canvas.getBoundingClientRect();
      const x = (r.width / 2 - view.x) / view.k - NW / 2 + (def.steps.length % 5) * 14;
      const y = (r.height / 3 - view.y) / view.k + (def.steps.length % 5) * 14;
      const s = addStep(def, t, Math.round(x), Math.round(y), sc);
      selStep = s.id;
      selEdge = undefined;
      ctx.scenarioChanged();
      draw();
    } }, h('span', { class: 'dot', style: { background: STEP_COLOR[t] } }), STEP_LABEL[t])),
    h('p', { class: 'note' }, 'As ações são genéricas: "Movimentar" serve para descarregar, levar à triagem, fazer a etapa 1… O que muda é o item, os locais e os recursos.'),
  );

  back.append(h('div', { class: 'pe' },
    h('header', null, h('h2', null, 'Editor de processo'), nameIn,
      h('div', { class: 'row' },
        h('button', { class: 'b', onclick: () => { autoLayout(def); fit(); ctx.scenarioChanged(); } }, 'Organizar'),
        h('button', { class: 'b', onclick: fit }, 'Ajustar à tela'),
        h('button', { class: 'b pri', onclick: close }, 'Concluir'))),
    h('div', { class: 'pe-main' }, palette, h('div', { class: 'pe-center' }, canvas, issuesBox), insBox),
  ));
  document.body.append(back);
  back.focus();
  requestAnimationFrame(() => { draw(); fit(); });
}
