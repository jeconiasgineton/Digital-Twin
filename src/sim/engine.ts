/**
 * Kernel de simulação de eventos discretos baseado em processos (geradores).
 *
 *   function* proc() { yield 5;                       // espera 5 s
 *                      const f = yield pool.request(); // adquire recurso
 *                      ...; pool.release(f);
 *                      yield signal; }                 // aguarda evento
 */

type Callback = () => void;

class Heap {
  t: number[] = [];
  s: number[] = [];
  f: Callback[] = [];
  get size() {
    return this.t.length;
  }
  push(t: number, seq: number, fn: Callback) {
    let i = this.t.length;
    this.t.push(t);
    this.s.push(seq);
    this.f.push(fn);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.t[p] < t || (this.t[p] === t && this.s[p] < seq)) break;
      this.t[i] = this.t[p];
      this.s[i] = this.s[p];
      this.f[i] = this.f[p];
      i = p;
    }
    this.t[i] = t;
    this.s[i] = seq;
    this.f[i] = fn;
  }
  peekTime() {
    return this.t[0];
  }
  pop(): Callback {
    const top = this.f[0];
    const lt = this.t.pop()!;
    const ls = this.s.pop()!;
    const lf = this.f.pop()!;
    const n = this.t.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && (this.t[c + 1] < this.t[c] || (this.t[c + 1] === this.t[c] && this.s[c + 1] < this.s[c]))) c++;
        if (this.t[c] > lt || (this.t[c] === lt && this.s[c] >= ls)) break;
        this.t[i] = this.t[c];
        this.s[i] = this.s[c];
        this.f[i] = this.f[c];
        i = c;
      }
      this.t[i] = lt;
      this.s[i] = ls;
      this.f[i] = lf;
    }
    return top;
  }
}

export type Waitable = number | Signal | PoolRequest<any>;
export type Process = Generator<Waitable, void, any>;

export class Signal {
  private fired = false;
  private waiters: Callback[] = [];
  constructor(private sim: Sim) {}
  fire() {
    if (this.fired) return;
    this.fired = true;
    for (const w of this.waiters) this.sim.schedule(0, w);
    this.waiters = [];
  }
  get isFired() {
    return this.fired;
  }
  /** @internal */
  _wait(cb: Callback) {
    if (this.fired) this.sim.schedule(0, cb);
    else this.waiters.push(cb);
  }
}

/** Contador de eventos: dispara o sinal quando atingir n */
export class Countdown {
  readonly signal: Signal;
  constructor(sim: Sim, private n: number) {
    this.signal = new Signal(sim);
    if (n <= 0) this.signal.fire();
  }
  tick() {
    if (--this.n <= 0) this.signal.fire();
  }
}

export interface PoolItem {
  id: number;
  x: number;
  z: number;
  busy: boolean;
  /** acumuladores */
  busyTime: number;
  busySince: number;
  downTime: number;
}

export class PoolRequest<T extends PoolItem> {
  /** @internal */
  _cb?: (item: T) => void;
  /** @internal */
  _enq = 0;
  constructor(readonly pool: Pool<T>, readonly near?: { x: number; z: number }) {}
}

/**
 * Pool de recursos móveis/idênticos (empilhadeiras, operários, docas).
 * Política de despacho: FIFO entre solicitantes; entre recursos ociosos, o mais próximo do ponto solicitado.
 */
export class Pool<T extends PoolItem> {
  items: T[];
  private idle: T[] = [];
  private queue: PoolRequest<T>[] = [];
  // estatísticas
  waits: number[] = [];
  private qArea = 0;
  private qLast = 0;
  private qLen = 0;
  statsFrom = 0;
  maxQueue = 0;
  /** itens com quebra pendente (ocupados): entram em reparo ao serem liberados */
  private pendingFail = new Map<T, { repair: number; sig: Signal }>();
  onWait?: (w: number) => void;

  constructor(private sim: Sim, items: T[]) {
    this.items = items;
    this.idle = [...items];
  }

  get queueLength() {
    return this.queue.length;
  }
  get idleCount() {
    return this.idle.length;
  }

  request(near?: { x: number; z: number }): PoolRequest<T> {
    return new PoolRequest(this, near);
  }

  /** @internal chamado pelo kernel */
  _enqueue(req: PoolRequest<T>, cb: (item: T) => void) {
    req._cb = cb;
    req._enq = this.sim.now;
    if (this.idle.length) {
      this._grant(req, this._chooseIdle(req.near));
    } else {
      this._qUpdate();
      this.queue.push(req);
      this.qLen = this.queue.length;
      this.maxQueue = Math.max(this.maxQueue, this.qLen);
    }
  }

