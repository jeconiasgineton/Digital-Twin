/** Gráficos SVG minimalistas (sem dependências). */
const NS = 'http://www.w3.org/2000/svg';
const el = (tag: string, attrs: Record<string, any> = {}, text?: string) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
};

export const PALETTE = ['#38bdf8', '#f59e0b', '#34d399', '#f472b6', '#a78bfa', '#fb7185'];

interface Series {
  name: string;
  values: number[];
  color?: string;
  type?: 'line' | 'bar' | 'area';
}

interface ChartOpts {
  title?: string;
  w?: number;
  h?: number;
  xLabels?: (string | number)[];
  yMax?: number;
  yMin?: number;
  yFmt?: (v: number) => string;
  hline?: { y: number; label: string; color?: string };
  xTitle?: string;
  yTitle?: string;
  /** desenha todos os rótulos não vazios do eixo X */
  allLabels?: boolean;
  /** barras de erro (meia-largura) por série */
  err?: number[][];
}

export function seriesChart(series: Series[], o: ChartOpts = {}): SVGSVGElement {
  const W = o.w ?? 360;
  const H = o.h ?? 170;
  const m = { l: 42, r: 10, t: o.title ? 22 : 8, b: 30 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', preserveAspectRatio: 'xMidYMid meet' }) as SVGSVGElement;
  const n = Math.max(...series.map((s) => s.values.length), 1);
  let yMax = o.yMax ?? Math.max(...series.flatMap((s) => s.values.filter(Number.isFinite)), 1e-9) * 1.1;
  if (o.hline) yMax = Math.max(yMax, o.hline.y * 1.15);
  const yMin = o.yMin ?? 0;
  const X = (i: number, bar = false) => m.l + ((bar ? i + 0.5 : i) / (bar ? n : Math.max(1, n - 1))) * (W - m.l - m.r);
  const Y = (v: number) => H - m.b - ((Math.min(v, yMax) - yMin) / (yMax - yMin || 1)) * (H - m.t - m.b);
  const fmt = o.yFmt ?? ((v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(Math.abs(v) < 10 ? 1 : 0)));
  if (o.title) svg.append(el('text', { x: m.l, y: 13, class: 'ct' }, o.title));
  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) * i) / 4;
    svg.append(el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'grid' }));
    svg.append(el('text', { x: m.l - 5, y: Y(v) + 3, class: 'ax', 'text-anchor': 'end' }, fmt(v)));
  }
  const hasBar = series.some((s) => s.type === 'bar');
  const step = o.allLabels ? 1 : Math.max(1, Math.ceil(n / 12));
  if (o.xLabels) o.xLabels.forEach((l, i) => { if (i % step === 0 && String(l) !== '') svg.append(el('text', { x: X(i, hasBar), y: H - m.b + 13, class: 'ax', 'text-anchor': 'middle' }, String(l))); });
  const nb = series.filter((s) => s.type === 'bar').length;
  let bi = 0;
  series.forEach((s, si) => {
    const c = s.color ?? PALETTE[si % PALETTE.length];
    if (s.type === 'bar') {
      const bw = ((W - m.l - m.r) / n) * 0.8 / nb;
      s.values.forEach((v, i) => {
        const x = X(i, true) - (((W - m.l - m.r) / n) * 0.8) / 2 + bi * bw;
        svg.append(el('rect', { x, y: Y(v), width: Math.max(1, bw - 1), height: Math.max(0, Y(yMin) - Y(v)), fill: c, rx: 1.5, opacity: 0.9 }));
        const er = o.err?.[si]?.[i];
        if (er) {
          const cx = x + bw / 2;
          svg.append(el('line', { x1: cx, x2: cx, y1: Y(v + er), y2: Y(Math.max(yMin, v - er)), stroke: '#e5e7eb', 'stroke-width': 1 }));
        }
      });
      bi++;
    } else {
      const pts = s.values.map((v, i) => `${X(i)},${Y(v)}`).join(' ');
      if (s.type === 'area') svg.append(el('polygon', { points: `${X(0)},${Y(yMin)} ${pts} ${X(s.values.length - 1)},${Y(yMin)}`, fill: c, opacity: 0.18 }));
      svg.append(el('polyline', { points: pts, fill: 'none', stroke: c, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
      if (s.values.length <= 14) s.values.forEach((v, i) => svg.append(el('circle', { cx: X(i), cy: Y(v), r: 2.6, fill: c })));
    }
  });
  if (o.hline) {
    svg.append(el('line', { x1: m.l, x2: W - m.r, y1: Y(o.hline.y), y2: Y(o.hline.y), stroke: o.hline.color ?? '#f87171', 'stroke-dasharray': '4 3', 'stroke-width': 1.3 }));
    svg.append(el('text', { x: W - m.r, y: Y(o.hline.y) - 3, class: 'ax', 'text-anchor': 'end', fill: o.hline.color ?? '#f87171' }, o.hline.label));
  }
  if (o.xTitle) svg.append(el('text', { x: (W + m.l) / 2, y: H - 3, class: 'ax', 'text-anchor': 'middle' }, o.xTitle));
  if (series.length > 1) {
    let lx = m.l + 4;
    series.forEach((s, si) => {
      svg.append(el('rect', { x: lx, y: m.t - 2, width: 8, height: 8, fill: s.color ?? PALETTE[si % PALETTE.length], rx: 2 }));
      const t = el('text', { x: lx + 11, y: m.t + 5, class: 'ax' }, s.name);
      svg.append(t);
      lx += 22 + s.name.length * 5.2;
    });
  }
  return svg;
}

export function histogram(values: number[], o: { bins?: number; title?: string; unit?: string; w?: number; h?: number; marker?: { x: number; label: string }[] } = {}): SVGSVGElement {
  const W = o.w ?? 360;
  const H = o.h ?? 160;
  if (!values.length) return seriesChart([{ name: '', values: [0] }], { title: o.title, w: W, h: H });
  const sorted = [...values].sort((a, b) => a - b);
  const lo = sorted[0];
  const hi = sorted[Math.floor(sorted.length * 0.995)] || sorted[sorted.length - 1];
  const nb = o.bins ?? 24;
  const bw = (hi - lo) / nb || 1;
  const counts = new Array(nb).fill(0);
  for (const v of values) counts[Math.min(nb - 1, Math.max(0, Math.floor((v - lo) / bw)))]++;
  const dens = counts.map((c) => (c / values.length) * 100);
  const svg = seriesChart([{ name: 'freq', values: dens, type: 'bar', color: '#38bdf8' }], {
    title: o.title, w: W, h: H, yFmt: (v) => v.toFixed(0) + '%', xLabels: counts.map((_, i) => (lo + bw * i).toFixed(hi > 50 ? 0 : 1)), xTitle: o.unit,
  });
  return svg;
}
