import * as THREE from "three";
import { FaceLandmarker } from "@mediapipe/tasks-vision";

const RINGS = 10;
/** Back-of-head depth, as a multiple of the face silhouette's radius. */
const DEPTH_RATIO = 1.15;

/**
 * The face oval as an ordered, closed ring of landmark indices.
 *
 * `FACE_LANDMARKS_FACE_OVAL` is an unordered-looking edge list, but every edge's
 * `end` is another edge's `start`, so chaining them yields the silhouette loop
 * (36 vertices, verified closed and duplicate-free).
 */
export function faceOvalLoop(): number[] {
  const edges = FaceLandmarker.FACE_LANDMARKS_FACE_OVAL;
  const next = new Map(edges.map((e) => [e.start, e.end]));
  const loop: number[] = [];
  let cur = edges[0].start;
  for (let i = 0; i < edges.length; i++) {
    loop.push(cur);
    const nxt = next.get(cur);
    if (nxt === undefined || nxt === loop[0]) break;
    cur = nxt;
  }
  return loop;
}

/**
 * Builds the back of the head as a dome grown backward from the face's own
 * silhouette.
 *
 * The previous approach — a plain sphere behind the face — was wrong in a way
 * that looked catastrophic: a sphere big enough to read as a skull reaches
 * further forward than the cheeks, forehead and jaw do, so it swallowed most of
 * the face and left only the nose, brow and lips poking through. A generic
 * hemisphere has the same failure mode.
 *
 * Growing the dome from the oval loop instead means it starts exactly where the
 * face ends and only ever travels backward, so it cannot occlude any part of
 * the face no matter how the calibration came out.
 */
export function buildCranium(rest: Float32Array): THREE.BufferGeometry {
  const loop = faceOvalLoop();
  const n = loop.length;

  const L = loop.map(
    (i) => new THREE.Vector3(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2])
  );
  const centre = new THREE.Vector3();
  for (const p of L) centre.add(p);
  centre.divideScalar(n);

  let radius = 0;
  for (const p of L) radius = Math.max(radius, Math.hypot(p.x - centre.x, p.y - centre.y));
  const poleZ = centre.z - radius * DEPTH_RATIO;

  const pos: number[] = [];
  for (let t = 0; t < RINGS; t++) {
    const theta = (t / RINGS) * (Math.PI / 2);
    const lateral = Math.cos(theta);
    const back = Math.sin(theta);
    for (let i = 0; i < n; i++) {
      const p = L[i];
      pos.push(
        centre.x + (p.x - centre.x) * lateral,
        centre.y + (p.y - centre.y) * lateral,
        p.z + (poleZ - p.z) * back
      );
    }
  }
  const poleIndex = RINGS * n;
  pos.push(centre.x, centre.y, poleZ);

  const idx: number[] = [];
  for (let t = 0; t < RINGS - 1; t++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = t * n + i, b = t * n + j;
      const c = (t + 1) * n + i, d = (t + 1) * n + j;
      idx.push(a, c, b, b, c, d);
    }
  }
  for (let i = 0; i < n; i++) {
    idx.push((RINGS - 1) * n + i, poleIndex, (RINGS - 1) * n + ((i + 1) % n));
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geom.setIndex(idx);
  geom.computeVertexNormals();

  // The oval loop's winding direction isn't documented, so rather than assume
  // it, check the result: the pole must face backward. If it doesn't, the whole
  // dome is inside-out and every triangle needs reversing.
  const normals = geom.getAttribute("normal");
  if (normals.getZ(poleIndex) > 0) {
    for (let i = 0; i < idx.length; i += 3) {
      const tmp = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = tmp;
    }
    geom.setIndex(idx);
    geom.computeVertexNormals();
  }

  return geom;
}
