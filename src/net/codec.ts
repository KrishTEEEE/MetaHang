import { VERTEX_COUNT } from "../face/calibrate";

export const MSG_POSE = 1;
export const MSG_FACE = 2;
export const MSG_IDENTITY = 3;

export const STATE_CODE = { LIVE: 0, HELD: 1, AFK: 2 } as const;
export const STATE_NAME = ["LIVE", "HELD", "AFK"] as const;

// UVs sit near [0,1] but the crop padding pushes some outside, so the quantised
// range is widened rather than clamped. 2/65535 ≈ 3e-5 precision, far below a
// texel at any sane crop size.
const UV_MIN = -0.5;
const UV_SPAN = 2;

export function encodePose(x: number, y: number, z: number, yaw: number, state: number): ArrayBuffer {
  const buf = new ArrayBuffer(1 + 16 + 1);
  const dv = new DataView(buf);
  dv.setUint8(0, MSG_POSE);
  dv.setFloat32(1, x, true);
  dv.setFloat32(5, y, true);
  dv.setFloat32(9, z, true);
  dv.setFloat32(13, yaw, true);
  dv.setUint8(17, state);
  return buf;
}

export function decodePose(dv: DataView, off: number) {
  return {
    x: dv.getFloat32(off, true),
    y: dv.getFloat32(off + 4, true),
    z: dv.getFloat32(off + 8, true),
    yaw: dv.getFloat32(off + 12, true),
    state: dv.getUint8(off + 16),
  };
}

export function encodeIdentity(rest: Float32Array, color: number): ArrayBuffer {
  const buf = new ArrayBuffer(1 + 4 + rest.byteLength);
  const dv = new DataView(buf);
  dv.setUint8(0, MSG_IDENTITY);
  dv.setUint32(1, color, true);
  // Byte 5 is not 4-byte aligned, so a Float32Array view here throws. Copy
  // through a Uint8Array, which has no alignment requirement. `rest` is itself
  // a view into three.js's geometry buffer, hence the explicit byteOffset.
  new Uint8Array(buf, 5).set(
    new Uint8Array(rest.buffer, rest.byteOffset, rest.byteLength)
  );
  return buf;
}

export function decodeIdentity(buf: ArrayBuffer, off: number) {
  const dv = new DataView(buf);
  const color = dv.getUint32(off, true);
  // The Float32Array view needs 4-byte alignment, which `off + 4` may not have,
  // so copy the bytes out rather than aliasing the socket buffer.
  const rest = new Float32Array(VERTEX_COUNT * 3);
  new Uint8Array(rest.buffer).set(new Uint8Array(buf, off + 4, rest.byteLength));
  return { color, rest };
}

// Landmark depth, in the same crop-width units as the UVs. Real faces span far
// less than this, so the range is generous rather than tight.
const Z_SPAN = 1;

/**
 * UVs, depths and the JPEG travel together so a frame can never be textured
 * with stale UVs or deformed by mismatched depths.
 *
 * UVs double as the landmark x/y, so adding only z lets a receiver rebuild the
 * exact same expression geometry the sender computed — 936 extra bytes, versus
 * thousands for shipping vertex positions.
 */
export function encodeFace(uv: Float32Array, z: Float32Array, jpeg: Uint8Array): ArrayBuffer {
  const n = VERTEX_COUNT * 2;
  const zOff = 1 + n * 2;
  const buf = new ArrayBuffer(zOff + VERTEX_COUNT * 2 + jpeg.byteLength);
  const bytes = new Uint8Array(buf);
  bytes[0] = MSG_FACE;
  const dv = new DataView(buf);
  for (let i = 0; i < n; i++) {
    const q = Math.round(((uv[i] - UV_MIN) / UV_SPAN) * 65535);
    dv.setUint16(1 + i * 2, Math.max(0, Math.min(65535, q)), true);
  }
  for (let i = 0; i < VERTEX_COUNT; i++) {
    const q = Math.round((z[i] / Z_SPAN) * 32767);
    dv.setInt16(zOff + i * 2, Math.max(-32768, Math.min(32767, q)), true);
  }
  bytes.set(jpeg, zOff + VERTEX_COUNT * 2);
  return buf;
}

export function decodeFace(buf: ArrayBuffer, off: number) {
  const n = VERTEX_COUNT * 2;
  const dv = new DataView(buf);
  const uv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    uv[i] = (dv.getUint16(off + i * 2, true) / 65535) * UV_SPAN + UV_MIN;
  }
  const zOff = off + n * 2;
  const z = new Float32Array(VERTEX_COUNT);
  for (let i = 0; i < VERTEX_COUNT; i++) {
    z[i] = (dv.getInt16(zOff + i * 2, true) / 32767) * Z_SPAN;
  }
  const jpeg = new Uint8Array(buf, zOff + VERTEX_COUNT * 2);
  return { uv, z, jpeg };
}
