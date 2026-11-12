import { describe, expect, it } from 'vitest';
import { defaultScenario } from '../src/model/defaults';
import { SimModel } from '../src/sim/model';
import { buildWorld } from '../src/sim/world';
import { layerSummary, mergeLayout, obb, parseDxfPlant, plantToLayout, rectsFromSegments, suggestType, type PlantType } from '../src/io/plant';

/** DXF ASCII mínimo (unidade em metros) */
function dxf(opt: { units?: number; scale?: number; ents: string[]; blocks?: string[] }): string {
  const p: (string | number)[] = [];
  const s = opt.scale ?? 1;
  p.push(0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, opt.units ?? 6, 0, 'ENDSEC');
  p.push(0, 'SECTION', 2, 'BLOCKS', ...(opt.blocks ?? []).flatMap((b) => b.split('\n')), 0, 'ENDSEC');
  p.push(0, 'SECTION', 2, 'ENTITIES', ...opt.ents.flatMap((e) => e.split('\n')), 0, 'ENDSEC', 0, 'EOF');
  void s;
  return p.join('\n');
}
const line = (layer: string, x1: number, y1: number, x2: number, y2: number) => ['0', 'LINE', '8', layer, '10', x1, '20', y1, '11', x2, '21', y2].join('\n');
const lwrect = (layer: string, x0: number, y0: number, x1: number, y1: number) =>
  ['0', 'LWPOLYLINE', '8', layer, '90', 4, '70', 1, '10', x0, '20', y0, '10', x1, '20', y0, '10', x1, '20', y1, '10', x0, '20', y1].join('\n');
const insert = (layer: string, block: string, x: number, y: number, rot = 0) => ['0', 'INSERT', '8', layer, '2', block, '10', x, '20', y, '50', rot].join('\n');

// galpão 60 × 40 m (CAD: Y para cima; a parede "norte" tem Y = 40)
const walls = [line('PAREDES', 0, 0, 60, 0), line('PAREDES', 60, 0, 60, 40), line('PAREDES', 60, 40, 0, 40), line('PAREDES', 0, 40, 0, 0)];
const blk = ['0', 'BLOCK', '8', '0', '2', 'DOCA', '10', 0, '20', 0, '0', 'LINE', '8', '0', '10', -1.8, '20', 0, '11', 1.8, '21', 0, '0', 'ENDBLK'].join('\n');

describe('classificação de camadas', () => {
  it('sugere o tipo pelo nome da camada (pt/en, sem acento)', () => {
    const t = (n: string) => suggestType(n);
    expect(t('PAREDES')).toBe('wall');
    expect(t('A-WALL')).toBe('wall');
    expect(t('RACK_PORTA_PALETE')).toBe('rack');
    expect(t('Estantes')).toBe('rack');
    expect(t('DOCA_ENTRADA')).toBe('dockIn');
    expect(t('Doca Saída')).toBe('dockOut');
    expect(t('DOCK-OUT')).toBe('dockOut');
    expect(t('RUA')).toBe('aisle');
    expect(t('Corredores')).toBe('aisle');
    expect(t('Transitório')).toBe('transit');
    expect(t('STAGE')).toBe('stage');
    expect(t('Triagem')).toBe('triage');
    expect(t('AMR_CARGA')).toBe('charger');
    expect(t('ESTEIRA')).toBe('conveyor');
    expect(t('ESTACIONAMENTO')).toBe('parking');
    expect(t('COTAS')).toBe('ignore');
    expect(t('traço #000000')).toBe('wall');
    expect(t('traço #ff0000')).toBe('ignore');
  });
});

describe('geometria', () => {
  it('menor retângulo orientado: eixo longo e rotação', () => {
    const b = obb([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 2 }, { x: 0, z: 2 }]);
    expect(b.len).toBeCloseTo(10, 9);
    expect(b.wid).toBeCloseTo(2, 9);
    expect(b.cx).toBeCloseTo(5, 9);
    expect(b.cz).toBeCloseTo(1, 9);
    expect(b.rot).toBeCloseTo(0, 6);
    const v = obb([{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 10 }, { x: 0, z: 10 }]);
    expect(v.len).toBeCloseTo(10, 9);
    expect(Math.abs(v.rot)).toBeCloseTo(90, 6);
  });
  it('monta retângulo a partir de 4 linhas soltas', () => {
    const segs = [
      { x1: 0, z1: 0, x2: 10, z2: 0 }, { x1: 10, z1: 0, x2: 10, z2: 3 }, { x1: 10, z1: 3, x2: 0, z2: 3 }, { x1: 0, z1: 3, x2: 0, z2: 0 },
      { x1: 20, z1: 0, x2: 30, z2: 0 }, // linha solta, fora de retângulo
    ];
    const r = rectsFromSegments(segs, 0.1);
    expect(r.rects).toHaveLength(1);
    expect(r.used.size).toBe(4);
    expect(r.rects[0]).toMatchObject({ x0: 0, x1: 10, z0: 0, z1: 3 });
  });
});

