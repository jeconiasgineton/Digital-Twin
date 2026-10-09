import type { Layout, LayoutElement } from '../model/types';
import { defaultLayoutParams, generateLayout, type LayoutParams } from '../model/layoutGen';
import { parseDxf } from '../io/dxf';
import { validate, buildWorld } from '../sim/world';
import type { AppCtx } from './ctx';
import { h, numField, pickFile, selField, textField, toast, fmt } from './dom';

let genParams: LayoutParams = defaultLayoutParams();

const TYPE_NAME: Record<string, string> = {
  rack: 'Estrutura porta-paletes', dockIn: 'Doca de recebimento', dockOut: 'Doca de expedição', conveyor: 'Esteira', wall: 'Parede', zone: 'Zona', station: 'Estação', parking: 'Estacionamento',
};

function section(title: string, body: HTMLElement | HTMLElement[], open = true) {
  return h('details', { open }, h('summary', null, title), h('div', { class: 'body' }, body));
}

export function propertiesBox(ctx: AppCtx): HTMLElement {
  const ids = ctx.editor.selection;
  const box = h('div');
  if (!ids.length) {
    box.append(h('p', { class: 'note' }, 'Nenhum elemento selecionado. Clique em um elemento do galpão (ou use as ferramentas à esquerda para desenhar).'));
    return box;
  }
  if (ids.length > 1) {
    box.append(
      h('p', { class: 'note' }, `${ids.length} elementos selecionados. Arraste para mover, R para girar, Ctrl+D duplica, Delete exclui.`),
      h('div', { class: 'row' }, h('button', { class: 'b', onclick: () => ctx.editor.rotateSelected(90) }, 'Girar 90°'), h('button', { class: 'b', onclick: () => ctx.editor.duplicate() }, 'Duplicar'), h('button', { class: 'b danger', onclick: () => ctx.editor.removeSelected() }, 'Excluir')),
    );
    return box;
  }
  const el = ctx.layout.elements.find((e) => e.id === ids[0]);
  if (!el) return box;
  const ed = () => ctx.editor.edited(el.id);
  const lin = el.type === 'wall' || el.type === 'conveyor';
  const fields: HTMLElement[] = [
    textField('Nome', () => el.name, (v) => ((el.name = v), ed())),
    numField(lin ? 'X inicial' : 'X (centro)', () => el.x, (v) => ((el.x = v), ed()), { step: 0.5, unit: 'm' }),
    numField(lin ? 'Z inicial' : 'Z (centro)', () => el.z, (v) => ((el.z = v), ed()), { step: 0.5, unit: 'm' }),
    numField('Rotação', () => el.rot, (v) => ((el.rot = ((v % 360) + 360) % 360), ed()), { step: 5, unit: '°' }),
    numField('Comprimento', () => el.length, (v) => ((el.length = v), el.type === 'rack' && (el.bays = Math.max(1, Math.round(v / 2.8))), ed()), { step: 0.5, min: 0.5, unit: 'm' }),
    numField(el.type === 'rack' ? 'Profundidade' : 'Largura', () => el.width, (v) => ((el.width = v), ed()), { step: 0.1, min: 0.1, unit: 'm' }),
  ];
  if (el.type === 'rack') {
    fields.push(
      numField('Vãos (baias)', () => el.bays ?? 8, (v) => ((el.bays = Math.max(1, Math.round(v))), ed()), { step: 1, min: 1 }),
      numField('Níveis', () => el.levels ?? 4, (v) => ((el.levels = Math.max(1, Math.round(v))), ed()), { step: 1, min: 1, max: 12 }),
      selField('Fileiras', () => String(el.rows ?? 2) as '1' | '2', (v) => ((el.rows = Number(v)), ed()), [['1', 'Simples'], ['2', 'Dupla (costas c/ costas)']]),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!el.pickFace, onchange: (e: Event) => ((el.pickFace = (e.target as HTMLInputElement).checked), ed()) }), 'Face de picking (caixas)'),
      h('p', { class: 'note' }, `Capacidade: ${(el.bays ?? 1) * (el.levels ?? 1) * (el.rows ?? 1)} posições de palete.`),
    );
  }
  if (el.type === 'conveyor') fields.push(numField('Velocidade', () => el.speed ?? 0.6, (v) => ((el.speed = v), ed()), { step: 0.1, min: 0.05, unit: 'm/s' }));
  box.append(
    h('div', { class: 'row sp' }, h('b', null, TYPE_NAME[el.type] ?? el.type), h('span', { class: 'note' }, el.id.slice(0, 8))),
    h('div', { class: 'body', style: { display: 'grid', gap: '7px', margin: '8px 0' } }, fields),
    h('div', { class: 'row' }, h('button', { class: 'b', onclick: () => ctx.editor.rotateSelected(90) }, 'Girar 90° (R)'), h('button', { class: 'b', onclick: () => ctx.editor.duplicate() }, 'Duplicar'), h('button', { class: 'b danger', onclick: () => ctx.editor.removeSelected() }, 'Excluir')),
  );
  return box;
}

