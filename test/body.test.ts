import fs from "node:fs";
import * as THREE from "three";
import { breathe, findNeck, cutAbove } from "../src/body";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  ok" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/**
 * Minimal GLB reader.
 *
 * The point of this suite is to check `body.ts` against the *shipped asset*
 * rather than against a fixture that agrees with it by construction, so the
 * file is parsed here independently of three's loader — which cannot run
 * headless anyway, since it decodes an embedded PNG.
 */
function glb(path: string) {
  const b = fs.readFileSync(path);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString("utf8"));
  const bin = b.subarray(20 + jsonLen + 8);
  const read = (i: number): number[][] => {
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    const dv = new DataView(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0), bv.byteLength);
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type as string]!;
    const out: number[][] = [];
    for (let e = 0; e < a.count; e++) {
      const v: number[] = [];
      for (let c = 0; c < n; c++) {
        const at = (e * n + c) * (a.componentType === 5126 || a.componentType === 5125 ? 4 : 2);
        v.push(a.componentType === 5126 ? dv.getFloat32(at, true) : dv.getUint32(at, true));
      }
      out.push(v);
    }
    return out;
  };
  return { json, read };
}

const { json, read } = glb("public/models/body.glb");

// --------------------------------------------------------- the idle breathe

/**
 * `body.ts` reproduces the shipped clip in closed form instead of running an
 * AnimationMixer. That's only legitimate if the closed form *is* the clip, so
 * check it key by key against the asset. If the model is ever swapped, this
 * fails rather than the avatar silently breathing to a different rhythm.
 */
const anim = json.animations[0];
ok("the asset animates exactly one track", anim.channels.length === 1, `got ${anim.channels.length}`);
ok("and it is a scale track", anim.channels[0].target.path === "scale");

const times = read(anim.samplers[0].input).map((v) => v[0]);
const scales = read(anim.samplers[0].output);
let worst = 0;
let uniform = true;
for (let i = 0; i < times.length; i++) {
  const [x, y, z] = scales[i];
  if (Math.abs(x - y) > 1e-6 || Math.abs(x - z) > 1e-6) uniform = false;
  worst = Math.max(worst, Math.abs(breathe(times[i]) - x));
}
ok("the clip's scale is uniform", uniform);
// The exported keys are rounded to about three decimals, which is the floor on
// how well any closed form can match them.
ok("breathe() reproduces every key", worst < 2e-3, `worst Δ ${worst.toExponential(2)}`);
ok("breathe() loops seamlessly", Math.abs(breathe(0) - breathe(1)) < 1e-12);
ok("breathe() never stretches past rest", breathe(0) <= 1 && breathe(0.5) < 1);

// ------------------------------------------------------- neck detection, cut

const prim = json.meshes[0].primitives[0];
const P = read(prim.attributes.POSITION);
const I = read(prim.indices).map((v) => v[0]);

const geom = new THREE.BufferGeometry();
geom.setAttribute("position", new THREE.Float32BufferAttribute(P.flat(), 3));
geom.setIndex(I);
// The GLB's node chain composes to exactly this: model z becomes world y.
geom.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
geom.computeBoundingBox();
geom.translate(0, -geom.boundingBox!.min.y, 0);
const height = geom.boundingBox!.max.y - geom.boundingBox!.min.y;

const { neckY, neckRadius } = findNeck(geom);

// The cut has to land in the gap between body and head, not on either. Below
// the midpoint would mean slicing the torso; at the very top would mean the
// model's head survives and pokes out around the face mesh.
ok("the neck is above the body's midpoint", neckY > height * 0.5, `y=${neckY.toFixed(3)}`);
ok("the neck is below the crown", neckY < height * 0.85, `y=${neckY.toFixed(3)}`);

let widest = 0;
for (let i = 0; i < P.length; i++) widest = Math.max(widest, Math.hypot(P[i][0], P[i][1]));
ok("the neck is genuinely a waist", neckRadius < widest * 0.5,
   `r=${neckRadius.toFixed(3)} vs widest ${widest.toFixed(3)}`);

const before = geom.getIndex()!.count;
cutAbove(geom, neckY);
const after = geom.getIndex()!.count;
ok("the cut removes triangles", after < before, `${before / 3} → ${after / 3} tris`);
ok("the cut keeps most of the model", after > before * 0.4, `kept ${((after / before) * 100).toFixed(0)}%`);

const pos = geom.getAttribute("position");
const idx = geom.getIndex()!;
let above = 0, lowest = Infinity;
for (let i = 0; i < idx.count; i++) {
  const y = pos.getY(idx.getX(i));
  if (y > neckY + 1e-4) above++;
  lowest = Math.min(lowest, y);
}
ok("nothing survives above the cut", above === 0, `${above} vertices`);
// A cut that also detached the feet would leave the avatar hovering.
ok("the body still reaches the floor", lowest < 1e-4, `lowest y=${lowest.toFixed(4)}`);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
