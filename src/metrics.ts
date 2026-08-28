/**
 * Lightweight instrumentation for latency analysis.
 *
 * Everything here is allocation-free on the hot path: ring buffers of fixed
 * size, no closures per sample, no Date allocation. Percentiles are computed
 * only when read (a few times a second for the HUD), not when written.
 */

const WINDOW = 240; // ~8s of 30fps samples, or 24s of face frames at 10Hz

/** A rolling window of numbers, read as percentiles. */
export class Stat {
  private buf = new Float64Array(WINDOW);
  private n = 0;
  private i = 0;
  private total = 0;

  constructor(readonly unit: string = "ms") {}

  push(v: number): void {
    if (!Number.isFinite(v)) return;
    this.buf[this.i] = v;
    this.i = (this.i + 1) % WINDOW;
    if (this.n < WINDOW) this.n++;
    this.total++;
  }

  get count(): number {
    return this.total;
  }
  get filled(): number {
    return this.n;
  }

  /** @param q 0..1. Sorts a copy, so only call at display rate. */
  percentile(q: number): number {
    if (this.n === 0) return NaN;
    const a = Array.prototype.slice.call(this.buf, 0, this.n) as number[];
    a.sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))];
  }
  get p50(): number {
    return this.percentile(0.5);
  }
  get p95(): number {
    return this.percentile(0.95);
  }
  get mean(): number {
    if (this.n === 0) return NaN;
    let s = 0;
    for (let k = 0; k < this.n; k++) s += this.buf[k];
    return s / this.n;
  }
  get max(): number {
    if (this.n === 0) return NaN;
    let m = -Infinity;
    for (let k = 0; k < this.n; k++) if (this.buf[k] > m) m = this.buf[k];
    return m;
  }

  snapshot() {
    return {
      unit: this.unit,
      n: this.n,
      total: this.total,
      p50: round(this.p50),
      p95: round(this.p95),
      mean: round(this.mean),
      max: round(this.max),
    };
  }
}

/**
 * Events (or bytes) per second over a sliding window.
 *
 * Keeps timestamps rather than a decaying average, so a stall shows up as an
 * honest drop to zero instead of a slow fade.
 */
export class Rate {
  private times: number[] = [];
  private amounts: number[] = [];
  constructor(private readonly windowMs = 4000, readonly unit = "/s") {}

  mark(now: number, amount = 1): void {
    this.times.push(now);
    this.amounts.push(amount);
    this.trim(now);
  }

  private trim(now: number): void {
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < this.times.length && this.times[drop] < cutoff) drop++;
    if (drop > 0) {
      this.times.splice(0, drop);
      this.amounts.splice(0, drop);
    }
  }

  perSecond(now: number): number {
    this.trim(now);
    if (this.times.length === 0) return 0;
    let sum = 0;
    for (const a of this.amounts) sum += a;
    const span = Math.max(this.windowMs, now - this.times[0]) / 1000;
    return sum / span;
  }

  snapshot(now: number) {
    return { unit: this.unit, perSecond: round(this.perSecond(now)) };
  }
}

function round(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null as unknown as number;
}

/** Per-peer receive-side health. One of these per remote participant. */
export class PeerMetrics {
  readonly faceGap = new Stat("ms"); // inter-arrival of face frames — jitter
  readonly poseGap = new Stat("ms");
  readonly decode = new Stat("ms"); // createImageBitmap cost
  readonly faceBytes = new Stat("B");
  readonly faceRate = new Rate(4000, "fps");
  lastFaceAt = 0;
  lastPoseAt = 0;

  snapshot(now: number) {
    return {
      faceGapMs: this.faceGap.snapshot(),
      poseGapMs: this.poseGap.snapshot(),
      decodeMs: this.decode.snapshot(),
      faceBytes: this.faceBytes.snapshot(),
      faceFps: this.faceRate.snapshot(now),
      staleMs: this.lastFaceAt ? round(now - this.lastFaceAt) : null,
    };
  }
}

/**
 * The whole picture, in the order a frame actually travels:
 * capture -> detect -> deform -> encode -> socket -> network -> peer decode.
 */
export const M = {
  // --- local pipeline ---
  frame: new Stat("ms"), // whole rAF callback
  detect: new Stat("ms"), // MediaPipe detectForVideo
  crop: new Stat("ms"), // crop box, UVs, depths, blit
  deform: new Stat("ms"), // Procrustes fit + normals
  render: new Stat("ms"), // three.js draw
  encode: new Stat("ms"), // canvas.toBlob JPEG
  encodeBytes: new Stat("B"),
  encodeQueued: new Stat("ms"), // time a send waited because one was in flight
  dropped: new Stat("B"), // frames abandoned rather than queued behind a backlog
  bitmap: new Stat("ms"), // createImageBitmap on the main thread
  workerEncode: new Stat("ms"), // round trip to the encode worker

  // --- transport ---
  rtt: new Stat("ms"), // app-level ping through the relay
  buffered: new Stat("B"), // ws.bufferedAmount — backpressure
  faceSend: new Rate(4000, "fps"),
  poseSend: new Rate(4000, "fps"),
  up: new Rate(4000, "B/s"),
  down: new Rate(4000, "B/s"),

  peers: new Map<number, PeerMetrics>(),

  peer(id: number): PeerMetrics {
    let p = this.peers.get(id);
    if (!p) this.peers.set(id, (p = new PeerMetrics()));
    return p;
  },
  dropPeer(id: number): void {
    this.peers.delete(id);
  },

  snapshot(now: number) {
    const peers: Record<string, unknown> = {};
    for (const [id, p] of this.peers) peers[id] = p.snapshot(now);
    return {
      capturedAt: new Date().toISOString(),
      local: {
        frameMs: this.frame.snapshot(),
        detectMs: this.detect.snapshot(),
        cropMs: this.crop.snapshot(),
        deformMs: this.deform.snapshot(),
        renderMs: this.render.snapshot(),
        encodeMs: this.encode.snapshot(),
        encodeBytes: this.encodeBytes.snapshot(),
        encodeQueuedMs: this.encodeQueued.snapshot(),
        droppedFrames: this.dropped.count,
        bitmapMs: this.bitmap.snapshot(),
        workerEncodeMs: this.workerEncode.snapshot(),
      },
      transport: {
        rttMs: this.rtt.snapshot(),
        bufferedBytes: this.buffered.snapshot(),
        faceSendFps: this.faceSend.snapshot(now),
        poseSendFps: this.poseSend.snapshot(now),
        upBytesPerSec: this.up.snapshot(now),
        downBytesPerSec: this.down.snapshot(now),
      },
      peers,
    };
  },
};

/** Times a synchronous block and records it. Returns whatever fn returns. */
export function timed<T>(stat: Stat, fn: () => T): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    stat.push(performance.now() - t0);
  }
}
