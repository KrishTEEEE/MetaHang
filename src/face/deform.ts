import * as THREE from "three";
import { VERTEX_COUNT, HEAD_HEIGHT } from "./calibrate";
import { faceOvalLoop } from "./cranium";

/**
 * Landmarks sitting on rigid skull structure: nose bridge, eye corners, brow
 * ridge, temples.
 *
 * Deliberately excludes jaw, chin, lips and cheeks. Including anything that
 * moves with expression would let the expression itself drag the alignment,
 * and the deformation would partly cancel out — an open mouth would be read as
 * a slightly different head pose instead of an open mouth.
 */
const RIGID = [168, 6, 197, 195, 4, 33, 133, 362, 263, 10, 151, 9, 234, 454, 127, 356];

/** Deformation fades to zero this far from the silhouette. */
const PIN_FALLOFF = 0.12 * HEAD_HEIGHT;
const SMOOTH = 0.5;
const POWER_ITERS = 24;

export type Similarity = {
  q: THREE.Quaternion;
  scale: number;
  cpx: number; cpy: number; cpz: number;
  cqx: number; cqy: number; cqz: number;
};

/**
 * Packs UVs and depths into the space the deformer works in.
 *
 * UVs are already the landmark x/y with y flipped up, in units of the crop
 * width, so they only need z alongside them. Sender and receiver both call
 * this, which is what keeps a peer's deformation identical to the owner's.
 */
export function uvzToDeformSpace(uv: Float32Array, z: Float32Array, out: Float32Array): void {
  for (let i = 0; i < VERTEX_COUNT; i++) {
    out[i * 3] = uv[i * 2];
    out[i * 3 + 1] = uv[i * 2 + 1];
    out[i * 3 + 2] = z[i];
  }
}

/**
 * Best-fit rotation + uniform scale + translation taking the live landmarks
 * onto the rest pose, using only the rigid subset.
 *
 * Rotation comes from Horn's quaternion method: the optimal rotation is the
 * dominant eigenvector of a 4x4 symmetric matrix built from the cross-covariance.
 * Rather than pull in an SVD, this power-iterates — warm-started from last
 * frame's quaternion, which is an excellent guess because heads move slowly, so
 * it converges in a handful of iterations.
 */
export function fitSimilarity(live: Float32Array, rest: Float32Array, q: THREE.Quaternion): Similarity {
  const n = RIGID.length;
  let px = 0, py = 0, pz = 0, cx = 0, cy = 0, cz = 0;
  for (const i of RIGID) {
    px += live[i * 3]; py += live[i * 3 + 1]; pz += live[i * 3 + 2];
    cx += rest[i * 3]; cy += rest[i * 3 + 1]; cz += rest[i * 3 + 2];
  }
  px /= n; py /= n; pz /= n; cx /= n; cy /= n; cz /= n;

  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
  let normP = 0;
  for (const i of RIGID) {
    const ax = live[i * 3] - px, ay = live[i * 3 + 1] - py, az = live[i * 3 + 2] - pz;
    const bx = rest[i * 3] - cx, by = rest[i * 3 + 1] - cy, bz = rest[i * 3 + 2] - cz;
    Sxx += ax * bx; Sxy += ax * by; Sxz += ax * bz;
    Syx += ay * bx; Syy += ay * by; Syz += ay * bz;
    Szx += az * bx; Szy += az * by; Szz += az * bz;
    normP += ax * ax + ay * ay + az * az;
  }

  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  // Shift by the Gershgorin bound so every eigenvalue is non-negative and the
  // one power iteration converges to is the largest, not the most negative.
  let shift = 0;
  for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let c = 0; c < 4; c++) s += Math.abs(N[r][c]);
    if (s > shift) shift = s;
  }
  for (let r = 0; r < 4; r++) N[r][r] += shift;

  // Nudged off the pure identity so a cold start can't sit exactly orthogonal
  // to the true eigenvector, where power iteration would stall.
  let v = [q.w || 1, q.x || 1e-3, q.y || 1e-3, q.z || 1e-3];
  if (!Number.isFinite(v[0] + v[1] + v[2] + v[3])) v = [1, 1e-3, 1e-3, 1e-3];
  for (let it = 0; it < POWER_ITERS; it++) {
    const o = [0, 0, 0, 0];
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let c = 0; c < 4; c++) s += N[r][c] * v[c];
      o[r] = s;
    }
    const len = Math.hypot(o[0], o[1], o[2], o[3]) || 1;
    v = [o[0] / len, o[1] / len, o[2] / len, o[3] / len];
  }
  q.set(v[1], v[2], v[3], v[0]);

  const t = new THREE.Vector3();
  let num = 0;
  for (const i of RIGID) {
    t.set(live[i * 3] - px, live[i * 3 + 1] - py, live[i * 3 + 2] - pz).applyQuaternion(q);
    num += t.x * (rest[i * 3] - cx) + t.y * (rest[i * 3 + 1] - cy) + t.z * (rest[i * 3 + 2] - cz);
  }
  const scale = normP > 1e-12 ? num / normP : 1;

  return { q, scale, cpx: px, cpy: py, cpz: pz, cqx: cx, cqy: cy, cqz: cz };
}

