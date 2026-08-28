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

/**
 * Comma-separated list of origins allowed to connect. Unset means allow all,
 * which is what local development wants. Set it in production so a public relay
 * is not free capacity for anyone who finds the URL.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function originAllowed(origin: string | undefined): boolean {
  if (ALLOWED_ORIGINS.length === 0) return true;
  return !!origin && ALLOWED_ORIGINS.includes(origin);
}

// host is explicit because the default binds differently inside a container
// than it does on a laptop, and a relay bound to loopback is invisible to Fly.
const wss = new WebSocketServer({ port: PORT, host: "0.0.0.0" });
console.log(
  `[facehangout] relay listening on 0.0.0.0:${PORT}` +
    (ALLOWED_ORIGINS.length ? ` (origins: ${ALLOWED_ORIGINS.join(", ")})` : " (any origin)")
);

/**
 * Liveness ping. A clean close still arrives on its own, but a client that
 * vanishes — laptop lid, dropped wifi — never sends one, and through a proxy the
 * dead socket can linger indefinitely. Without this, phantom peers accumulate in
 * rooms and everyone keeps seeing an avatar that left.
 */
const HEARTBEAT_MS = 15_000;
const alive = new WeakMap<WebSocket, boolean>();

const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (alive.get(client) === false) {
      client.terminate();
      continue;
    }
    alive.set(client, false);
    client.ping();
  }
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(heartbeat));

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
  if (!originAllowed(req.headers.origin)) {
    console.log(`[!] rejected origin ${req.headers.origin ?? "<none>"}`);
    ws.close(1008, "origin not allowed");
    return;
  }
  alive.set(ws, true);
  ws.on("pong", () => alive.set(ws, true));

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
