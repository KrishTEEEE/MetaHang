import {
  MSG_FACE, MSG_IDENTITY, MSG_POSE,
  encodeFace, decodeFace,
  encodeIdentity, decodeIdentity,
  encodePose, decodePose,
} from "../src/net/codec";
import { VERTEX_COUNT } from "../src/face/calibrate";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  ok" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/**
 * The server prepends a 2-byte sender id to the payload before relaying, so
 * every decode happens at offset 3, not 1. Encoding and decoding against
 * different offsets is exactly the kind of bug this reproduces.
 */
function relay(buf: ArrayBuffer): ArrayBuffer {
  const src = new Uint8Array(buf);
  const out = new Uint8Array(src.length + 2);
  out[0] = src[0];
  out[1] = 0x2a; out[2] = 0x01; // id = 298
  out.set(src.subarray(1), 3);
  return out.buffer;
}

console.log("\n— pose —");
{
  const wire = relay(encodePose(1.5, 0, -3.25, 2.1, 2));
  const dv = new DataView(wire);
  ok("type survives relay", dv.getUint8(0) === MSG_POSE);
  ok("id stamped", dv.getUint16(1, true) === 298);
  const p = decodePose(dv, 3);
  ok("x/y/z/yaw round-trip", p.x === 1.5 && p.y === 0 && p.z === -3.25 && Math.abs(p.yaw - 2.1) < 1e-6);
  ok("state round-trips", p.state === 2);
  ok("pose frame is 20 bytes on the wire", wire.byteLength === 20, `${wire.byteLength}`);
}

console.log("\n— identity —");
{
  const rest = new Float32Array(VERTEX_COUNT * 3);
  for (let i = 0; i < rest.length; i++) rest[i] = (i % 97) * 0.01 - 0.5;
  const wire = relay(encodeIdentity(rest, 0x4ade80));
  const got = decodeIdentity(wire, 3);
  ok("colour round-trips", got.color === 0x4ade80, `0x${got.color.toString(16)}`);
  let same = got.rest.length === rest.length;
  for (let i = 0; i < rest.length && same; i++) if (got.rest[i] !== rest[i]) same = false;
  // This is the alignment trap: after the 3-byte header the float data starts
  // at byte 7, so a Float32Array view over the buffer would throw.
  ok("rest geometry survives unaligned offset", same);
}

console.log("\n— face —");
{
  const uv = new Float32Array(VERTEX_COUNT * 2);
  // Crop padding pushes real UVs outside [0,1]; the quantiser must not clamp.
  for (let i = 0; i < uv.length; i++) uv[i] = -0.28 + (i / uv.length) * 1.6;
  // Sized like a real 160px q0.6 face crop rather than a token payload, so the
  // bandwidth assertion below reflects what actually goes over the wire.
  const jpeg = new Uint8Array(5000);
  for (let i = 0; i < jpeg.length; i++) jpeg[i] = (i * 31) & 255;

  // Landmark depths, spanning both signs as a real face does.
  const z = new Float32Array(VERTEX_COUNT);
  for (let i = 0; i < z.length; i++) z[i] = -0.18 + (i / z.length) * 0.34;

  const wire = relay(encodeFace(uv, z, jpeg));
  ok("type survives relay", new DataView(wire).getUint8(0) === MSG_FACE);
  const got = decodeFace(wire, 3);

  let maxErr = 0;
  for (let i = 0; i < uv.length; i++) maxErr = Math.max(maxErr, Math.abs(uv[i] - got.uv[i]));
  ok("UV quantisation stays sub-texel", maxErr < 1e-4, `max err ${maxErr.toExponential(2)}`);

  let zErr = 0, zNeg = 0;
  for (let i = 0; i < z.length; i++) {
    zErr = Math.max(zErr, Math.abs(z[i] - got.z[i]));
    if (got.z[i] < 0) zNeg++;
  }
  ok("depth round-trips", zErr < 1e-4, `max err ${zErr.toExponential(2)}`);
  ok("negative depths survive (signed, not clamped)", zNeg > 0, `${zNeg} negative`);

  let negatives = 0;
  for (let i = 0; i < got.uv.length; i++) if (got.uv[i] < 0) negatives++;
  ok("out-of-range UVs are preserved, not clamped", negatives > 0, `${negatives} negative`);

  let jpegOk = got.jpeg.length === jpeg.length;
  for (let i = 0; i < jpeg.length && jpegOk; i++) if (got.jpeg[i] !== jpeg[i]) jpegOk = false;
  ok("JPEG payload is byte-identical", jpegOk, `${got.jpeg.length} bytes`);

  // ~1.9KB UVs + ~0.9KB depths is a fixed floor at 16-bit precision, regardless
  // of image quality. Worth remembering before tuning JPEG size.
  const kbps = (wire.byteLength * 10) / 1024;
  ok("upstream stays within budget at 10Hz", kbps < 85, `${kbps.toFixed(1)} KB/s up`);
  ok("depth channel costs ~0.9KB/frame", VERTEX_COUNT * 2 === 936, `${VERTEX_COUNT * 2} B`);
}

console.log("\n— message types are distinct —");
ok("POSE/FACE/IDENTITY differ", new Set([MSG_POSE, MSG_FACE, MSG_IDENTITY]).size === 3);

console.log(fails === 0 ? "\nPASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