describe('importação de DXF por camadas', () => {
  const text = dxf({
    blocks: [blk],
    ents: [
      ...walls,
      lwrect('RACK', 10, 10, 40, 12.3), // fechado
      ...[line('RACK', 10, 20, 40, 20), line('RACK', 40, 20, 40, 22.3), line('RACK', 40, 22.3, 10, 22.3), line('RACK', 10, 22.3, 10, 20)], // 4 linhas
      insert('DOCA_ENTRADA', 'DOCA', 20, 40), // parede "norte" (Y=40)
      insert('DOCA_SAIDA', 'DOCA', 30, 0), // parede "sul" (Y=0)
      lwrect('RUA', 8, 13, 42, 16.4),
      lwrect('STAGE', 12, 32, 30, 37),
      lwrect('TRIAGEM', 45, 30, 55, 36),
      insert('CARGA_AMR', 'DOCA', 50, 5),
      line('COTAS', 0, 0, 5, 5),
    ],
  });
  const doc = parseDxfPlant(text);
  const mapping = Object.fromEntries(layerSummary(doc).map((l) => [l.name, l.suggested])) as Record<string, PlantType>;

  it('lê camadas, unidade e blocos', () => {
    expect(doc.unitScale).toBe(1);
    expect(doc.unitLabel).toBe('m');
    const names = layerSummary(doc).map((l) => l.name).sort();
    expect(names).toEqual(['CARGA_AMR', 'COTAS', 'DOCA_ENTRADA', 'DOCA_SAIDA', 'PAREDES', 'RACK', 'RUA', 'STAGE', 'TRIAGEM']);
    expect(mapping.COTAS).toBe('ignore');
  });
  it('converte camadas em elementos do layout', () => {
    const r = plantToLayout(doc, mapping);
    expect(r.counts.wall).toBe(4);
    expect(r.counts.rack).toBe(2); // polilinha fechada + 4 linhas
    expect(r.counts.dockIn).toBe(1);
    expect(r.counts.dockOut).toBe(1);
    expect(r.counts.aisle).toBe(1);
    expect(r.counts.stage).toBe(1);
    expect(r.counts.triage).toBe(1);
    expect(r.counts.charger).toBe(1);
    const rack = r.elements.find((e) => e.type === 'rack')!;
    expect(rack.length).toBeCloseTo(30, 2);
    expect(rack.width).toBeCloseTo(2.3, 2);
    expect(rack.bays).toBe(Math.round(30 / 2.8));
    expect(rack.levels).toBe(4);
    expect(rack.rows).toBe(2);
    expect(r.elements.find((e) => e.type === 'aisle')!.aisle).toBe('A');
    expect(r.floor.width).toBeGreaterThanOrEqual(60);
    expect(r.floor.depth).toBeGreaterThanOrEqual(40);
  });
  it('docas encaixam na parede e abrem para fora do galpão', () => {
    const r = plantToLayout(doc, mapping);
    const inn = r.elements.find((e) => e.type === 'dockIn')!;
    const out = r.elements.find((e) => e.type === 'dockOut')!;
    // Y do CAD vira −Z: a parede Y=40 fica ao norte (Z menor). Como no gerador: norte → rot 180, sul → rot 0.
    expect(inn.z).toBeLessThan(out.z);
    expect(((inn.rot % 360) + 360) % 360).toBeCloseTo(180, 3);
    expect(((out.rot % 360) + 360) % 360).toBeCloseTo(0, 3);
  });
  it('camada ignorada não gera elementos; mapeamento manual vale', () => {
    const m = { ...mapping, RACK: 'ignore' as PlantType, COTAS: 'wall' as PlantType };
    const r = plantToLayout(doc, m);
    expect(r.counts.rack).toBeUndefined();
    expect(r.counts.wall).toBe(5);
  });
  it('unidades: mm estimado e override de escala', () => {
    const mm = parseDxfPlant(dxf({ units: 0, ents: [line('PAREDES', 0, 0, 60000, 0), line('PAREDES', 60000, 0, 60000, 40000)] }));
    expect(mm.unitScale).toBe(0.001);
    expect(mm.notes.join(' ')).toMatch(/unidade/);
    const r = plantToLayout(mm, { PAREDES: 'wall' });
    expect(r.elements[0].length).toBeCloseTo(60, 3);
    const r2 = plantToLayout(mm, { PAREDES: 'wall' }, { unitScale: 0.01 });
    expect(r2.elements[0].length).toBeCloseTo(600, 3);
  });
  it('o layout importado é simulável de ponta a ponta', () => {
    const r = plantToLayout(doc, mapping);
    const layout = mergeLayout({ name: 'x', floor: { width: 10, depth: 10 }, elements: [] }, r, true);
    const sc = defaultScenario();
    sc.days = 1;
    sc.warmupHours = 1;
    sc.forklifts.count = 3;
    const w = buildWorld(layout, sc);
    expect(w.racks).toHaveLength(2);
    expect(w.docksIn).toHaveLength(1);
    expect(w.stages).toHaveLength(1);
    expect(w.aisles).toHaveLength(1);
    const k = new SimModel(sc, layout, 3).runAll().kpis;
    expect(k.palletsInPerDay).toBeGreaterThan(0);
  });
  it('mesclar mantém o que já existe', () => {
    const r = plantToLayout(doc, mapping);
    const base = { name: 'b', floor: { width: 100, depth: 5 }, elements: [{ id: 'k', type: 'zone' as const, name: 'z', x: 1, z: 1, rot: 0, length: 2, width: 2 }] };
    const m = mergeLayout(base, r, false);
    expect(m.elements.length).toBe(r.elements.length + 1);
    expect(m.floor.width).toBe(100);
    expect(m.floor.depth).toBe(Math.max(5, r.floor.depth));
  });
});

