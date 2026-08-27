import { WebSocketServer, WebSocket } from "ws";

// Deliberately not `PORT` — dev harnesses set that for the web server, and the
// relay stealing it makes Vite silently fall back to another port.
const PORT = Number(process.env.WS_PORT ?? 8787);

const MSG_POSE = 1;
const MSG_FACE = 2;
const MSG_IDENTITY = 3;

type Peer = {
  id: number;
  ws: WebSocket;
  room: string;
  /** Replayed to late joiners so they don't stare at untextured heads. */
  identity?: Buffer;
  lastFace?: Buffer;
  lastPose?: Buffer;
};

const rooms = new Map<string, Set<Peer>>();
let nextId = 1;

const wss = new WebSocketServer({ port: PORT });
console.log(`[facehangout] relay listening on ws://localhost:${PORT}`);

function send(peer: Peer, data: Buffer | string): void {
  if (peer.ws.readyState === WebSocket.OPEN) peer.ws.send(data);
}

/** Relayed frames carry the sender id the server assigned, not one the client claims. */
function stamp(type: number, id: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(3 + payload.length);
  out.writeUInt8(type, 0);
  out.writeUInt16LE(id, 1);
  payload.copy(out, 3);
  return out;
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const room = (url.searchParams.get("room") ?? "lobby").slice(0, 64);
  const peer: Peer = { id: nextId++ & 0xffff, ws, room };

  let set = rooms.get(room);
  if (!set) rooms.set(room, (set = new Set()));

  send(peer, JSON.stringify({ t: "welcome", id: peer.id, room }));

  // Catch the newcomer up on everyone already here.
  for (const other of set) {
    send(peer, JSON.stringify({ t: "join", id: other.id }));
    if (other.identity) send(peer, stamp(MSG_IDENTITY, other.id, other.identity));
    if (other.lastPose) send(peer, stamp(MSG_POSE, other.id, other.lastPose));
    if (other.lastFace) send(peer, stamp(MSG_FACE, other.id, other.lastFace));
  }
  set.add(peer);
  for (const other of set) {
    if (other !== peer) send(other, JSON.stringify({ t: "join", id: peer.id }));
  }
  console.log(`[+] ${peer.id} -> ${room} (${set.size})`);

  ws.on("message", (raw, isBinary) => {
    if (!isBinary) return;
    const buf = raw as Buffer;
    if (buf.length < 1) return;
    const type = buf.readUInt8(0);
    const payload = buf.subarray(1);

    if (type === MSG_IDENTITY) peer.identity = Buffer.from(payload);
    else if (type === MSG_FACE) peer.lastFace = Buffer.from(payload);
    else if (type === MSG_POSE) peer.lastPose = Buffer.from(payload);
    else return;

    const framed = stamp(type, peer.id, payload);
    const members = rooms.get(peer.room);
    if (!members) return;
    for (const other of members) {
      if (other !== peer) send(other, framed);
    }
  });

  const drop = () => {
    const members = rooms.get(peer.room);
    if (!members) return;
    members.delete(peer);
    for (const other of members) send(other, JSON.stringify({ t: "leave", id: peer.id }));
    if (members.size === 0) rooms.delete(peer.room);
    console.log(`[-] ${peer.id} <- ${peer.room} (${members.size})`);
  };
  ws.on("close", drop);
  ws.on("error", drop);
});