export function renderLayoutPanel(ctx: AppCtx): HTMLElement {
  const root = h('div');
  const counts = (t: string) => ctx.layout.elements.filter((e) => e.type === t).length;
  const world = (() => {
    try {
      return buildWorld(ctx.layout, ctx.scenario);
    } catch {
      return null;
    }
  })();
  const issues = validate(ctx.layout, ctx.scenario);

  root.append(
    section('Elemento selecionado', propertiesBox(ctx)),
    section('Resumo do layout', [
      h('div', { class: 'cards' },
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Posições de palete'), h('div', { class: 'v' }, fmt(world?.totalCapacity ?? 0, 0)), h('div', { class: 's' }, `${counts('rack')} racks`)),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Área do piso'), h('div', { class: 'v' }, fmt(ctx.layout.floor.width * ctx.layout.floor.depth, 0)), h('div', { class: 's' }, `${fmt(ctx.layout.floor.width, 0)} × ${fmt(ctx.layout.floor.depth, 0)} m (m²)`)),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Docas'), h('div', { class: 'v' }, `${counts('dockIn')} / ${counts('dockOut')}`), h('div', { class: 's' }, 'entrada / saída')),
        h('div', { class: 'card' }, h('div', { class: 'k' }, 'Esteiras / estações'), h('div', { class: 'v' }, `${counts('conveyor')} / ${counts('station')}`), h('div', { class: 's' }, `${fmt(ctx.layout.elements.filter((e) => e.type === 'conveyor').reduce((s, e) => s + e.length, 0), 0)} m de esteira`)),
      ),
      issues.length ? h('ul', { class: 'issues' }, issues.map((i) => h('li', { class: i.level === 'erro' ? 'err' : '' }, `${i.level === 'erro' ? '⛔' : '⚠️'} ${i.msg}`))) : h('p', { class: 'note' }, '✅ Layout consistente com o cenário.'),
      numField('Largura do piso', () => ctx.layout.floor.width, (v) => ((ctx.layout.floor.width = v), ctx.view.setFloor(v, ctx.layout.floor.depth), ctx.layoutChanged('edit')), { min: 10, step: 1, unit: 'm' }),
      numField('Profundidade do piso', () => ctx.layout.floor.depth, (v) => ((ctx.layout.floor.depth = v), ctx.view.setFloor(ctx.layout.floor.width, v), ctx.layoutChanged('edit')), { min: 10, step: 1, unit: 'm' }),
      selField('Grade (snap)', () => String(ctx.editor.snap) as string, (v) => (ctx.editor.snap = Number(v)), [['0', 'Livre'], ['0.1', '0,1 m'], ['0.5', '0,5 m'], ['1', '1 m'], ['2.8', '2,8 m (vão)']]),
    ]),
    section('Gerar galpão paramétrico', [
      numField('Docas de entrada', () => genParams.docksIn, (v) => (genParams.docksIn = Math.round(v)), { min: 0, step: 1 }),
      numField('Docas de saída', () => genParams.docksOut, (v) => (genParams.docksOut = Math.round(v)), { min: 0, step: 1 }),
      numField('Fileiras de racks', () => genParams.rackRows, (v) => (genParams.rackRows = Math.round(v)), { min: 1, step: 1 }),
      numField('Vãos por fileira', () => genParams.baysPerRow, (v) => (genParams.baysPerRow = Math.round(v)), { min: 2, step: 1 }),
      numField('Níveis', () => genParams.levels, (v) => (genParams.levels = Math.round(v)), { min: 1, max: 10, step: 1 }),
      numField('Esteiras', () => genParams.conveyors, (v) => (genParams.conveyors = Math.round(v)), { min: 0, step: 1 }),
      numField('Estações', () => genParams.stations, (v) => (genParams.stations = Math.round(v)), { min: 0, step: 1 }),
      h('button', { class: 'b pri', onclick: () => { ctx.loadLayout(generateLayout(genParams), true); toast('Galpão gerado. Você pode editar tudo livremente.'); } }, 'Gerar layout'),
    ], false),
    section('Planta / desenho existente', [
      h('p', { class: 'note' }, 'Importe a planta baixa como imagem (PNG/JPG – decalque para você traçar paredes e racks por cima) ou como DXF (as linhas viram paredes automaticamente).'),
      h('div', { class: 'row' },
        h('button', { class: 'b', onclick: () => importImage(ctx) }, '🖼 Imagem de fundo'),
        h('button', { class: 'b', onclick: () => importDxf(ctx) }, '📐 Importar DXF'),
        ctx.layout.underlay ? h('button', { class: 'b danger sm', onclick: () => { ctx.view.setUnderlay(undefined); ctx.rerender(); } }, 'Remover fundo') : null,
      ),
      ctx.layout.underlay
        ? [
            numField('Largura real da imagem', () => ctx.layout.underlay!.widthM, (v) => ctx.view.setUnderlay({ ...ctx.layout.underlay!, widthM: v }), { min: 1, step: 1, unit: 'm', title: 'Calibre a escala informando a largura real que a imagem representa' }),
            numField('Deslocamento X', () => ctx.layout.underlay!.x, (v) => ctx.view.setUnderlay({ ...ctx.layout.underlay!, x: v }), { step: 1, unit: 'm' }),
            numField('Deslocamento Z', () => ctx.layout.underlay!.z, (v) => ctx.view.setUnderlay({ ...ctx.layout.underlay!, z: v }), { step: 1, unit: 'm' }),
            numField('Opacidade', () => ctx.layout.underlay!.opacity, (v) => ctx.view.setUnderlay({ ...ctx.layout.underlay!, opacity: Math.min(1, Math.max(0.05, v)) }), { min: 0.05, max: 1, step: 0.05 }),
          ]
        : null,
    ].flat().filter(Boolean) as HTMLElement[], false),
    section('Arquivo de layout', [
      h('div', { class: 'row' },
        h('button', { class: 'b', onclick: () => saveLayout(ctx) }, '💾 Salvar JSON'),
        h('button', { class: 'b', onclick: () => openLayout(ctx) }, '📂 Abrir JSON'),
        h('button', { class: 'b danger', onclick: () => { if (confirm('Limpar todo o layout?')) ctx.loadLayout({ name: 'Novo layout', floor: { width: 80, depth: 50 }, elements: [] }, true); } }, 'Novo (vazio)'),
      ),
    ], false),
    section('Atalhos', [
      h('p', { class: 'note', html: '<b>V</b> selecionar · <b>K</b> rack · <b>W</b> parede (clique p/ cada vértice, duplo-clique termina) · <b>C</b> esteira · <b>I</b>/<b>O</b> docas (encaixam na parede) · <b>Z</b> zona · <b>E</b> estação · <b>P</b> estacionamento · <b>R</b> gira · <b>Ctrl+D</b> duplica · <b>Del</b> exclui · <b>Ctrl+Z/Y</b> desfaz/refaz · setas movem · <b>Shift</b> trava ortogonal ao desenhar paredes.' }),
    ], false),
  );
  return root;
}

