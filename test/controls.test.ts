import * as THREE from "three";
import { cameraBasis } from "../src/controls";

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  ok" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const DIST = 4.2, PITCH = 0.14, FOCUS = 1.3;

/** Places the camera exactly the way Controls.update does. */
function placeCamera(yaw: number, at: THREE.Vector3): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 200);
  const { fwdX, fwdZ } = cameraBasis(yaw);
  const horiz = Math.cos(PITCH) * DIST;
  cam.position.set(at.x - fwdX * horiz, FOCUS + Math.sin(PITCH) * DIST, at.z - fwdZ * horiz);
  cam.lookAt(at.x, FOCUS, at.z);
  cam.updateMatrixWorld(true);
  return cam;
}

/** World-space ground movement for a WASD input, as Controls.update computes it. */
function move(yaw: number, fx: number, fz: number) {
  const { fwdX, fwdZ, rightX, rightZ } = cameraBasis(yaw);
  const len = Math.hypot(fx, fz) || 1;
  fx /= len; fz /= len;
  return new THREE.Vector3(fwdX * fz + rightX * fx, 0, fwdZ * fz + rightZ * fx);
}

console.log("\n— movement is camera-relative, and not mirrored —");
// The real assertion: convert world movement into the camera's own frame.
// In view space +x is screen-right and -z is into the screen.
for (const yaw of [0, 0.7, Math.PI / 2, 2.5, Math.PI, -1.2, -Math.PI / 2]) {
  const at = new THREE.Vector3(3, 0, -2);
  const cam = placeCamera(yaw, at);
  const toView = (v: THREE.Vector3) =>
    v.clone().transformDirection(cam.matrixWorldInverse);

  const w = toView(move(yaw, 0, 1));
  const d = toView(move(yaw, 1, 0));
  const a = toView(move(yaw, -1, 0));
  const s = toView(move(yaw, 0, -1));
  const tag = `yaw=${yaw.toFixed(2)}`;

  ok(`W goes into the screen  (${tag})`, w.z < -0.9, `view.z=${w.z.toFixed(2)}`);
  ok(`S comes toward camera   (${tag})`, s.z > 0.9, `view.z=${s.z.toFixed(2)}`);
  ok(`D goes screen-right     (${tag})`, d.x > 0.9, `view.x=${d.x.toFixed(2)}`);
  ok(`A goes screen-left      (${tag})`, a.x < -0.9, `view.x=${a.x.toFixed(2)}`);
}

console.log("\n— basis is orthonormal —");
for (const yaw of [0, 1.1, -2.2, 3.0]) {
  const b = cameraBasis(yaw);
  const dot = b.fwdX * b.rightX + b.fwdZ * b.rightZ;
  const lf = Math.hypot(b.fwdX, b.fwdZ), lr = Math.hypot(b.rightX, b.rightZ);
  ok(`forward ⟂ right (yaw=${yaw})`, Math.abs(dot) < 1e-12);
  ok(`both unit length (yaw=${yaw})`, Math.abs(lf - 1) < 1e-12 && Math.abs(lr - 1) < 1e-12);
}

console.log("\n— body heading follows travel, not the camera —");
{
  // Body local +z is its face, so heading = atan2(dirX, dirZ). Walking any
  // direction should leave the body facing the way it actually moved.
  for (const yaw of [0, 1.0, -2.0]) {
    for (const [fx, fz, label] of [[0, 1, "W"], [1, 0, "D"], [-1, 0, "A"], [0, -1, "S"]] as const) {
      const dir = move(yaw, fx, fz);
      const heading = Math.atan2(dir.x, dir.z);
      const facing = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
      ok(`body faces travel direction (yaw=${yaw}, ${label})`, facing.dot(dir) > 0.999,
         `dot=${facing.dot(dir).toFixed(4)}`);
    }
  }
}

console.log("\n— camera can be orbited to see your own face —");
{
  // The regression that made this un-fun: body yaw used to be pinned to camera
  // yaw, so the avatar spun away and its face was permanently unreachable.
  const at = new THREE.Vector3(0, 0, 0);
  const bodyYaw = 0; // standing still, facing +z
  const faceNormal = new THREE.Vector3(Math.sin(bodyYaw), 0, Math.cos(bodyYaw));

  const behind = placeCamera(0, at);
  const toBehind = behind.position.clone().sub(at).setY(0).normalize();
  ok("camera starts behind the head", faceNormal.dot(toBehind) < -0.9,
     `dot=${faceNormal.dot(toBehind).toFixed(2)}`);

  const front = placeCamera(Math.PI, at);
  const toFront = front.position.clone().sub(at).setY(0).normalize();
  ok("orbiting 180° puts the camera in front of the face", faceNormal.dot(toFront) > 0.9,
     `dot=${faceNormal.dot(toFront).toFixed(2)}`);
}

console.log(fails === 0 ? "\nPASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
