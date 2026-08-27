import * as THREE from "three";
import { Deformer, fitSimilarity, uvzToDeformSpace } from "../src/face/deform";
import { faceOvalLoop } from "../src/face/cranium";
import { Calibrator, VERTEX_COUNT } from "../src/face/calibrate";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  ok" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const RX = 0.105, RY = 0.155;
function syntheticFace() {
  const lms: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < 478; i++) {
    const t = (i * 0.6180339887) % 1, r = Math.sqrt(t), a = i * 2.39996323;
    lms.push({
      x: 0.5 + Math.cos(a) * RX * r,
      y: 0.5 + Math.sin(a) * RY * r,
      z: 0.012 - 0.06 * (1 - r),
    });
  }
  faceOvalLoop().forEach((idx, k) => {
    const a = (k / 36) * Math.PI * 2;
    lms[idx] = { x: 0.5 + Math.cos(a) * RX, y: 0.5 + Math.sin(a) * RY, z: 0.012 };
  });
  return lms;
}

const cal = new Calibrator(4);
for (let i = 0; i < 4; i++) cal.add(syntheticFace(), 1280, 720);
const rest = cal.finish();

/** Applies a rigid similarity to every vertex — a head that moved but didn't emote. */
function rigidlyMoved(src: Float32Array, euler: THREE.Euler, scale: number, tx: number, ty: number, tz: number) {
  const q = new THREE.Quaternion().setFromEuler(euler);
  const out = new Float32Array(src.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < VERTEX_COUNT; i++) {
    v.set(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]).applyQuaternion(q).multiplyScalar(scale);
    out[i * 3] = v.x + tx; out[i * 3 + 1] = v.y + ty; out[i * 3 + 2] = v.z + tz;
  }
  return out;
}

const maxDiff = (a: Float32Array, b: Float32Array) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

/** Most-interior vertex — full deformation weight, standing in for the mouth. */
let centreVertex = 0;
{
  const loop = new Set(faceOvalLoop());
  let best = -1;
  for (let i = 0; i < VERTEX_COUNT; i++) {
    if (loop.has(i)) continue;
    let d = Infinity;
    for (const j of faceOvalLoop()) {
      d = Math.min(d, Math.hypot(rest[i*3]-rest[j*3], rest[i*3+1]-rest[j*3+1], rest[i*3+2]-rest[j*3+2]));
    }
    if (d > best) { best = d; centreVertex = i; }
  }
}

console.log("\n— rigid motion is removed, not reproduced —");
for (const [name, euler, scale] of [
  ["yaw 35°", new THREE.Euler(0, 0.61, 0), 1.0],
  ["pitch 25°", new THREE.Euler(0.44, 0, 0), 1.0],
  ["roll 20°", new THREE.Euler(0, 0, 0.35), 1.0],
  ["yaw+pitch+scale 1.3", new THREE.Euler(0.3, -0.5, 0.15), 1.3],
] as const) {
  const live = rigidlyMoved(rest, euler, scale, 0.7, -0.4, 0.25);
  const out = new Float32Array(VERTEX_COUNT * 3);
  new Deformer(rest).update(live, out);
  // A head that only rotated must render exactly as the rest pose.
  ok(`${name} leaves the mesh at rest`, maxDiff(out, rest) < 2e-3, `max Δ ${maxDiff(out, rest).toExponential(2)}`);
}

console.log("\n— similarity fit recovers the transform —");
{
  const live = rigidlyMoved(rest, new THREE.Euler(0.2, 0.7, -0.3), 1.45, 1, 2, 3);
  const f = fitSimilarity(live, rest, new THREE.Quaternion());
  ok("recovers scale", Math.abs(f.scale - 1 / 1.45) < 1e-3, `${f.scale.toFixed(4)} vs ${(1/1.45).toFixed(4)}`);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.7, -0.3)).invert();
  ok("recovers rotation", Math.min(f.q.angleTo(q), Math.PI - f.q.angleTo(q)) < 0.01,
     `off by ${(f.q.angleTo(q) * 180 / Math.PI).toFixed(2)}°`);
}

console.log("\n— expression survives, and survives rotation —");
{
  const OPEN = 0.09;
  const withMouth = new Float32Array(rest);
  withMouth[centreVertex * 3 + 1] -= OPEN; // drop the "jaw"

  const still = new Float32Array(VERTEX_COUNT * 3);
  new Deformer(rest).update(withMouth, still);
  const moved = Math.abs(still[centreVertex * 3 + 1] - rest[centreVertex * 3 + 1]);
  ok("open mouth actually moves the mesh", moved > OPEN * 0.8, `moved ${moved.toFixed(4)} of ${OPEN}`);

  // Same expression, but the head is also turned 30°. Must look identical.
  const turned = rigidlyMoved(withMouth, new THREE.Euler(0.1, 0.52, -0.2), 1.15, 0.3, 0.2, -0.1);
  const alsoTurned = new Float32Array(VERTEX_COUNT * 3);
  new Deformer(rest).update(turned, alsoTurned);
  ok("head rotation does not leak into the expression",
     maxDiff(alsoTurned, still) < 3e-3, `max Δ ${maxDiff(alsoTurned, still).toExponential(2)}`);
}

console.log("\n— the silhouette stays welded to the cranium —");
{
  const wild = new Float32Array(rest);
  for (let i = 0; i < VERTEX_COUNT; i++) wild[i * 3 + 1] -= 0.05; // deform everything
  const out = new Float32Array(VERTEX_COUNT * 3);
  new Deformer(rest).update(wild, out);

  let worstRim = 0;
  for (const j of faceOvalLoop()) {
    worstRim = Math.max(worstRim,
      Math.hypot(out[j*3]-rest[j*3], out[j*3+1]-rest[j*3+1], out[j*3+2]-rest[j*3+2]));
  }
  ok("rim vertices are pinned", worstRim < 1e-3, `worst rim drift ${worstRim.toExponential(2)}`);
}

console.log("\n— sender and receiver derive identical geometry —");
{
  // The receiver only gets UVs + z, never the raw landmarks. Both sides must
  // land on the same mesh or peers would see a different face from the owner.
  const uv = new Float32Array(VERTEX_COUNT * 2);
  const z = new Float32Array(VERTEX_COUNT);
  for (let i = 0; i < VERTEX_COUNT; i++) {
    uv[i*2] = 0.5 + rest[i*3] * 0.9;
    uv[i*2+1] = 0.5 + rest[i*3+1] * 0.9;
    z[i] = rest[i*3+2] * 0.9;
  }
  const a = new Float32Array(VERTEX_COUNT * 3);
  const b = new Float32Array(VERTEX_COUNT * 3);
  uvzToDeformSpace(uv, z, a);
  uvzToDeformSpace(uv, z, b);
  ok("uvz packing is deterministic", maxDiff(a, b) === 0);

  const outA = new Float32Array(VERTEX_COUNT * 3);
  const outB = new Float32Array(VERTEX_COUNT * 3);
  new Deformer(rest).update(a, outA);
  new Deformer(rest).update(b, outB);
  ok("same input ⇒ same mesh on both ends", maxDiff(outA, outB) === 0);
  let finite = true;
  for (const v of outA) if (!Number.isFinite(v)) finite = false;
  ok("no NaNs escape the fit", finite);
}

console.log(fails === 0 ? "\nPASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