async function importImage(ctx: AppCtx) {
  const f = await pickFile('image/*');
  if (!f) return;
  const dataUrl: string = await new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.readAsDataURL(f);
  });
  ctx.view.setUnderlay({ dataUrl, widthM: ctx.layout.floor.width, x: 0, z: 0, opacity: 0.6 });
  ctx.rerender();
  toast('Imagem adicionada. Ajuste a "largura real" para calibrar a escala e trace as paredes por cima.');
}

async function importDxf(ctx: AppCtx) {
  const f = await pickFile('.dxf');
  if (!f) return;
  const res = parseDxf(await f.text());
  if (!res.walls.length) return toast('Nenhuma linha/polilinha encontrada no DXF (apenas DXF ASCII com LINE/LWPOLYLINE é suportado).', 'err');
  const keep = ctx.layout.elements.filter((e) => e.type !== 'wall');
  const l: Layout = { ...ctx.layout, floor: { width: Math.ceil(res.bounds.w + 4), depth: Math.ceil(res.bounds.d + 4) }, elements: [...keep, ...res.walls] };
  ctx.loadLayout(l, true);
  toast(`DXF importado: ${res.walls.length} paredes. Unidade: ${res.unitsDetected}. Dimensões: ${fmt(res.bounds.w, 1)} × ${fmt(res.bounds.d, 1)} m.`);
}

function saveLayout(ctx: AppCtx) {
  const data = JSON.stringify({ ...ctx.layout, underlay: undefined }, null, 1);
  const a = h('a', { href: URL.createObjectURL(new Blob([data], { type: 'application/json' })), download: 'layout.json' });
  a.click();
}

async function openLayout(ctx: AppCtx) {
  const f = await pickFile('.json');
  if (!f) return;
  try {
    const l = JSON.parse(await f.text()) as Layout;
    if (!Array.isArray(l.elements)) throw new Error('arquivo inválido');
    ctx.loadLayout(l, true);
  } catch (e) {
    toast('Não foi possível ler o layout: ' + (e as Error).message, 'err');
  }
}

export type { LayoutElement };
