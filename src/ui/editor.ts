import * as THREE from 'three';
import type { Layout, LayoutElement, ElementType } from '../model/types';
import type { Pt } from '../math/spatial';
import { linearEnds, toLocal } from '../math/spatial';
import { newId } from '../model/layoutGen';
import type { SceneView } from '../view/scene';

export type Tool = 'select' | 'rack' | 'wall' | 'conveyor' | 'dockIn' | 'dockOut' | 'zone' | 'station' | 'parking';

export const TOOL_LABEL: Record<Tool, string> = {
  select: 'Selecionar', rack: 'Rack', wall: 'Parede', conveyor: 'Esteira', dockIn: 'Doca entrada', dockOut: 'Doca saída', zone: 'Zona', station: 'Estação', parking: 'Estacionamento',
};

const DEG = 180 / Math.PI;

export interface EditorHooks {
  /** estrutura mudou (adição/remoção/edição) – recalcular análises */
  changed(kind: 'add' | 'remove' | 'edit' | 'move'): void;
  selected(ids: string[]): void;
  toolChanged(t: Tool): void;
}

/** Editor de layout 2D/3D: desenho, seleção, movimentação, rotação, duplicação e histórico (desfazer/refazer). */
export class Editor {
  tool: Tool = 'select';
  snap = 0.5;
  selection: string[] = [];
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private drag: null | { start: Pt; orig: Map<string, Pt>; moved: boolean } = null;
  private draw: null | { start: Pt; ghost: THREE.Object3D } = null;
  private wallPts: Pt[] = [];
  private wallGhost?: THREE.Line;
  private cursor: Pt = { x: 0, z: 0 };
  private dom: HTMLElement;

  constructor(private view: SceneView, private getLayout: () => Layout, private hooks: EditorHooks) {
    this.dom = view.renderer.domElement;
    this.dom.addEventListener('pointerdown', (e) => this.onDown(e), { capture: true });
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    this.dom.addEventListener('dblclick', (e) => this.onDbl(e));
    window.addEventListener('keydown', (e) => this.onKey(e));
    this.pushHistory();
  }

  get layout() {
    return this.getLayout();
  }

  /* ---------------- histórico ---------------- */
  pushHistory() {
    const snap = JSON.stringify({ ...this.layout, underlay: undefined });
    if (this.undoStack[this.undoStack.length - 1] === snap) return;
    this.undoStack.push(snap);
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
  }

  resetHistory() {
    this.undoStack = [];
    this.redoStack = [];
    this.pushHistory();
  }

  private restore(json: string) {
    const parsed = JSON.parse(json) as Layout;
    const l = this.layout;
    l.elements = parsed.elements;
    l.floor = parsed.floor;
    l.name = parsed.name;
    this.view.setLayout(l);
    this.setSelection(this.selection.filter((id) => l.elements.some((e) => e.id === id)));
    this.hooks.changed('edit');
  }

  undo() {
    if (this.undoStack.length < 2) return;
    this.redoStack.push(this.undoStack.pop()!);
    this.restore(this.undoStack[this.undoStack.length - 1]);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(s);
    this.restore(s);
  }

  /* ---------------- ferramentas ---------------- */
  setTool(t: Tool) {
    this.tool = t;
    this.cancelDraw();
    this.dom.style.cursor = t === 'select' ? 'default' : 'crosshair';
    this.hooks.toolChanged(t);
  }

  private cancelDraw() {
    if (this.draw) this.view.overlay.remove(this.draw.ghost);
    this.draw = null;
    this.finishWall(false);
  }

  setSelection(ids: string[]) {
    this.selection = ids;
    this.view.setSelection(ids);
    this.hooks.selected(ids);
  }

  /* ---------------- util ---------------- */
  private sn(v: number) {
    return this.snap > 0 ? Math.round(v / this.snap) * this.snap : v;
  }

  private point(e: PointerEvent | MouseEvent, snapEnds = false): Pt | null {
    const p = this.view.groundPoint(e.clientX, e.clientY);
    if (!p) return null;
    let q = { x: this.sn(p.x), z: this.sn(p.z) };
    if (snapEnds) {
      let best = 0.8;
      for (const el of this.layout.elements) {
        if (el.type !== 'wall' && el.type !== 'conveyor') continue;
        for (const end of linearEnds(el)) {
          const d = Math.hypot(end.x - p.x, end.z - p.z);
          if (d < best) {
            best = d;
            q = { x: end.x, z: end.z };
          }
        }
      }
    }
    return q;
  }

