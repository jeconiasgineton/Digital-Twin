import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Layout, LayoutElement } from '../model/types';
import type { Pt } from '../math/spatial';
import {
  type RackVis, M, buildConveyor, buildDock, buildParking, buildRack, buildStation, buildWall, buildZone, makeLabel,
} from './entities';

const DEG = Math.PI / 180;

export interface ElementVis {
  el: LayoutElement;
  group: THREE.Group;
  rack?: RackVis;
  conveyor?: { cartons: THREE.InstancedMesh; length: number; speed: number };
  label?: THREE.Sprite;
}

export type ViewMode = '3d' | '2d';

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly dynamic = new THREE.Group();
  readonly overlay = new THREE.Group();
  readonly vis = new Map<string, ElementVis>();
  levelHeight = 1.8;
  showLabels = true;
  wallOpacity = 0.35;
  mode: ViewMode = '3d';
  layout!: Layout;
  private root = new THREE.Group();
  private ground!: THREE.Mesh;
  private floorMesh?: THREE.Mesh;
  private grid!: THREE.GridHelper;
  private underlay?: THREE.Mesh;
  private selection = new Set<string>();
  private selBoxes = new Map<string, THREE.Object3D>();
  private ray = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private frameCbs: ((dt: number) => void)[] = [];
  private last = performance.now();
  private raf = 0;
  private clock = 0;
  private resizeObs: ResizeObserver;

  constructor(readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = false;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.scene.background = new THREE.Color(0x0f1722);
    this.scene.fog = new THREE.Fog(0x0f1722, 250, 700);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 2000);
    this.camera.position.set(60, 70, 110);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

    const hemi = new THREE.HemisphereLight(0xdfeaff, 0x3b3f48, 1.05);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-60, 120, 40);
    this.scene.add(sun);
    this.scene.add(this.root, this.dynamic, this.overlay);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.resize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.renderer.dispose();
  }

  onFrame(cb: (dt: number) => void) {
    this.frameCbs.push(cb);
  }

  private resize() {
    const w = this.host.clientWidth || 800;
    const h = this.host.clientHeight || 600;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop(now: number) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.clock += dt;
    for (const cb of this.frameCbs) cb(dt);
    // esteiras: animação das caixas
    for (const v of this.vis.values()) if (v.conveyor) this.animateConveyor(v);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.loop);
  }

  /** anima caixas ao longo da esteira (efeito visual). Fator de tempo definido por `conveyorTimeScale`. */
  conveyorTimeScale = 1;
  conveyorActive = false;
  private conveyorPhase = 0;
  private animateConveyor(v: ElementVis) {
    const c = v.conveyor!;
    const n = c.cartons.userData.n as number;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const spacing = c.length / n;
    this.conveyorPhase += 0;
    const off = (this.clock * c.speed * this.conveyorTimeScale) % spacing;
    for (let i = 0; i < n; i++) {
      const x = i * spacing + off;
      const show = this.conveyorActive || true;
      m.compose(new THREE.Vector3(x, 0.95 + 0.1, 0), q, new THREE.Vector3(show ? 0.4 : 0, 0.28, 0.35));
      c.cartons.setMatrixAt(i, m);
    }
    c.cartons.instanceMatrix.needsUpdate = true;
  }

  /* ---------------- layout ---------------- */

  setLayout(layout: Layout) {
    this.layout = layout;
    for (const v of this.vis.values()) this.root.remove(v.group);
    this.vis.clear();
    for (const s of this.selBoxes.values()) this.overlay.remove(s);
    this.selBoxes.clear();
    this.rebuildGround();
    for (const el of layout.elements) this.addElement(el);
    this.setUnderlay(layout.underlay);
    this.refreshSelection();
  }

  private rebuildGround() {
    if (this.ground) this.root.remove(this.ground);
    if (this.floorMesh) this.root.remove(this.floorMesh);
    if (this.grid) this.root.remove(this.grid);
    const { width: W, depth: D } = this.layout.floor;
    const pad = 40;
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(W + pad * 2, D + pad * 2), new THREE.MeshStandardMaterial({ color: 0x232b38, roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.set(W / 2, -0.03, D / 2);
    this.root.add(this.ground);
    // piso do galpão
    this.floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(W, D), M.floor);
    this.floorMesh.rotation.x = -Math.PI / 2;
    this.floorMesh.position.set(W / 2, -0.01, D / 2);
    this.root.add(this.floorMesh);
    const size = Math.max(W, D) + pad * 2;
    this.grid = new THREE.GridHelper(Math.ceil(size / 5) * 5, Math.ceil(size / 5), 0x4b5563, 0x2f3846);
    this.grid.position.set(W / 2, 0.01, D / 2);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.25;
    this.root.add(this.grid);
  }

  setFloor(w: number, d: number) {
    this.layout.floor = { width: w, depth: d };
    this.rebuildGround();
  }

  addElement(el: LayoutElement): ElementVis {
    let group: THREE.Group;
    let rack: RackVis | undefined;
    let conveyor: ElementVis['conveyor'];
    switch (el.type) {
      case 'rack':
        rack = buildRack(el, this.levelHeight);
        group = rack.group;
        break;
      case 'wall':
        group = buildWall(el, this.wallOpacity);
        break;
      case 'dockIn':
        group = buildDock(el, 'in');
        break;
      case 'dockOut':
        group = buildDock(el, 'out');
        break;
      case 'conveyor': {
        const c = buildConveyor(el);
        group = c.group;
        conveyor = c;
        break;
      }
      case 'station':
        group = buildStation(el);
        break;
      case 'parking':
        group = buildParking(el);
        break;
      default:
        group = buildZone(el, /staging|confer|expedi/i.test(el.name));
    }
    const wrap = new THREE.Group();
    wrap.add(group);
    // caixa invisível usada somente para seleção (estruturas vazadas como racks são difíceis de clicar)
    {
      const lin = el.type === 'wall' || el.type === 'conveyor';
      const ph = el.type === 'rack' ? (el.levels ?? 4) * this.levelHeight + 0.3 : el.type === 'wall' ? 5 : el.type === 'zone' || el.type === 'parking' ? 0.3 : el.type === 'conveyor' ? 1.1 : 2.5;
      const pd = el.type === 'dockIn' || el.type === 'dockOut' ? 3 : Math.max(el.width, 0.7);
      const proxy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ visible: false }));
      proxy.scale.set(el.length, ph, pd);
      proxy.position.set(lin ? el.length / 2 : 0, ph / 2, 0);
      proxy.userData.id = el.id;
      wrap.add(proxy);
    }
    wrap.userData.id = el.id;
    group.traverse((o) => (o.userData.id = el.id));
    const v: ElementVis = { el, group: wrap, rack, conveyor };
    this.place(v);
    if (this.showLabels && (el.type === 'dockIn' || el.type === 'dockOut' || el.type === 'rack' || el.type === 'zone' || el.type === 'station')) {
      const sp = makeLabel(el.name, el.type === 'rack' ? 0.9 : 1.2);
      sp.position.set(0, el.type === 'rack' ? (el.levels ?? 4) * this.levelHeight + 1.5 : 5.6, 0);
      wrap.add(sp);
      v.label = sp;
    }
    this.root.add(wrap);
    this.vis.set(el.id, v);
    return v;
  }

  private place(v: ElementVis) {
    const el = v.el;
    v.group.position.set(el.x, 0, el.z);
    v.group.rotation.y = -el.rot * DEG;
    if (el.type === 'wall' || el.type === 'conveyor') {
      // pontos de partida em (x,z); label no meio
      if (v.label) v.label.position.x = el.length / 2;
    }
  }

  /** reconstrói o elemento (após alteração de propriedades) */
  refreshElement(id: string) {
    const old = this.vis.get(id);
    if (!old) return;
    const el = this.layout.elements.find((e) => e.id === id);
    this.root.remove(old.group);
    this.vis.delete(id);
    if (el) this.addElement(el);
    this.updateSelBox(id);
  }

  /** atualização leve de posição/rotação (durante o arrastar) */
  moveElement(id: string) {
    const v = this.vis.get(id);
    if (!v) return;
    this.place(v);
    this.updateSelBox(id);
  }

  removeElement(id: string) {
    const v = this.vis.get(id);
    if (v) this.root.remove(v.group);
    this.vis.delete(id);
    const sb = this.selBoxes.get(id);
    if (sb) this.overlay.remove(sb);
    this.selBoxes.delete(id);
    this.selection.delete(id);
  }

  setWallOpacity(o: number) {
    this.wallOpacity = o;
    for (const v of this.vis.values()) {
      if (v.el.type !== 'wall') continue;
      v.group.traverse((m) => {
        if ((m as THREE.Mesh).isMesh && m.userData.isWall) ((m as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity = o;
      });
    }
  }

  setLabels(on: boolean) {
    this.showLabels = on;
    for (const v of this.vis.values()) if (v.label) v.label.visible = on;
    if (on) for (const [id, v] of [...this.vis]) if (!v.label) this.refreshElement(id);
  }

  /** atualiza a ocupação visual das estruturas porta-paletes */
  setRackStock(elementId: string, stock: number) {
    this.vis.get(elementId)?.rack?.setStock(stock);
  }

  /* ---------------- seleção ---------------- */

  setSelection(ids: string[]) {
    this.selection = new Set(ids);
    this.refreshSelection();
  }

  private refreshSelection() {
    for (const s of this.selBoxes.values()) this.overlay.remove(s);
    this.selBoxes.clear();
    for (const id of this.selection) this.updateSelBox(id);
  }

  private updateSelBox(id: string) {
    const old = this.selBoxes.get(id);
    if (old) this.overlay.remove(old);
    this.selBoxes.delete(id);
    if (!this.selection.has(id)) return;
    const el = this.layout.elements.find((e) => e.id === id);
    if (!el) return;
    const lin = el.type === 'wall' || el.type === 'conveyor';
    const w = lin ? el.length : el.length + 0.6;
    const d = Math.max(el.width + 0.6, 0.8);
    const h = el.type === 'rack' ? (el.levels ?? 4) * this.levelHeight + 0.5 : el.type === 'wall' ? 5 : 1.2;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M.selected);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: 0x22d3ee }));
    mesh.add(edges);
    mesh.position.set(lin ? w / 2 : 0, h / 2, 0);
    const wrap = new THREE.Group();
    wrap.add(mesh);
    wrap.position.set(el.x, 0, el.z);
    wrap.rotation.y = -el.rot * DEG;
    this.overlay.add(wrap);
    this.selBoxes.set(id, wrap);
  }

  /* ---------------- picking ---------------- */

  private ndc(cx: number, cy: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  }

  pickElement(cx: number, cy: number): string | null {
    this.ray.setFromCamera(this.ndc(cx, cy), this.camera);
    const objs: THREE.Object3D[] = [];
    for (const v of this.vis.values()) objs.push(v.group);
    const hits = this.ray.intersectObjects(objs, true).filter((h) => h.object.userData.id && !(h.object as any).isSprite);
    // prefere elementos não-parede/zona quando sobrepostos
    const rank = (id: string) => {
      const t = this.layout.elements.find((e) => e.id === id)?.type;
      return t === 'zone' || t === 'parking' ? 2 : t === 'wall' ? 1 : 0;
    };
    hits.sort((a, b) => rank(a.object.userData.id) - rank(b.object.userData.id) || a.distance - b.distance);
    return hits.length ? (hits[0].object.userData.id as string) : null;
  }

  groundPoint(cx: number, cy: number): Pt | null {
    this.ray.setFromCamera(this.ndc(cx, cy), this.camera);
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(this.groundPlane, p) ? { x: p.x, z: p.z } : null;
  }

  /* ---------------- câmera ---------------- */

  setMode(mode: ViewMode) {
    this.mode = mode;
    const { width: W, depth: D } = this.layout.floor;
    if (mode === '2d') {
      // vista de planta quase ortográfica (FOV pequeno, câmera alta)
      this.camera.fov = 10;
      this.camera.far = 6000;
      this.camera.updateProjectionMatrix();
      this.scene.fog = null;
      this.controls.enableRotate = false;
      this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      this.controls.screenSpacePanning = true;
      const t = Math.tan((this.camera.fov / 2) * DEG);
      const hgt = Math.max((D / 2) * 1.08 / t, ((W / 2) * 1.08) / (t * this.camera.aspect));
      this.controls.maxPolarAngle = Math.PI;
      this.controls.minPolarAngle = 0;
      this.camera.position.set(W / 2, hgt, D / 2 + 0.01);
      this.controls.target.set(W / 2, 0, D / 2);
      this.controls.maxPolarAngle = 0.0001;
      this.setWallOpacity(0.9);
    } else {
      this.camera.fov = 50;
      this.camera.far = 2000;
      this.camera.updateProjectionMatrix();
      this.scene.fog = new THREE.Fog(0x0f1722, 250, 700);
      this.controls.enableRotate = true;
      this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
      this.controls.minPolarAngle = 0;
      this.controls.screenSpacePanning = false;
      this.camera.position.set(W * 0.9, Math.max(W, D) * 0.7, D * 1.4);
      this.controls.target.set(W / 2, 0, D / 2);
      this.setWallOpacity(0.3);
    }
    this.controls.update();
  }

  fit() {
    this.setMode(this.mode);
  }

  /* ---------------- planta de fundo ---------------- */

  setUnderlay(u: Layout['underlay']) {
    if (this.underlay) {
      this.root.remove(this.underlay);
      (this.underlay.material as THREE.MeshBasicMaterial).map?.dispose();
      this.underlay = undefined;
    }
    if (this.layout) this.layout.underlay = u;
    if (!u) return;
    new THREE.TextureLoader().load(u.dataUrl, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      const img = tex.image as HTMLImageElement;
      const aspect = img.height / img.width;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(u.widthM, u.widthM * aspect),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: u.opacity, depthWrite: false }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(u.x + u.widthM / 2, 0.045, u.z + (u.widthM * aspect) / 2);
      mesh.renderOrder = 1;
      this.underlay = mesh;
      this.root.add(mesh);
    });
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
