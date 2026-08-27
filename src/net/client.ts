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
  bytesUp = 0;
  bytesDown = 0;
  connected = false;

  constructor(private readonly handlers: NetHandlers) {}

  connect(room: string): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws?room=${encodeURIComponent(room)}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      for (const m of this.queue) ws.send(m);
      this.queue.length = 0;
    };
    ws.onclose = () => {
      this.connected = false;
      // Single-player still works fine without the relay, so retry quietly.
      setTimeout(() => this.connect(room), 2000);
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
