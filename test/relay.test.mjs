import WebSocket from 'ws';
const URL = 'ws://localhost:8787/?room=testroom';
const wait = ms => new Promise(r => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(URL);
  ws.binaryType = 'arraybuffer';
  const got = { json: [], bin: [] };
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const b = new Uint8Array(raw);
      got.bin.push({ type: b[0], id: b[1] | (b[2] << 8), len: b.length });
    } else got.json.push(JSON.parse(raw.toString()));
  });
  return { ws, got, name, ready: new Promise(r => ws.on('open', r)) };
}

const mk = (type, n) => { const b = new Uint8Array(1 + n); b[0] = type; b.fill(7, 1); return b; };

const a = client('A'), b = client('B');
await Promise.all([a.ready, b.ready]);
await wait(120);

console.log('A welcome/join:', JSON.stringify(a.got.json));
console.log('B welcome/join:', JSON.stringify(b.got.json));

// A publishes identity, pose, face
a.ws.send(mk(3, 5616 + 4));  // identity: color + 468*3 floats
a.ws.send(mk(1, 17));        // pose
a.ws.send(mk(2, 1872 + 900));// face: uvs + jpeg
await wait(150);
console.log('B received from A:', JSON.stringify(b.got.bin));
console.log('A received own echo (should be empty):', JSON.stringify(a.got.bin));

// Late joiner must be caught up on A and B without either resending.
const c = client('C');
await c.ready;
await wait(200);
console.log('C json:', JSON.stringify(c.got.json));
console.log('C replayed binary:', JSON.stringify(c.got.bin));

// Disconnect A, B and C should be told
a.ws.close();
await wait(150);
console.log('B saw leave:', JSON.stringify(b.got.json.filter(m => m.t === 'leave')));

const aId = a.got.json.find(m => m.t === 'welcome').id;
const pass =
  b.got.bin.length === 3 &&
  b.got.bin.every(m => m.id === aId) &&
  a.got.bin.length === 0 &&
  c.got.bin.some(m => m.type === 3 && m.id === aId) &&
  c.got.bin.some(m => m.type === 2 && m.id === aId) &&
  c.got.json.filter(m => m.t === 'join').length === 2 &&
  b.got.json.some(m => m.t === 'leave' && m.id === aId);
console.log(pass ? 'PASS' : 'FAIL');
b.ws.close(); c.ws.close();
process.exit(pass ? 0 : 1);
