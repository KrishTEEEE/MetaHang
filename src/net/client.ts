import {
  MSG_FACE, MSG_IDENTITY, MSG_POSE,
  decodeFace, decodeIdentity, decodePose,
} from "./codec";

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
      for (const m of this.queue) ws.send(m);
      this.queue.length = 0;
    };
    ws.onclose = () => {
      this.connected = false;
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
    this.bytesDown += buf.byteLength;
    if (buf.byteLength < 3) return;
    const dv = new DataView(buf);
    const type = dv.getUint8(0);
    const id = dv.getUint16(1, true);

    if (type === MSG_POSE) {
      this.handlers.onPose(id, decodePose(dv, 3));
    } else if (type === MSG_IDENTITY) {
      const { rest, color } = decodeIdentity(buf, 3);
      this.handlers.onIdentity(id, rest, color);
    } else if (type === MSG_FACE) {
      const { uv, z, jpeg } = decodeFace(buf, 3);
      this.handlers.onFace(id, uv, z, jpeg);
    }
  }

  send(buf: ArrayBuffer): void {
    this.bytesUp += buf.byteLength;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf);
    else if (this.queue.length < 4) this.queue.push(buf);
  }
}
