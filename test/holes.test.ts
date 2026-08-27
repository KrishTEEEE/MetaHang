import * as THREE from "three";
import { FaceLandmarker } from "@mediapipe/tasks-vision";
import { MOUTH_HOLE, EYE_HOLES, HoleFans } from "../src/face/holes";
import { faceOvalLoop } from "../src/face/cranium";
import { VERTEX_COUNT } from "../src/face/calibrate";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  ok" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/**
 * The hole rings are hard-coded, which is only safe if they are provably the
 * mesh's actual boundaries. So derive the boundaries from the tesselation —
 * every edge used by exactly one triangle — and require an exact match.
 *
 * This also pins the claim the whole feature rests on: that the mouth *is* a
 * hole. If a future MediaPipe release triangulates the mouth shut, the loop
 * disappears from this list and the test says so rather than the app quietly
 * drawing a membrane on top of real geometry.
 */
function boundaryLoops(): number[][] {
  const e = FaceLandmarker.FACE_LANDMARKS_TESSELATION;
  const count = new Map<string, number>();
  for (let i = 0; i < e.length; i += 3) {
    const t = [e[i].start, e[i + 1].start, e[i + 2].start];
    for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  const adj = new Map<number, number[]>();
  for (const [key, c] of count) {
    if (c !== 1) continue;
    const [a, b] = key.split(",").map(Number);
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const seen = new Set<number>();
  const loops: number[][] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let cur: number | undefined = start, prev = -1;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      loop.push(cur);
      const next: number | undefined = adj.get(cur)!.find((v) => v !== prev && !seen.has(v));
      prev = cur;
      cur = next;
    }
    loops.push(loop);
  }
  return loops;
}

/** Same cycle, allowing any rotation and either direction. */
function sameCycle(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (const cand of [b, [...b].reverse()]) {
    const at = cand.indexOf(a[0]);
    if (at < 0) continue;
    if (a.every((v, i) => v === cand[(at + i) % cand.length])) return true;
  }
  return false;
}

const loops = boundaryLoops();
ok("the mesh has exactly four boundary loops", loops.length === 4, `got ${loops.length}`);

const oval = faceOvalLoop();
const found = (ring: number[]) => loops.some((l) => sameCycle(ring, l));
ok("MOUTH_HOLE is a boundary loop of the tesselation", found(MOUTH_HOLE));
ok("left eye ring is a boundary loop", found(EYE_HOLES[0]));
ok("right eye ring is a boundary loop", found(EYE_HOLES[1]));
ok("the face oval is the remaining one", found(oval));

// Nothing may be shared, or a fan would be stitched to the wrong hole.
const all = [...MOUTH_HOLE, ...EYE_HOLES[0], ...EYE_HOLES[1]];
ok("the three rings are disjoint", new Set(all).size === all.length);

// ------------------------------------------------------------ cavity depth

/** Flat face at z=0 with a mouth that can be opened by moving landmark 14. */
function facePositions(gap: number): Float32Array {
  const p = new Float32Array(VERTEX_COUNT * 3);
  for (let i = 0; i < VERTEX_COUNT; i++) {
    p[i * 3] = ((i % 21) - 10) * 0.01;
    p[i * 3 + 1] = 0;
    p[i * 3 + 2] = 0;
  }
  // The lip gap is measured between 13 and 14, so they must differ by exactly
  // `gap` and nothing else.
  p[13 * 3] = p[14 * 3] = 0;
  p[13 * 3 + 1] = gap / 2;
  p[14 * 3 + 1] = -gap / 2;
  return p;
}

const uv = new Float32Array(VERTEX_COUNT * 2).fill(0.5);
const fans = new HoleFans(new THREE.Texture());
const apexZ = (): number => {
  const pos = fans.mesh.geometry.getAttribute("position");
  return pos.getZ(MOUTH_HOLE.length); // apex follows the mouth ring
};

fans.update(facePositions(0), uv);
ok("a closed mouth has no cavity", Math.abs(apexZ()) < 1e-6, `z=${apexZ()}`);

fans.update(facePositions(0.08), uv);
ok("an open mouth recesses backward", apexZ() < -0.01, `z=${apexZ().toFixed(4)}`);

// -z is behind the face; a positive apex would push the membrane out through
// the lips and render the mouth as a bulge.
ok("the cavity never comes forward", apexZ() < 0);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
