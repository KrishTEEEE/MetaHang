import { Calibrator, HEAD_HEIGHT, VERTEX_COUNT } from "../src/face/calibrate";
import { FaceStateMachine, isUsableFace } from "../src/face/validity";

const W = 1280, H = 720;
let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  ok" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

// Synthetic frontal face in image space (y grows downward, mediapipe z negative = closer).
function fakeFace(yawShift = 0) {
  const lms: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < 478; i++) {
    const a = (i / 478) * Math.PI * 2;
    lms.push({
      x: 0.5 + Math.cos(a) * 0.10 + yawShift,
      y: 0.5 + Math.sin(a) * 0.16,
      z: Math.abs(Math.sin(a)) * 0.02,
    });
  }
  lms[1]  = { x: 0.50 + yawShift, y: 0.52, z: -0.06 }; // nose tip: closest to camera
  lms[234]= { x: 0.40 + yawShift, y: 0.50, z:  0.03 }; // subject's RIGHT cheek (low image x)
  lms[454]= { x: 0.60 + yawShift, y: 0.50, z:  0.03 }; // subject's LEFT cheek
  lms[10] = { x: 0.50 + yawShift, y: 0.32, z:  0.01 }; // top of forehead
  lms[152]= { x: 0.50 + yawShift, y: 0.68, z:  0.01 }; // chin
  return lms;
}

console.log("\n— calibration geometry —");
const cal = new Calibrator(10);
const face = fakeFace();
for (let i = 0; i < 10; i++) cal.add(face, W, H);
ok("reaches done after target frames", cal.done);
const rest = cal.finish();
ok("emits 468 vertices", rest.length === VERTEX_COUNT * 3);

let minY = Infinity, maxY = -Infinity;
for (let i = 0; i < VERTEX_COUNT; i++) { const y = rest[i*3+1]; if (y<minY) minY=y; if (y>maxY) maxY=y; }
ok("head scaled to HEAD_HEIGHT", Math.abs((maxY-minY) - HEAD_HEIGHT) < 1e-5, `got ${(maxY-minY).toFixed(4)}`);

const nose = { x: rest[1*3], y: rest[1*3+1], z: rest[1*3+2] };
let maxZ = -Infinity;
for (let i = 0; i < VERTEX_COUNT; i++) maxZ = Math.max(maxZ, rest[i*3+2]);
ok("nose is the frontmost vertex (+z toward viewer)", Math.abs(nose.z - maxZ) < 1e-6, `nose.z=${nose.z.toFixed(3)}`);

const forehead = rest[10*3+1], chin = rest[152*3+1];
ok("forehead above chin (+y is up)", forehead > chin, `${forehead.toFixed(3)} > ${chin.toFixed(3)}`);

const rightCheekX = rest[234*3], leftCheekX = rest[454*3];
ok("subject's right cheek sits at -x (viewer's left)", rightCheekX < 0 && leftCheekX > 0,
   `R=${rightCheekX.toFixed(3)} L=${leftCheekX.toFixed(3)}`);

console.log("\n— validity gate —");
const aspect = W / H;
ok("accepts a frontal face", isUsableFace(fakeFace(), aspect));
ok("rejects undefined", !isUsableFace(undefined, aspect));
ok("rejects a hard profile", !isUsableFace((() => {
  const f = fakeFace(); f[1].x = 0.405; return f;   // nose almost on the right cheek
})(), aspect));
ok("rejects a too-distant face", !isUsableFace((() => {
  const f = fakeFace(); for (const p of f) { p.x = 0.5 + (p.x-0.5)*0.15; p.y = 0.5 + (p.y-0.5)*0.15; } return f;
})(), aspect));

console.log("\n— LIVE / HELD / AFK —");
const sm = new FaceStateMachine();
let t = 0;
for (let i = 0; i < 5; i++) sm.update(true, t += 33);
ok("5 good frames reach LIVE", sm.state === "LIVE", sm.state);
for (let i = 0; i < 4; i++) sm.update(false, t += 33);
ok("4 bad frames do NOT trip HELD (hysteresis)", sm.state === "LIVE", sm.state);
sm.update(false, t += 33);
ok("5th bad frame trips HELD", sm.state === "HELD", sm.state);

const held0 = t;
while (t - held0 < 29_000) sm.update(false, t += 33);
ok("still HELD at 29s (not flagged AFK early)", sm.state === "HELD", `${sm.heldSeconds(t).toFixed(1)}s`);
while (t - held0 < 31_000) sm.update(false, t += 33);
ok("AFK after 30s", sm.state === "AFK", sm.state);

for (let i = 0; i < 5; i++) sm.update(true, t += 33);
ok("returns to LIVE immediately on face", sm.state === "LIVE", sm.state);
const refresh = sm.update(true, t += 33);
ok("signals texture refresh while LIVE", refresh === true);
ok("suppresses refresh when face is unusable", sm.update(false, t += 33) === false);

console.log(fails === 0 ? "\nPASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