  private mk(type: ElementType, partial: Partial<LayoutElement>): LayoutElement {
    const defaults: Record<ElementType, Partial<LayoutElement>> = {
      rack: { name: 'Rack', length: 22.4, width: 2.3, bays: 8, levels: 4, rows: 2, pickFace: false },
      wall: { name: 'Parede', length: 10, width: 0.3 },
      conveyor: { name: 'Esteira', length: 12, width: 0.8, speed: 0.6 },
      dockIn: { name: 'Doca Entrada', length: 3.6, width: 1 },
      dockOut: { name: 'Doca Saída', length: 3.6, width: 1 },
      zone: { name: 'Zona', length: 10, width: 6 },
      station: { name: 'Estação', length: 2.4, width: 1.6 },
      parking: { name: 'Estacionamento', length: 6, width: 4 },
    };
    const n = this.layout.elements.filter((e) => e.type === type).length + 1;
    const d = defaults[type];
    return { id: newId(type), type, x: 0, z: 0, rot: 0, length: 5, width: 2, ...d, name: `${d.name} ${n}`, ...partial } as LayoutElement;
  }

  private add(el: LayoutElement) {
    this.layout.elements.push(el);
    this.view.addElement(el);
    this.pushHistory();
    this.setSelection([el.id]);
    this.hooks.changed('add');
  }

  /** doca: gruda na parede mais próxima, com o interior voltado para o centro do piso */
  private placeDock(type: 'dockIn' | 'dockOut', p: Pt) {
    let best: { w: LayoutElement; d: number; lx: number } | null = null;
    for (const w of this.layout.elements) {
      if (w.type !== 'wall') continue;
      const l = toLocal(w, p);
      const lx = Math.min(w.length, Math.max(0, l.x));
      const d = Math.hypot(l.x - lx, l.z);
      if (!best || d < best.d) best = { w, d, lx };
    }
    if (best && best.d < 6) {
      const w = best.w;
      const c = Math.cos((w.rot * Math.PI) / 180);
      const s = Math.sin((w.rot * Math.PI) / 180);
      const lx = this.sn(best.lx);
      const x = w.x + lx * c;
      const z = w.z + lx * s;
      const center = { x: this.layout.floor.width / 2, z: this.layout.floor.depth / 2 };
      // normal local +z do muro em mundo = (-s, c); queremos "fora" = lado oposto ao centro
      const nx = -s;
      const nz = c;
      const toCenter = (center.x - x) * nx + (center.z - z) * nz;
      const rot = toCenter > 0 ? w.rot + 180 : w.rot; // local +z (fora) deve apontar para longe do centro
      this.add(this.mk(type, { x, z, rot: ((rot % 360) + 360) % 360 }));
    } else {
      this.add(this.mk(type, { x: p.x, z: p.z, rot: 0 }));
    }
  }