describe('importação de imagem (reconhecimento local)', () => {
  /** imagem sintética: fundo branco, desenho preto */
  const canvas = (W: number, H: number) => {
    const data = new Uint8ClampedArray(W * H * 4).fill(255);
    const fill = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
    };
    const rect = (x0: number, y0: number, x1: number, y1: number, t = 2) => {
      fill(x0, y0, x1, y0 + t - 1); fill(x0, y1 - t + 1, x1, y1); fill(x0, y0, x0 + t - 1, y1); fill(x1 - t + 1, y0, x1, y1);
    };
    return { data, width: W, height: H, fill, rect };
  };

  it('reconhece contorno (paredes), blocos preenchidos e retângulos de contorno', async () => {
    const { rasterToPlant, LAYER_LINES, LAYER_BLOCKS, LAYER_RECTS, plantExtent } = await import('../src/io/plantRaster');
    const c = canvas(600, 400);
    c.rect(10, 10, 590, 390); // contorno da planta (paredes)
    c.fill(80, 100, 520, 135); // barra preenchida (rack)
    c.fill(80, 200, 520, 235); // outra
    c.rect(100, 300, 250, 370); // retângulo de contorno (zona)
    const doc = rasterToPlant(c);
    expect(doc.source).toBe('image');
    expect(doc.needsScale).toBe(true);
    expect(doc.yUp).toBe(false);
    const by = (l: string) => doc.entities.filter((e) => e.layer === l);
    expect(by(LAYER_BLOCKS)).toHaveLength(2);
    expect(by(LAYER_RECTS)).toHaveLength(1); // o retângulo interno
    expect(by(LAYER_LINES).length).toBeGreaterThanOrEqual(4); // o contorno externo continua como paredes
    const blk = by(LAYER_BLOCKS)[0];
    const xs = blk.pts.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(430);
    const ext = plantExtent(doc);
    expect(ext.w).toBeGreaterThan(570);
  });
  it('escala pela largura real e conversão para elementos', async () => {
    const { rasterToPlant, LAYER_LINES, LAYER_BLOCKS, plantExtent } = await import('../src/io/plantRaster');
    const c = canvas(600, 400);
    c.rect(10, 10, 590, 390);
    c.fill(80, 100, 520, 135);
    const doc = rasterToPlant(c);
    const realWidth = 60; // m
    const scale = realWidth / plantExtent(doc).w;
    const r = plantToLayout(doc, { [LAYER_LINES]: 'wall', [LAYER_BLOCKS]: 'rack' }, { unitScale: scale });
    expect(r.counts.wall).toBeGreaterThanOrEqual(4);
    expect(r.counts.rack).toBe(1);
    const rack = r.elements.find((e) => e.type === 'rack')!;
    expect(rack.length).toBeCloseTo((441 * 60) / 581, 1); // barra de 441 px; desenho de 581 px = 60 m => ≈ 45,5 m
    expect(r.floor.width).toBeGreaterThanOrEqual(60);
  });
  it('fundo escuro com linhas claras é invertido; imagem vazia avisa', async () => {
    const { rasterToPlant, LAYER_LINES } = await import('../src/io/plantRaster');
    const W = 400;
    const H = 300;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 10; data[i * 4 + 3] = 255; }
    for (let x = 20; x < 380; x++) for (const y of [20, 21, 280, 281]) { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 240; }
    const inv = rasterToPlant({ data, width: W, height: H });
    expect(inv.notes.join(' ')).toMatch(/invert/);
    expect(inv.entities.filter((e) => e.layer === LAYER_LINES).length).toBeGreaterThanOrEqual(2);
    const blank = rasterToPlant({ data: new Uint8ClampedArray(W * H * 4).fill(255), width: W, height: H });
    expect(blank.entities).toHaveLength(0);
    expect(blank.notes.join(' ')).toMatch(/Não reconheci/);
  });
});