  private _chooseIdle(near?: { x: number; z: number }): T {
    let bi = 0;
    if (near && this.idle.length > 1) {
      let bd = Infinity;
      for (let i = 0; i < this.idle.length; i++) {
        const it = this.idle[i];
        const d = (it.x - near.x) ** 2 + (it.z - near.z) ** 2;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
    }
    return this.idle.splice(bi, 1)[0];
  }

  private _grant(req: PoolRequest<T>, item: T) {
    item.busy = true;
    item.busySince = this.sim.now;
    const w = this.sim.now - req._enq;
    if (this.sim.now >= this.statsFrom) {
      this.waits.push(w);
      this.onWait?.(w);
    }
    const cb = req._cb!;
    this.sim.schedule(0, () => cb(item));
  }

  release(item: T) {
    this._account(item);
    item.busy = false;
    const pf = this.pendingFail.get(item);
    if (pf) {
      this.pendingFail.delete(item);
      this._repair(item, pf.repair, pf.sig);
      return;
    }
    this._offer(item);
  }

  private _offer(item: T) {
    if (this.queue.length) {
      this._qUpdate();
      const req = this.queue.shift()!;
      this.qLen = this.queue.length;
      this._grant(req, item);
    } else {
      this.idle.push(item);
    }
  }

  private _account(item: T) {
    const from = Math.max(item.busySince, this.statsFrom);
    if (this.sim.now > from) item.busyTime += this.sim.now - from;
  }

  /**
   * Quebra do recurso: se ocioso, entra em reparo imediatamente; se ocupado, ao concluir a tarefa atual.
   * Retorna um sinal disparado quando o recurso volta a operar.
   */
  fail(item: T, repair: number): Signal {
    const sig = new Signal(this.sim);
    const idx = this.idle.indexOf(item);
    if (idx >= 0) {
      this.idle.splice(idx, 1);
      this._repair(item, repair, sig);
    } else {
      this.pendingFail.set(item, { repair, sig });
    }
    return sig;
  }

  private _repair(item: T, repair: number, sig: Signal) {
    const start = this.sim.now;
    this.sim.schedule(repair, () => {
      const from = Math.max(start, this.statsFrom);
      if (this.sim.now > from) item.downTime += this.sim.now - from;
      this._offer(item);
      sig.fire();
    });
  }

  private _qUpdate() {
    const from = Math.max(this.qLast, this.statsFrom);
    if (this.sim.now > from) this.qArea += this.qLen * (this.sim.now - from);
    this.qLast = this.sim.now;
  }

  /** finaliza contabilidade em t=now */
  finalize() {
    this._qUpdate();
    for (const it of this.items) if (it.busy) this._account(it), (it.busySince = this.sim.now);
  }

  utilization(horizon: number): number {
    const span = horizon - this.statsFrom;
    if (span <= 0 || !this.items.length) return 0;
    let b = 0;
    for (const it of this.items) b += it.busyTime;
    return b / (span * this.items.length);
  }

  meanQueue(horizon: number): number {
    const span = horizon - this.statsFrom;
    return span > 0 ? this.qArea / span : 0;
  }
}

export class Sim {
  now = 0;
  private heap = new Heap();
  private seq = 0;
  /** número de eventos executados */
  events = 0;

  schedule(delay: number, fn: Callback) {
    this.heap.push(this.now + Math.max(0, delay), this.seq++, fn);
  }

  spawn(proc: Process | (() => Process)) {
    const g = typeof proc === 'function' ? proc() : proc;
    this.schedule(0, () => this.advance(g, undefined));
  }

  signal() {
    return new Signal(this);
  }

  private advance(g: Process, val: any) {
    const r = g.next(val);
    if (r.done) return;
    const y = r.value;
    if (typeof y === 'number') {
      this.schedule(y, () => this.advance(g, undefined));
    } else if (y instanceof Signal) {
      y._wait(() => this.advance(g, undefined));
    } else if (y instanceof PoolRequest) {
      y.pool._enqueue(y, (item) => this.advance(g, item));
    } else {
      throw new Error('Objeto não suportado em yield');
    }
  }

  /** executa até o tempo `until` (inclusive) */
  runUntil(until: number) {
    const h = this.heap;
    while (h.size && h.peekTime() <= until) {
      const t = h.peekTime();
      const fn = h.pop();
      this.now = t;
      this.events++;
      fn();
    }
    this.now = Math.max(this.now, until);
  }

  get pending() {
    return this.heap.size;
  }
}
