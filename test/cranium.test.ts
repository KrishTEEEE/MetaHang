import * as THREE from "three";
import { buildCranium, faceOvalLoop } from "../src/face/cranium";
import { Calibrator, VERTEX_COUNT } from "../src/face/calibrate";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  ok" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/**
 * A face with realistic relief: nose well forward, brow and lips moderately so,
 * cheeks and jaw shallow, temples slightly behind. This profile is what exposed
 * the original bug — a sphere large enough to be a skull reaches further
 * forward than everything except the nose, brow and lips.
 */
const RX = 0.105, RY = 0.155;

function realisticFace() {
  const lms: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < 478; i++) {
    // Golden-angle scatter over the disc, so the face has a filled interior
    // rather than a bare rim — the interior is precisely what a too-large skull
    // swallows, so a rim-only fixture would make the occlusion test vacuous.
    const t = (i * 0.6180339887) % 1;
    const r = Math.sqrt(t);
    const a = i * 2.39996323;
    lms.push({
      x: 0.5 + Math.cos(a) * RX * r,
      y: 0.5 + Math.sin(a) * RY * r,
      // MediaPipe z is negative toward the camera, so the centre of the face
      // protrudes and the silhouette sits flat.
      z: 0.012 - 0.06 * (1 - r),
    });
  }
  // The silhouette loop must sit exactly on the boundary — the cranium is grown
  // from it, so its radius defines where the dome attaches.
  const loop = faceOvalLoop();
  loop.forEach((idx, k) => {
    const a = (k / loop.length) * Math.PI * 2;
    lms[idx] = { x: 0.5 + Math.cos(a) * RX, y: 0.5 + Math.sin(a) * RY, z: 0.012 };
  });
  lms[1] = { x: 0.5, y: 0.52, z: -0.055 }; // nose tip, most forward
  return lms;
}

const W = 1280, H = 720;
const cal = new Calibrator(5);
const face = realisticFace();
for (let i = 0; i < 5; i++) cal.add(face, W, H);
const rest = cal.finish();

console.log("\n— oval loop —");
{
  const loop = faceOvalLoop();
  ok("36 vertices", loop.length === 36, `${loop.length}`);
  ok("no duplicates", new Set(loop).size === loop.length);
  ok("all indices addressable", loop.every((i) => i >= 0 && i < VERTEX_COUNT));
}

console.log("\n— cranium geometry —");
const geom = buildCranium(rest);
const pos = geom.getAttribute("position");
const idx = geom.getIndex()!;
{
  ok("has geometry", pos.count > 0 && idx.count > 0, `${pos.count} verts, ${idx.count / 3} tris`);
  let bad = 0;
  for (let i = 0; i < pos.count; i++) {
    if (!Number.isFinite(pos.getX(i)) || !Number.isFinite(pos.getY(i)) || !Number.isFinite(pos.getZ(i))) bad++;
  }
  ok("no NaN vertices", bad === 0);

  let degenerate = 0;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
    if (a === b || b === c || a === c) degenerate++;
  }
  ok("no degenerate triangles", degenerate === 0, `${degenerate}`);

  const normals = geom.getAttribute("normal");
  ok("pole faces backward (winding auto-corrected)", normals.getZ(pos.count - 1) < 0,
     `n.z=${normals.getZ(pos.count - 1).toFixed(3)}`);
}

console.log("\n— THE regression: the cranium must never occlude the face —");
{
  // Every face vertex must sit at or in front of the cranium surface at the
  // same (x, y). Rather than approximate, raycast the cranium from far in front
  // and check the hit is behind the face vertex.
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  const dir = new THREE.Vector3(0, 0, -1);

  let occluded = 0, worst = 0, tested = 0;
  for (let i = 0; i < VERTEX_COUNT; i++) {
    const v = new THREE.Vector3(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]);
    ray.set(new THREE.Vector3(v.x, v.y, 100), dir);
    const hits = ray.intersectObject(mesh, false);
    if (!hits.length) continue; // outside the dome's footprint
    tested++;
    const craniumZ = hits[0].point.z;
    if (craniumZ > v.z + 1e-6) {
      occluded++;
      worst = Math.max(worst, craniumZ - v.z);
    }
  }
  ok("cranium footprint covers the face", tested > 300, `${tested} vertices tested`);
  ok("zero face vertices are buried", occluded === 0,
     `${occluded} buried, worst by ${worst.toFixed(4)}`);
}

console.log("\n— the old sphere would have failed this —");
{
  // Guard against the test being vacuous: the exact skull sphere that shipped
  // must be caught by the check above.
  const HEAD_HEIGHT = 0.46;
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(HEAD_HEIGHT * 0.4, 24, 18),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  );
  sphere.scale.set(1, 1.12, 1.05);
  sphere.position.set(0, HEAD_HEIGHT * 0.06, -HEAD_HEIGHT * 0.2);
  sphere.updateMatrixWorld(true);

  const ray = new THREE.Raycaster();
  let buried = 0;
  for (let i = 0; i < VERTEX_COUNT; i++) {
    const v = new THREE.Vector3(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]);
    ray.set(new THREE.Vector3(v.x, v.y, 100), new THREE.Vector3(0, 0, -1));
    const hits = ray.intersectObject(sphere, false);
    if (hits.length && hits[0].point.z > v.z + 1e-6) buried++;
  }
  // ~36% on this fixture, and worse on a real face, whose periphery is flatter
  // than the synthetic one. Enough to prove the check above has teeth.
  ok("old sphere buried a large share of the face (check is not vacuous)",
     buried > VERTEX_COUNT * 0.25,
     `${buried}/${VERTEX_COUNT} = ${((buried / VERTEX_COUNT) * 100).toFixed(0)}%`);
}

console.log(fails === 0 ? "\nPASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
