import type { PlantDoc, PlantEntity, PlantPt } from './plant';

/** parte da API do pdf.js usada aqui (injetada: navegador e testes carregam builds diferentes) */
export interface PdfLib {
  getDocument(src: { data: Uint8Array; [k: string]: unknown }): { promise: Promise<any> };
  OPS: Record<string, number>;
}

type M = [number, number, number, number, number, number];
const IDENT: M = [1, 0, 0, 1, 0, 0];
/** a · b (aplica b e depois a, como no PDF: CTM' = M × CTM) */
const mul = (m: M, c: M): M => [
  m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3],
  m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3],
  m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5],
];
const apply = (c: M, x: number, y: number): PlantPt => ({ x: c[0] * x + c[2] * y + c[4], y: c[1] * x + c[3] * y + c[5] });

export interface PdfResult {
  doc: PlantDoc;
  pageCount: number;
  /** largura e altura da página (unidades do PDF) */
  page: { w: number; h: number };
}

/**
 * Extrai o desenho vetorial de uma página de PDF (traços e preenchimentos) agrupado por cor:
 * "traço #rrggbb" e "preenchimento #rrggbb". Curvas são aproximadas pelos pontos finais.
 * A moldura da página é descartada. A escala é informada depois pelo usuário.
 */
export async function pdfToPlant(lib: PdfLib, data: Uint8Array, pageNo = 1): Promise<PdfResult> {
  const pdf = await lib.getDocument({ data, useSystemFonts: false, isEvalSupported: false }).promise;
  const pageCount: number = pdf.numPages;
  const page = await pdf.getPage(Math.min(Math.max(1, pageNo), pageCount));
  const ol = await page.getOperatorList();
  const OPS = lib.OPS;
  const view: number[] = page.view;
  const pw = view[2] - view[0];
  const ph = view[3] - view[1];

  const strokeOps = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const fillOps = new Set([OPS.fill, OPS.eoFill]);

  let ctm: M = IDENT;
  const stack: M[] = [];
  let strokeColor = '#000000';
  let fillColor = '#000000';
  const entities: PlantEntity[] = [];
  let dropped = 0;

  const emit = (path: ArrayLike<number>, paintOp: number) => {
    const asStroke = strokeOps.has(paintOp);
    if (!asStroke && !fillOps.has(paintOp)) return; // endPath (recorte) ou sem pintura
    const layer = asStroke ? `traço ${strokeColor}` : `preenchimento ${fillColor}`;
    let cur: PlantPt[] = [];
    let closed = false;
    const flush = () => {
      if (cur.length >= 2) {
        const a = cur[0];
        const b = cur[cur.length - 1];
        const isClosed = closed || (cur.length > 3 && Math.hypot(a.x - b.x, a.y - b.y) < 1e-6);
        const pts = isClosed && Math.hypot(a.x - b.x, a.y - b.y) < 1e-6 ? cur.slice(0, -1) : cur;
        entities.push({ layer, pts, closed: isClosed });
      }
      cur = [];
      closed = false;
    };
    let i = 0;
    while (i < path.length) {
      const op = path[i++];
      if (op === 0) {
        flush();
        cur.push(apply(ctm, path[i], path[i + 1]));
        i += 2;
      } else if (op === 1) {
        cur.push(apply(ctm, path[i], path[i + 1]));
        i += 2;
      } else if (op === 2) {
        cur.push(apply(ctm, path[i + 4], path[i + 5]));
        i += 6;
      } else if (op === 3) {
        cur.push(apply(ctm, path[i + 2], path[i + 3]));
        i += 4;
      } else if (op === 4) closed = true;
      else break;
    }
    flush();
  };

  for (let k = 0; k < ol.fnArray.length; k++) {
    const fn = ol.fnArray[k];
    const args = ol.argsArray[k];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? IDENT;
    else if (fn === OPS.transform) ctm = mul(args as M, ctm);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args?.[0]) ctm = mul(args[0] as M, ctm);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? IDENT;
    else if (fn === OPS.setStrokeRGBColor) strokeColor = String(args[0]);
    else if (fn === OPS.setFillRGBColor) fillColor = String(args[0]);
    else if (fn === OPS.constructPath) {
      const paintOp = args[0] as number;
      const data0 = args[1]?.[0];
      if (typeof paintOp === 'number' && data0) emit(Array.from(data0 as ArrayLike<number>), paintOp);
    }
  }

  // moldura da página: entidades que cobrem (quase) toda a página
  const kept = entities.filter((e) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of e.pts) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    const frame = e.closed && (x1 - x0) >= 0.97 * pw && (y1 - y0) >= 0.97 * ph;
    if (frame) dropped++;
    return !frame;
  });
  const notes = ['PDF vetorial: as camadas são os grupos por cor de traço/preenchimento. Informe a largura real para calibrar a escala.'];
  if (dropped) notes.push(`${dropped} moldura(s) da página foram descartadas.`);
  if (!kept.length) notes.push('Não encontrei desenho vetorial nesta página (PDF escaneado ou só texto?). Exporte a planta como imagem e use a importação por imagem.');
  return { doc: { source: 'pdf', entities: kept.slice(0, 20000), yUp: true, unitScale: 1, unitLabel: 'unidades do PDF', needsScale: true, notes }, pageCount, page: { w: pw, h: ph } };
}
