type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props?: Record<string, any> | null, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && k !== 'list') (el as any)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  const add = (c: Child) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

export const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '∞');
export const pct = (v: number, d = 0) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '∞');

/** campo numérico/seleção ligado a um objeto */
export function numField(label: string, get: () => number, set: (v: number) => void, o: { step?: number; min?: number; max?: number; unit?: string; title?: string } = {}) {
  const inp = h('input', { type: 'number', step: o.step ?? 'any', min: o.min, max: o.max, value: String(+get().toFixed(4)), title: o.title ?? '' });
  inp.addEventListener('change', () => {
    let v = parseFloat(inp.value.replace(',', '.'));
    if (!Number.isFinite(v)) v = get();
    if (o.min !== undefined) v = Math.max(o.min, v);
    if (o.max !== undefined) v = Math.min(o.max, v);
    set(v);
    inp.value = String(+get().toFixed(4));
  });
  return h('label', { class: 'f', title: o.title ?? '' }, h('span', null, label), inp, o.unit ? h('em', null, o.unit) : null);
}

export function selField<T extends string>(label: string, get: () => T, set: (v: T) => void, options: [T, string][]) {
  const s = h('select', null, options.map(([v, t]) => h('option', { value: v, selected: v === get() }, t)));
  s.addEventListener('change', () => set(s.value as T));
  return h('label', { class: 'f' }, h('span', null, label), s);
}

export function textField(label: string, get: () => string, set: (v: string) => void) {
  const inp = h('input', { type: 'text', value: get() });
  inp.addEventListener('change', () => set(inp.value));
  return h('label', { class: 'f' }, h('span', null, label), inp);
}

export function download(name: string, data: BlobPart, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 500);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((res) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    inp.addEventListener('change', () => {
      res(inp.files?.[0] ?? null);
      inp.remove();
    });
    document.body.append(inp);
    inp.click();
  });
}

export function toast(msg: string, kind: 'ok' | 'warn' | 'err' = 'ok', ms = 4200) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts' });
    document.body.append(box);
  }
  const t = h('div', { class: `toast ${kind}` }, msg);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}
