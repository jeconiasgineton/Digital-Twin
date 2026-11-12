import { DXF_UNIT_OPTIONS, PLANT_TYPE_LABEL, layerSummary, mergeLayout, parseDxfPlant, plantToLayout, suggestType, type PlantDoc, type PlantType } from '../io/plant';
import { plantExtent, rasterToPlant } from '../io/plantRaster';
import type { PdfLib } from '../io/plantPdf';
import type { AppCtx } from './ctx';
import { h, toast } from './dom';

const TYPE_COLOR: Record<PlantType, string> = {
  ignore: '#64748b', wall: '#cbd5e1', rack: '#f59e0b', dockIn: '#34d399', dockOut: '#fb923c', conveyor: '#a78bfa', zone: '#94a3b8', station: '#5eead4',
  parking: '#facc15', aisle: '#38bdf8', transit: '#f472b6', stage: '#60a5fa', triage: '#f87171', charger: '#4ade80',
};

export const PLANT_ACCEPT = '.dxf,.dwg,.pdf,.png,.jpg,.jpeg,.webp,.bmp,.gif,image/*,application/pdf';
export const isPlantFile = (name: string) => /\.(dxf|dwg|pdf|png|jpe?g|webp|bmp|gif)$/i.test(name);

/** pdf.js só é carregado quando o usuário importa um PDF (fica fora do pacote principal) */
async function loadPdfLib(): Promise<PdfLib> {
  const lib: any = await import('pdfjs-dist/build/pdf.mjs');
  const worker: any = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  lib.GlobalWorkerOptions.workerSrc = worker.default;
  return lib as PdfLib;
}

