import {
  MSG_FACE, MSG_IDENTITY, MSG_POSE, MSG_PONG,
  decodeFace, decodeIdentity, decodePose, encodePing,
} from "./codec";
import { M } from "../metrics";

export type NetHandlers = {
  onWelcome(id: number, room: string): void;
  onJoin(id: number): void;
  onLeave(id: number): void;
  onIdentity(id: number, rest: Float32Array, color: number): void;
  onPose(id: number, p: { x: number; y: number; z: number; yaw: number; state: number }): void;
  onFace(id: number, uv: Float32Array, z: Float32Array, jpeg: Uint8Array): void;
};

export class NetClient {
  private ws?: WebSocket;
  private queue: ArrayBuffer[] = [];
  private attempt = 0;
  private pingSeq = 0;
  private pingSentAt = new Map<number, number>();
  private pingTimer?: ReturnType<typeof setInterval>;
  bytesUp = 0;
  bytesDown = 0;
  connected = false;

  constructor(private readonly handlers: NetHandlers) {}

  /**
   * Relay address. In production VITE_RELAY_URL points at the deployed relay,
   * because a static host has nothing listening on /ws. Unset locally, where the
   * Vite dev proxy forwards /ws to the relay on 8787.
   */
  private relayUrl(room: string): string {
    const configured = import.meta.env.VITE_RELAY_URL?.replace(/\/+$/, "");
    const base = configured
      ? `${configured}/`
      : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
    return `${base}?room=${encodeURIComponent(room)}`;
  }

  connect(room: string): void {
    const ws = new WebSocket(this.relayUrl(room));
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.attempt = 0;
      this.startPinging();
      for (const m of this.queue) ws.send(m);
      this.queue.length = 0;
    };
    ws.onclose = () => {
      this.connected = false;
      this.stopPinging();
      // Single-player still works fine without the relay, so retry quietly —
      // but back off, so a page with no relay configured at all does not
      // reconnect twice a second forever.
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt++);
      setTimeout(() => this.connect(room), delay);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => this.receive(ev.data);
  }

  private receive(data: unknown): void {
    if (typeof data === "string") {
      const m = JSON.parse(data);
      if (m.t === "welcome") this.handlers.onWelcome(m.id, m.room);
      else if (m.t === "join") this.handlers.onJoin(m.id);
      else if (m.t === "leave") this.handlers.onLeave(m.id);
      return;
    }
    const buf = data as ArrayBuffer;
    const now = performance.now();
    this.bytesDown += buf.byteLength;
    M.down.mark(now, buf.byteLength);

    // Pong comes back unframed (the relay does not stamp a sender id onto it).
    if (buf.byteLength >= 5 && new DataView(buf).getUint8(0) === MSG_PONG) {
      const seq = new DataView(buf).getUint32(1, true);
      const sent = this.pingSentAt.get(seq);
      if (sent !== undefined) {
        M.rtt.push(now - sent);
        this.pingSentAt.delete(seq);
      }
      return;
    }

    if (buf.byteLength < 3) return;
    const dv = new DataView(buf);
    const type = dv.getUint8(0);
    const id = dv.getUint16(1, true);

    if (type === MSG_POSE) {
      const pm = M.peer(id);
      if (pm.lastPoseAt) pm.poseGap.push(now - pm.lastPoseAt);
      pm.lastPoseAt = now;
      this.handlers.onPose(id, decodePose(dv, 3));
    } else if (type === MSG_IDENTITY) {
      const { rest, color } = decodeIdentity(buf, 3);
      this.handlers.onIdentity(id, rest, color);
    } else if (type === MSG_FACE) {
      const pm = M.peer(id);
      if (pm.lastFaceAt) pm.faceGap.push(now - pm.lastFaceAt);
      pm.lastFaceAt = now;
      pm.faceRate.mark(now);
      pm.faceBytes.push(buf.byteLength);
      const { uv, z, jpeg } = decodeFace(buf, 3);
      this.handlers.onFace(id, uv, z, jpeg);
    }
  }

  /**
   * Round-trip probe. The relay echoes the sequence number, so this measures
   * client -> relay -> client with no clock synchronisation needed. One-way to
   * a peer is roughly (this + their RTT) / 2.
   */
  private startPinging(): void {
    this.stopPinging();
    const beat = () => {
      const seq = ++this.pingSeq >>> 0;
      this.pingSentAt.set(seq, performance.now());
      // Drop anything unanswered for a while, so a lossy link cannot leak.
      if (this.pingSentAt.size > 32) {
        const oldest = this.pingSentAt.keys().next().value;
        if (oldest !== undefined) this.pingSentAt.delete(oldest);
      }
      this.rawSend(encodePing(seq));
    };
    beat();
    this.pingTimer = setInterval(beat, 2000);
  }

  private stopPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.pingSentAt.clear();
  }

  /** Live send-buffer depth, so callers can drop rather than pile on. */
  get bufferedAmount(): number {
    return this.ws?.readyState === WebSocket.OPEN ? this.ws.bufferedAmount : 0;
  }

  /** Bytes sitting in the socket's send buffer — the backpressure signal. */
  sampleBuffered(): void {
    if (this.ws?.readyState === WebSocket.OPEN) M.buffered.push(this.ws.bufferedAmount);
  }

  private rawSend(buf: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf);
  }

  send(buf: ArrayBuffer): void {
    this.bytesUp += buf.byteLength;
    M.up.mark(performance.now(), buf.byteLength);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf);
    else if (this.queue.length < 4) this.queue.push(buf);
  }
}