/**
 * Per-vertex deformation strength, zero at the silhouette.
 *
 * The cranium is welded to the rest-pose oval loop, so a moving rim would tear
 * the head open along the jaw. Everything expressive — lips, brows, nostrils —
 * sits well inside the falloff and still deforms fully.
 */
function pinWeights(rest: Float32Array): Float32Array {
  const loop = faceOvalLoop();
  const w = new Float32Array(VERTEX_COUNT);
  for (let i = 0; i < VERTEX_COUNT; i++) {
    let best = Infinity;
    for (const j of loop) {
      const dx = rest[i * 3] - rest[j * 3];
      const dy = rest[i * 3 + 1] - rest[j * 3 + 1];
      const dz = rest[i * 3 + 2] - rest[j * 3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) best = d2;
    }
    const t = Math.min(1, Math.sqrt(best) / PIN_FALLOFF);
    w[i] = t * t * (3 - 2 * t); // smoothstep
  }
  return w;
}

/**
 * Turns live landmarks into expression-only vertex positions.
 *
 * The rigid fit is *removed*, not applied: what survives is jaw drop, lip
 * motion and brow movement, with head rotation stripped out. That's what lets
 * the face animate while the head keeps facing wherever the body faces.
 */
export class Deformer {
  private weights: Float32Array;
  private smoothed = new Float32Array(VERTEX_COUNT * 3);
  private q = new THREE.Quaternion();
  private started = false;

  constructor(private readonly rest: Float32Array) {
    this.weights = pinWeights(rest);
  }

  update(live: Float32Array, out: Float32Array): void {
    const f = fitSimilarity(live, this.rest, this.q);
    const v = new THREE.Vector3();
    for (let i = 0; i < VERTEX_COUNT; i++) {
      v.set(live[i * 3] - f.cpx, live[i * 3 + 1] - f.cpy, live[i * 3 + 2] - f.cpz)
        .applyQuaternion(f.q)
        .multiplyScalar(f.scale);
      const w = this.weights[i];
      out[i * 3] = this.rest[i * 3] + (v.x + f.cqx - this.rest[i * 3]) * w;
      out[i * 3 + 1] = this.rest[i * 3 + 1] + (v.y + f.cqy - this.rest[i * 3 + 1]) * w;
      out[i * 3 + 2] = this.rest[i * 3 + 2] + (v.z + f.cqz - this.rest[i * 3 + 2]) * w;
    }

    // Live landmarks are far noisier than the 30-frame calibration average, so
    // without this the whole mesh shimmers.
    if (!this.started) {
      this.smoothed.set(out);
      this.started = true;
    } else {
      for (let i = 0; i < out.length; i++) {
        this.smoothed[i] += (out[i] - this.smoothed[i]) * SMOOTH;
      }
    }
    out.set(this.smoothed);
  }
}