async function loadImage(file: File): Promise<ImageData> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('não consegui abrir a imagem'));
      i.src = url;
    });
    const max = 2200; // limita o custo do reconhecimento
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return g.getImageData(0, 0, c.width, c.height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function dwgHelp() {
  toast(
    'DWG é um formato fechado e não pode ser lido aqui.\nConverta para DXF: no AutoCAD use "Salvar como… DXF"; sem AutoCAD, use o ODA File Converter (gratuito) ou o LibreCAD. Depois importe o .dxf. Também funciona exportar a planta como PDF vetorial.',
    'warn', 14000,
  );
}

/** abre a janela de importação de planta (DXF, PDF vetorial ou imagem) */
export async function importPlant(ctx: AppCtx, file: File) {
  if (/\.dwg$/i.test(file.name)) return dwgHelp();
  let doc: PlantDoc;
  let pageCount = 1;
  let page = 1;
  let pdfData: Uint8Array | null = null;
  let pdfLib: PdfLib | null = null;
  let pdfPageSize = { w: 0, h: 0 };
  try {
    toast('Lendo a planta…', 'ok', 1500);
    if (/\.dxf$/i.test(file.name)) doc = parseDxfPlant(await file.text());
    else if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      pdfLib = await loadPdfLib();
      pdfData = new Uint8Array(await file.arrayBuffer());
      const { pdfToPlant } = await import('../io/plantPdf');
      const r = await pdfToPlant(pdfLib, pdfData.slice(), 1);
      doc = r.doc;
      pageCount = r.pageCount;
      pdfPageSize = r.page;
    } else doc = rasterToPlant(await loadImage(file));
  } catch (e) {
    return toast(`Não foi possível ler "${file.name}": ${(e as Error).message}`, 'err');
  }
  if (!doc.entities.length) {
    toast(`Nenhuma geometria encontrada em "${file.name}".\n${doc.notes.join('\n')}`, 'err', 9000);
    return;
  }

  const state = {
    mapping: {} as Record<string, PlantType>,
    unitScale: doc.unitScale,
    realWidth: 0,
    rackLevels: 4,
    replace: ctx.layout.elements.length === 0,
  };
  const guessWidth = (d: PlantDoc) => {
    const ext = plantExtent(d).w || 1;
    return d.source === 'pdf' ? +(ext * 0.000352778 * 100).toFixed(1) : 60; // PDF: assume escala 1:100 como ponto de partida
  };
  const setDoc = (d: PlantDoc) => {
    doc = d;
    state.mapping = Object.fromEntries(layerSummary(d).map((l) => [l.name, l.suggested]));
    state.realWidth = guessWidth(d);
    state.unitScale = d.unitScale;
  };
  setDoc(doc);

  const back = h('div', { class: 'modal-back' });
  const close = () => back.remove();
  const body = h('div', { class: 'mbody' });
  const apply = h('button', { class: 'b pri' }, 'Aplicar ao layout');
  const colL = h('div', { class: 'col' });
  const colR = h('div', { class: 'col' });
  const prev = h('div');

  const scaleNow = () => (doc.needsScale ? state.realWidth / Math.max(1e-9, plantExtent(doc, new Set(Object.keys(state.mapping).filter((k) => state.mapping[k] !== 'ignore'))).w || plantExtent(doc).w) : state.unitScale);

  const drawPreview = () => {
    const mapped = new Set(Object.keys(state.mapping).filter((k) => state.mapping[k] !== 'ignore'));
    const ents = doc.entities.filter((e) => mapped.has(e.layer)).slice(0, 5000);
    if (!ents.length) {
      prev.replaceChildren(h('p', { class: 'note' }, 'Nenhuma camada mapeada: escolha um tipo para pelo menos uma camada.'));
      return;
    }
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const e of ents) for (const p of e.pts) {
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, doc.yUp ? -p.y : p.y); y1 = Math.max(y1, doc.yUp ? -p.y : p.y);
    }
    const pad = Math.max(x1 - x0, y1 - y0) * 0.03 + 1e-6;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`);
    svg.setAttribute('class', 'prev');
    const sw = Math.max(x1 - x0, y1 - y0) / 500;
    for (const e of ents) {
      const t = state.mapping[e.layer];
      const col = TYPE_COLOR[t];
      if (e.point) {
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', String(e.pts[0].x));
        c.setAttribute('cy', String(doc.yUp ? -e.pts[0].y : e.pts[0].y));
        c.setAttribute('r', String(sw * 4));
        c.setAttribute('fill', col);
        svg.append(c);
        continue;
      }
      const el = document.createElementNS(NS, e.closed ? 'polygon' : 'polyline');
      el.setAttribute('points', e.pts.map((p) => `${p.x},${doc.yUp ? -p.y : p.y}`).join(' '));
      el.setAttribute('fill', e.closed && t !== 'wall' ? `${col}44` : 'none');
      el.setAttribute('stroke', col);
      el.setAttribute('stroke-width', String(sw * (t === 'wall' ? 1.4 : 1)));
      svg.append(el);
    }
    prev.replaceChildren(svg);
  };

  const render = () => {
    const layers = layerSummary(doc);
    const mappedCount = layers.filter((l) => state.mapping[l.name] !== 'ignore').reduce((n, l) => n + l.count, 0);
    (apply as HTMLButtonElement).disabled = mappedCount === 0;

    const scaleBox: HTMLElement[] = [];
    if (doc.source === 'dxf') {
      const sel = h('select', null, [
        h('option', { value: String(doc.unitScale), selected: true }, `${doc.unitLabel} (detectado)`),
        ...DXF_UNIT_OPTIONS.filter(([v]) => v !== doc.unitScale).map(([v, n]) => h('option', { value: String(v) }, n)),
      ]);
      sel.addEventListener('change', () => { state.unitScale = parseFloat(sel.value); });
      scaleBox.push(h('label', { class: 'f' }, h('span', null, 'Unidade do desenho'), sel));
    } else {
      const inp = h('input', { type: 'number', min: '1', step: '1', value: String(state.realWidth) });
      inp.addEventListener('change', () => { state.realWidth = Math.max(1, parseFloat(inp.value) || state.realWidth); render(); });
      scaleBox.push(
        h('label', { class: 'f' }, h('span', null, 'Largura real do desenho (das camadas mapeadas)'), inp, h('em', null, 'm')),
        h('p', { class: 'note' }, `Escala resultante: 1 ${doc.source === 'pdf' ? 'unidade do PDF' : 'pixel'} = ${(scaleNow() * (doc.source === 'pdf' ? 1 : 1)).toFixed(4)} m.${doc.source === 'pdf' ? ' (ponto de partida: escala 1:100)' : ''}`),
      );
    }
    const rack = h('input', { type: 'number', min: '1', max: '12', step: '1', value: String(state.rackLevels) });
    rack.addEventListener('change', () => { state.rackLevels = Math.min(12, Math.max(1, Math.round(parseFloat(rack.value) || 4))); });
    const rep = h('input', { type: 'checkbox', checked: state.replace });
    rep.addEventListener('change', () => { state.replace = rep.checked; render(); });

    colL.replaceChildren(
      h('p', { class: 'note' }, doc.notes.join(' ')),
      ...(pageCount > 1 ? [(() => {
        const s = h('select', null, Array.from({ length: pageCount }, (_, i) => h('option', { value: String(i + 1), selected: i + 1 === page }, `Página ${i + 1}`)));
        s.addEventListener('change', async () => {
          page = parseInt(s.value, 10);
          const { pdfToPlant } = await import('../io/plantPdf');
          const r = await pdfToPlant(pdfLib!, pdfData!.slice(), page);
          pdfPageSize = r.page;
          setDoc(r.doc);
          render();
        });
        return h('label', { class: 'f' }, h('span', null, 'Página do PDF'), s);
      })()] : []),
      ...scaleBox,
      h('b', null, 'O que é cada camada'),
      h('div', { style: { overflowX: 'auto' } }, h('table', null,
        h('thead', null, h('tr', null, ['Camada', 'Itens', 'Tipo de elemento'].map((t) => h('th', null, t)))),
        h('tbody', null, layers.map((l) => {
          const sel = h('select', null, (Object.keys(PLANT_TYPE_LABEL) as PlantType[]).map((t) => h('option', { value: t, selected: state.mapping[l.name] === t }, PLANT_TYPE_LABEL[t])));
          sel.addEventListener('change', () => { state.mapping[l.name] = sel.value as PlantType; render(); });
          return h('tr', null,
            h('td', null, h('span', { class: 'dot', style: { background: TYPE_COLOR[state.mapping[l.name]] } }), l.name, l.points ? h('span', { class: 'note' }, ` (${l.points} bloco(s))`) : null),
            h('td', null, String(l.count)),
            h('td', null, sel));
        })),
      )),
      h('label', { class: 'f' }, h('span', null, 'Níveis dos racks'), rack),
      h('label', { class: 'chk' }, rep, 'Substituir o layout atual (senão, soma ao que já existe)'),
      ...(state.replace && ctx.layout.elements.length ? [h('p', { class: 'note' }, '⚠ O layout atual será substituído e a importação não pode ser desfeita com Ctrl+Z. Salve o layout em JSON antes, se precisar.')] : []),
    );
    colR.replaceChildren(h('b', null, 'Pré-visualização'), prev, h('p', { class: 'note' }, 'Cada camada aparece na cor do tipo escolhido. A leitura é aproximada: depois de aplicar, ajuste tudo no editor.'));
    drawPreview();
  };

  apply.addEventListener('click', () => {
    const mappedLayers = new Set(Object.keys(state.mapping).filter((k) => state.mapping[k] !== 'ignore'));
    const unit = doc.needsScale ? state.realWidth / Math.max(1e-9, plantExtent(doc, mappedLayers).w || plantExtent(doc).w) : state.unitScale;
    const res = plantToLayout(doc, state.mapping, { unitScale: unit, rackLevels: state.rackLevels });
    if (!res.elements.length) return toast(res.warnings.join('\n') || 'Nada foi criado.', 'err');
    const l = mergeLayout(ctx.layout, res, state.replace);
    ctx.loadLayout(l, true);
    const names = Object.entries(res.counts).map(([t, n]) => `${n} ${PLANT_TYPE_LABEL[t as PlantType].toLowerCase()}`).join(', ');
    toast(`Planta importada: ${names}.${res.warnings.length ? `\n${res.warnings.join('\n')}` : ''}\nRevise no editor: os níveis, as ruas e as capacidades têm valores padrão.`, res.warnings.length ? 'warn' : 'ok', 9000);
    close();
  });

  const fmtName = doc.source === 'dxf' ? 'DXF' : doc.source === 'pdf' ? 'PDF vetorial' : 'Imagem (reconhecimento local)';
  back.append(h('div', { class: 'modal' },
    h('header', null, h('h2', null, `Importar planta — ${file.name}`), h('span', { class: 'note' }, fmtName), h('button', { class: 'b', onclick: close }, '✕')),
    body,
    h('footer', null, h('button', { class: 'b', onclick: close }, 'Cancelar'), apply),
  ));
  body.append(colL, colR);
  back.addEventListener('click', (ev) => { if (ev.target === back) close(); });
  void pdfPageSize;
  void suggestType;
  document.body.append(back);
  render();
}