describe('importação de PDF vetorial', () => {
  /** PDF mínimo de 1 página (500×400) com o conteúdo informado */
  function pdfBytes(content: string): Uint8Array {
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 400] /Contents 4 0 R /Resources << >> >>',
      `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offs: number[] = [];
    objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return new Uint8Array(Buffer.from(pdf, 'latin1'));
  }
  const lib = async () => (await import('pdfjs-dist/legacy/build/pdf.mjs')) as any;

  it('agrupa traços e preenchimentos por cor, aplica transformações e descarta a moldura', async () => {
    const { pdfToPlant } = await import('../src/io/plantPdf');
    const content = [
      '0 0 0 RG 1 w 0 0 500 400 re S', // moldura da página
      '0 0 0 RG 2 w 50 50 m 450 50 l 450 350 l 50 350 l h S', // paredes (polilinha fechada, preto)
      '1 0 0 RG 1 w 100 100 200 20 re S', // retângulo vermelho (traço)
      '0 0 1 rg 100 200 200 20 re f', // retângulo azul preenchido
      'q 1 0 0 1 10 20 cm 0 0 0 RG 60 60 m 120 60 l S Q', // linha preta com translação
    ].join('\n') + '\n';
    const r = await pdfToPlant(await lib(), pdfBytes(content));
    expect(r.pageCount).toBe(1);
    expect(r.page).toEqual({ w: 500, h: 400 });
    expect(r.doc.source).toBe('pdf');
    expect(r.doc.needsScale).toBe(true);
    expect(r.doc.notes.join(' ')).toMatch(/moldura/);
    const sum = layerSummary(r.doc);
    expect(sum.map((l) => l.name).sort()).toEqual(['preenchimento #0000ff', 'traço #000000', 'traço #ff0000']);
    const black = r.doc.entities.filter((e) => e.layer === 'traço #000000');
    expect(black).toHaveLength(2); // polilinha fechada + linha (a moldura saiu)
    expect(black.find((e) => e.closed)!.pts).toHaveLength(4);
    const line = black.find((e) => !e.closed)!;
    expect(line.pts[0]).toMatchObject({ x: 70, y: 80 }); // translação (10,20) aplicada
    const red = r.doc.entities.find((e) => e.layer === 'traço #ff0000')!;
    expect(red.closed).toBe(true);
    expect(red.pts).toHaveLength(4);
  });
  it('sugere parede só para traço escuro neutro e converte em layout com escala', async () => {
    const { pdfToPlant } = await import('../src/io/plantPdf');
    const { plantExtent } = await import('../src/io/plantRaster');
    const content = '0 0 0 RG 2 w 50 50 m 450 50 l 450 350 l 50 350 l h S\n1 0 0 RG 100 100 200 20 re S\n';
    const { doc } = await pdfToPlant(await lib(), pdfBytes(content));
    const mapping = Object.fromEntries(layerSummary(doc).map((l) => [l.name, l.suggested])) as Record<string, PlantType>;
    expect(mapping['traço #000000']).toBe('wall');
    expect(mapping['traço #ff0000']).toBe('ignore');
    mapping['traço #ff0000'] = 'rack';
    const scale = 50 / plantExtent(doc).w; // desenho de 400 u = 50 m
    const r = plantToLayout(doc, mapping, { unitScale: scale });
    expect(r.counts.wall).toBe(4);
    expect(r.counts.rack).toBe(1);
    expect(r.elements.find((e) => e.type === 'rack')!.length).toBeCloseTo(25, 1); // 200 u × 0,125 m
    expect(r.floor.width).toBeGreaterThanOrEqual(50);
  });
  it('PDF sem desenho vetorial avisa', async () => {
    const { pdfToPlant } = await import('../src/io/plantPdf');
    const r = await pdfToPlant(await lib(), pdfBytes('0 0 0 RG 0 0 500 400 re S\n'));
    expect(r.doc.entities).toHaveLength(0);
    expect(r.doc.notes.join(' ')).toMatch(/Não encontrei/);
  });
});