  /* ---------------- eventos ---------------- */
  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const p = this.point(e, this.tool === 'wall' || this.tool === 'conveyor');
    if (this.tool === 'select') {
      const id = this.view.pickElement(e.clientX, e.clientY);
      if (!id) {
        if (!e.shiftKey) this.setSelection([]);
        return; // deixa a câmera (OrbitControls) tratar
      }
      e.stopImmediatePropagation();
      let sel = this.selection;
      if (e.shiftKey) sel = sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id];
      else if (!sel.includes(id)) sel = [id];
      this.setSelection(sel);
      if (p && sel.length) {
        const orig = new Map<string, Pt>();
        for (const s of sel) {
          const el = this.layout.elements.find((x) => x.id === s)!;
          orig.set(s, { x: el.x, z: el.z });
        }
        this.drag = { start: p, orig, moved: false };
      }
      return;
    }
    e.stopImmediatePropagation();
    if (!p) return;
    this.cursor = p;
    switch (this.tool) {
      case 'dockIn':
      case 'dockOut':
        this.placeDock(this.tool, p);
        break;
      case 'wall': {
        const last = this.wallPts[this.wallPts.length - 1];
        const q = last ? this.ortho(last, p, e) : p;
        if (last && Math.hypot(q.x - last.x, q.z - last.z) < 0.2) return;
        this.wallPts.push(q);
        if (this.wallPts.length >= 2) {
          const a = this.wallPts[this.wallPts.length - 2];
          this.addWallSeg(a, q);
        }
        break;
      }
      default: {
        const ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.35, depthWrite: false }));
        this.view.overlay.add(ghost);
        this.draw = { start: p, ghost };
        this.updateGhost(p);
      }
    }
  }

  /** trava em 0°/90° quando próximo dos eixos (±4°) ou sempre que Shift estiver pressionado */
  private ortho(a: Pt, b: Pt, e: { shiftKey?: boolean }): Pt {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    if (e.shiftKey) return Math.abs(dx) >= Math.abs(dz) ? { x: b.x, z: a.z } : { x: a.x, z: b.z };
    const ang = Math.atan2(dz, dx) * DEG;
    const near = (t: number) => Math.abs(((ang - t + 540) % 360) - 180) < 4;
    if (near(0) || near(180)) return { x: b.x, z: a.z };
    if (near(90) || near(-90)) return { x: a.x, z: b.z };
    return b;
  }

  private addWallSeg(a: Pt, b: Pt) {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const el = this.mk('wall', { name: `Parede ${this.layout.elements.filter((x) => x.type === 'wall').length + 1}`, x: a.x, z: a.z, rot: +(Math.atan2(b.z - a.z, b.x - a.x) * DEG).toFixed(3), length: +len.toFixed(3) });
    this.layout.elements.push(el);
    this.view.addElement(el);
    this.pushHistory();
    this.hooks.changed('add');
  }

  private finishWall(commit = true) {
    void commit;
    this.wallPts = [];
    if (this.wallGhost) {
      this.view.overlay.remove(this.wallGhost);
      this.wallGhost = undefined;
    }
  }

  private onDbl(_e: MouseEvent) {
    if (this.tool === 'wall') this.finishWall();
  }

  private onMove(e: PointerEvent) {
    if (e.target !== this.dom && !this.drag && !this.draw) return;
    const p = this.point(e, this.tool === 'wall' || this.tool === 'conveyor');
    if (!p) return;
    this.cursor = p;
    if (this.drag) {
      const dx = p.x - this.drag.start.x;
      const dz = p.z - this.drag.start.z;
      if (!this.drag.moved && Math.hypot(dx, dz) < 0.25) return;
      this.drag.moved = true;
      for (const [id, o] of this.drag.orig) {
        const el = this.layout.elements.find((x) => x.id === id);
        if (!el) continue;
        el.x = +(o.x + dx).toFixed(3);
        el.z = +(o.z + dz).toFixed(3);
        this.view.moveElement(id);
      }
      this.hooks.selected(this.selection);
    } else if (this.draw) {
      this.updateGhost(p);
    } else if (this.tool === 'wall' && this.wallPts.length) {
      const last = this.wallPts[this.wallPts.length - 1];
      const q = this.ortho(last, p, e);
      if (this.wallGhost) this.view.overlay.remove(this.wallGhost);
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(last.x, 0.2, last.z), new THREE.Vector3(q.x, 0.2, q.z)]);
      this.wallGhost = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x22d3ee }));
      this.view.overlay.add(this.wallGhost);
    }
  }

  private rectFromDrag(a: Pt, b: Pt) {
    return { cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2, w: Math.abs(b.x - a.x), d: Math.abs(b.z - a.z) };
  }

  private updateGhost(p: Pt) {
    if (!this.draw) return;
    const { start, ghost } = this.draw;
    const g = ghost as THREE.Mesh;
    if (this.tool === 'conveyor') {
      const len = Math.max(0.5, Math.hypot(p.x - start.x, p.z - start.z));
      const ang = Math.atan2(p.z - start.z, p.x - start.x);
      g.scale.set(len, 0.4, 0.8);
      g.position.set(start.x + Math.cos(ang) * len / 2, 0.5, start.z + Math.sin(ang) * len / 2);
      g.rotation.y = -ang;
    } else if (this.tool === 'rack') {
      const dx = Math.abs(p.x - start.x);
      const dz = Math.abs(p.z - start.z);
      const horiz = dx >= dz;
      const len = Math.max(2.8, horiz ? dx : dz);
      g.scale.set(horiz ? len : 2.3, 3, horiz ? 2.3 : len);
      g.rotation.y = 0;
      g.position.set(horiz ? start.x + (p.x >= start.x ? len / 2 : -len / 2) : start.x, 1.5, horiz ? start.z : start.z + (p.z >= start.z ? len / 2 : -len / 2));
    } else {
      const r = this.rectFromDrag(start, p);
      g.scale.set(Math.max(0.5, r.w), 0.6, Math.max(0.5, r.d));
      g.position.set(r.cx, 0.3, r.cz);
      g.rotation.y = 0;
    }
  }

  private onUp(e: PointerEvent) {
    if (this.drag) {
      if (this.drag.moved) {
        this.pushHistory();
        this.hooks.changed('move');
      }
      this.drag = null;
      return;
    }
    if (this.draw) {
      const p = this.point(e, this.tool === 'conveyor') ?? this.cursor;
      const { start, ghost } = this.draw;
      this.view.overlay.remove(ghost);
      this.draw = null;
      const dx = p.x - start.x;
      const dz = p.z - start.z;
      const dragLen = Math.hypot(dx, dz);
      const click = dragLen < 1;
      switch (this.tool) {
        case 'rack': {
          const horiz = Math.abs(dx) >= Math.abs(dz);
          const L = click ? 22.4 : Math.max(2.8, Math.abs(horiz ? dx : dz));
          const bays = Math.max(1, Math.round(L / 2.8));
          const len = +(bays * 2.8).toFixed(2);
          const dir = horiz ? Math.sign(dx || 1) : Math.sign(dz || 1);
          const cx = horiz ? start.x + (click ? len / 2 : dir * len / 2) : start.x;
          const cz = horiz ? start.z : start.z + (click ? len / 2 : dir * len / 2);
          this.add(this.mk('rack', { x: this.sn(cx), z: this.sn(cz), rot: horiz ? 0 : 90, length: len, bays }));
          break;
        }
        case 'conveyor': {
          if (click) return;
          this.add(this.mk('conveyor', { x: start.x, z: start.z, rot: +(Math.atan2(dz, dx) * DEG).toFixed(2), length: +dragLen.toFixed(2) }));
          break;
        }
        case 'zone':
        case 'parking':
        case 'station': {
          const r = this.rectFromDrag(start, p);
          if (click) this.add(this.mk(this.tool, { x: start.x, z: start.z }));
          else this.add(this.mk(this.tool, { x: r.cx, z: r.cz, length: Math.max(1, r.w), width: Math.max(1, r.d) }));
          break;
        }
      }
    }
  }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') {
      e.preventDefault();
      e.shiftKey ? this.redo() : this.undo();
    } else if ((e.ctrlKey || e.metaKey) && k === 'y') {
      e.preventDefault();
      this.redo();
    } else if ((e.ctrlKey || e.metaKey) && k === 'd') {
      e.preventDefault();
      this.duplicate();
    } else if ((e.ctrlKey || e.metaKey) && k === 'a') {
      e.preventDefault();
      this.setSelection(this.layout.elements.map((x) => x.id));
    } else if (k === 'delete' || k === 'backspace') {
      this.removeSelected();
    } else if (k === 'escape') {
      if (this.tool === 'wall' && this.wallPts.length) this.finishWall();
      else {
        this.cancelDraw();
        this.setTool('select');
        this.setSelection([]);
      }
    } else if (k === 'enter' && this.tool === 'wall') {
      this.finishWall();
    } else if (k === 'r' && this.selection.length) {
      this.rotateSelected(e.shiftKey ? -90 : 90);
    } else if (k.startsWith('arrow') && this.selection.length) {
      e.preventDefault();
      const s = e.shiftKey ? 5 : this.snap || 0.5;
      this.nudge(k === 'arrowleft' ? -s : k === 'arrowright' ? s : 0, k === 'arrowup' ? -s : k === 'arrowdown' ? s : 0);
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const map: Record<string, Tool> = { v: 'select', k: 'rack', w: 'wall', c: 'conveyor', i: 'dockIn', o: 'dockOut', z: 'zone', e: 'station', p: 'parking' };
      if (map[k]) this.setTool(map[k]);
    }
  }

  /* ---------------- operações ---------------- */
  removeSelected() {
    if (!this.selection.length) return;
    const ids = new Set(this.selection);
    this.layout.elements = this.layout.elements.filter((e) => !ids.has(e.id));
    for (const id of ids) this.view.removeElement(id);
    this.pushHistory();
    this.setSelection([]);
    this.hooks.changed('remove');
  }

  duplicate() {
    const out: string[] = [];
    for (const id of this.selection) {
      const el = this.layout.elements.find((x) => x.id === id);
      if (!el) continue;
      const c: LayoutElement = { ...JSON.parse(JSON.stringify(el)), id: newId(el.type), name: el.name + ' (cópia)', x: el.x + 3, z: el.z + 3 };
      this.layout.elements.push(c);
      this.view.addElement(c);
      out.push(c.id);
    }
    if (out.length) {
      this.pushHistory();
      this.setSelection(out);
      this.hooks.changed('add');
    }
  }

  rotateSelected(deg: number) {
    for (const id of this.selection) {
      const el = this.layout.elements.find((x) => x.id === id);
      if (!el) continue;
      el.rot = (((el.rot + deg) % 360) + 360) % 360;
      this.view.moveElement(id);
    }
    this.pushHistory();
    this.hooks.changed('edit');
    this.hooks.selected(this.selection);
  }

  nudge(dx: number, dz: number) {
    for (const id of this.selection) {
      const el = this.layout.elements.find((x) => x.id === id);
      if (!el) continue;
      el.x += dx;
      el.z += dz;
      this.view.moveElement(id);
    }
    this.pushHistory();
    this.hooks.changed('move');
    this.hooks.selected(this.selection);
  }

  /** chamado pelo painel de propriedades após editar campos */
  edited(id: string) {
    this.view.refreshElement(id);
    this.view.setSelection(this.selection);
    this.pushHistory();
    this.hooks.changed('edit');
  }
}
