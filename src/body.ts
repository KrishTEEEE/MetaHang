import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const BODY_URL = "/models/body.glb";

/**
 * The idle breathe, as a uniform scale about the feet.
 *
 * The shipped clip is 31 linear keys over one second animating a single node's
 * scale, and it is exactly `0.95 + 0.05·cos(2πt)` — checked key by key in
 * `test/body.test.ts`. Reproducing it means no AnimationMixer, no clock
 * plumbing and no per-avatar clip instance, and — the reason that matters — the
 * scale is available in closed form, so the head can be placed on a neck whose
 * height is *known* rather than read back out of the scene graph after the fact.
 *
 * `AMPLITUDE` and `PERIOD` are the artist's; a 10% squash at 1Hz is a lot of
 * breathing once there's a real face on top. They are the knob if it reads as
 * panting.
 */
const AMPLITUDE = 0.1;
const PERIOD = 1.0;

export function breathe(seconds: number): number {
  return 1 - (AMPLITUDE / 2) * (1 - Math.cos((2 * Math.PI * seconds) / PERIOD));
}

export type BodyTemplate = {
  /** Headless, Y-up, feet at y=0. Shared by every avatar. */
  geometry: THREE.BufferGeometry;
  /** Shared; clone before tinting per avatar. */
  material: THREE.Material;
  /** Height of the cut, in the geometry's own units. */
  neckY: number;
  /** Radius of the cut, so the neck can plug it rather than rattle in it. */
  neckRadius: number;
};

let ready: BodyTemplate | null = null;
let pending: Promise<BodyTemplate> | null = null;

/** Resolved template, or null if it hasn't loaded (or failed to). */
export function bodyTemplate(): BodyTemplate | null {
  return ready;
}

export function loadBody(): Promise<BodyTemplate> {
  return (pending ??= new GLTFLoader().loadAsync(BODY_URL).then((gltf) => {
    let mesh: THREE.Mesh | null = null;
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
    });
    if (!mesh) throw new Error("body.glb contains no mesh");
    ready = prepare(mesh);
    return ready;
  }));
}

/**
 * Bakes the node chain into the geometry and cuts the model's own head off.
 *
 * The head has to go: it's a single un-skinned mesh, so there is no node to
 * hide, and leaving it in place would mean the character's head poking out
 * around the face mesh — the calibrated head is *narrower* than this one, so it
 * cannot cover it.
 */
function prepare(mesh: THREE.Mesh): BodyTemplate {
  const geometry = mesh.geometry.clone();
  // The GLB nests three axis-conversion matrices; baking them yields Y-up with
  // the feet at the origin, which is the space everything below assumes.
  geometry.applyMatrix4(mesh.matrixWorld);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const size = box.getSize(new THREE.Vector3());
  if (size.y < size.x || size.y < size.z) {
    throw new Error("body.glb is not upright after baking");
  }
  geometry.translate(0, -box.min.y, 0);

  const { neckY, neckRadius } = findNeck(geometry);
  cutAbove(geometry, neckY);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = (mesh.material as THREE.Material).clone();
  return { geometry, material, neckY, neckRadius };
}

/**
 * The neck, found rather than hard-coded: the model is a surface of revolution,
 * so its profile is a list of rings and the neck is a pinch in that profile.
 * Hard-coding the height would silently mis-cut if the asset were ever swapped
 * for a differently proportioned character.
 *
 * It is the *first* pinch above the widest ring, not the narrowest one — the
 * narrowest ring above the torso is the crown, which is a single vertex of
 * radius zero. Cutting there removes nothing at all.
 */
export function findNeck(geometry: THREE.BufferGeometry): { neckY: number; neckRadius: number } {
  const p = geometry.getAttribute("position");
  geometry.computeBoundingBox();
  const height = geometry.boundingBox!.max.y - geometry.boundingBox!.min.y;

  const verts: { y: number; r: number }[] = [];
  for (let i = 0; i < p.count; i++) {
    verts.push({ y: p.getY(i), r: Math.hypot(p.getX(i), p.getZ(i)) });
  }
  verts.sort((a, b) => a.y - b.y);

  // Swept into groups rather than bucketed by a rounded key. Every hard shading
  // edge duplicates its ring at a height that differs only in the last bits of
  // a float, and either a rounded key or an exact comparison can split those
  // two copies into "rings" whose radii differ by noise — enough to stop the
  // walk below dead at the shoulders.
  const tol = height * 1e-3;
  const profile: { y: number; r: number }[] = [];
  for (const v of verts) {
    const last = profile[profile.length - 1];
    if (last && v.y - last.y <= tol) last.r = Math.max(last.r, v.r);
    else profile.push({ ...v });
  }

  let widest = 0;
  for (let i = 1; i < profile.length; i++) if (profile[i].r > profile[widest].r) widest = i;

  let neck = widest;
  while (neck + 1 < profile.length && profile[neck + 1].r <= profile[neck].r) neck++;
  if (neck === widest || neck === profile.length - 1) {
    throw new Error("body.glb has no waist above its widest ring — no neck to cut at");
  }
  return { neckY: profile[neck].y, neckRadius: profile[neck].r };
}

/**
 * Drops every triangle with a vertex above the cut.
 *
 * The cut ring itself has duplicated vertices for the hard shading edge, so the
 * body keeps a clean rim exactly at `neckY`. The resulting opening is left open
 * — the neck cylinder is sized to plug it, which is cheaper than capping and
 * makes the join read as shoulders rather than as a lid.
 */
export function cutAbove(geometry: THREE.BufferGeometry, neckY: number): void {
  const idx = geometry.getIndex()!;
  const p = geometry.getAttribute("position");
  const eps = 1e-4;
  const kept: number[] = [];
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
    if (p.getY(a) > neckY + eps || p.getY(b) > neckY + eps || p.getY(c) > neckY + eps) continue;
    kept.push(a, b, c);
  }
  geometry.setIndex(kept);
}
