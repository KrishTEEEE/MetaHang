import * as THREE from "three";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { createLandmarker, openCamera, type Landmark } from "./face/landmarker";
import { Calibrator, VERTEX_COUNT } from "./face/calibrate";
import { FaceStateMachine, isUsableFace } from "./face/validity";
import { CropBox } from "./face/faceMesh";
import { Deformer, uvzToDeformSpace } from "./face/deform";
import { Avatar, EYE_HEIGHT } from "./avatar";
import { loadBody } from "./body";
import { createScene } from "./scene";
import { Controls } from "./controls";
import { NetClient } from "./net/client";
import { encodeFace, encodeIdentity, encodePose, STATE_CODE } from "./net/codec";

const POSE_HZ = 20;
const FACE_HZ = 10;
const JPEG_SIZE = 160;
const JPEG_QUALITY = 0.6;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>("view");
const video = $<HTMLVideoElement>("cam");
const overlay = $<HTMLDivElement>("overlay");
const startBtn = $<HTMLButtonElement>("start");
const statusEl = $<HTMLDivElement>("status");
const barEl = $<HTMLDivElement>("bar");
const barFill = barEl.querySelector("i") as HTMLElement;
const errEl = $<HTMLDivElement>("err");
const hudState = $<HTMLSpanElement>("hud-state");
const hudFps = $<HTMLSpanElement>("hud-fps");
const hudPeers = $<HTMLSpanElement>("hud-peers");
const hudNet = $<HTMLSpanElement>("hud-net");

const { renderer, scene, camera, resize } = createScene(canvas);
const controls = new Controls(canvas);

let landmarker: FaceLandmarker | null = null;
let me: Avatar | null = null;
let myColor = 0x000000;

const calibrator = new Calibrator(30);
let calibrating = true;
const faceState = new FaceStateMachine();
const cropBox = new CropBox();
const uvScratch = new Float32Array(VERTEX_COUNT * 2);

const peers = new Map<number, Avatar>();
const peerDeformers = new Map<number, Deformer>();
const pendingPose = new Map<number, { x: number; y: number; z: number; yaw: number; state: number }>();

let deformer: Deformer | null = null;
const zScratch = new Float32Array(VERTEX_COUNT);
const deformSpace = new Float32Array(VERTEX_COUNT * 3);
const posScratch = new Float32Array(VERTEX_COUNT * 3);

const encodeCanvas = document.createElement("canvas");
encodeCanvas.width = encodeCanvas.height = JPEG_SIZE;
const encodeCtx = encodeCanvas.getContext("2d")!;
let encodeInFlight = false;

function colorFor(id: number): number {
  return new THREE.Color().setHSL(((id * 0.618033) % 1), 0.55, 0.58).getHex();
}

// ---------------------------------------------------------------- networking

const net = new NetClient({
  onWelcome(id) {
    myColor = colorFor(id);
    if (me) sendIdentity();
  },
  onJoin() {
    // The avatar is created once their identity arrives — we need rest
    // geometry before there is anything to draw.
  },
  onLeave(id) {
    peers.get(id)?.dispose();
    peers.delete(id);
    peerDeformers.delete(id);
    pendingPose.delete(id);
  },
  onIdentity(id, rest, color) {
    peers.get(id)?.dispose();
    const av = new Avatar(rest, color);
    scene.add(av.group);
    peers.set(id, av);
    // Same rest pose plus the same UV+z stream means a peer's deformer lands on
    // exactly the mesh its owner is rendering.
    peerDeformers.set(id, new Deformer(rest));
    const p = pendingPose.get(id);
    if (p) av.snapTo(p.x, p.y, p.z, p.yaw);
  },
  onPose(id, p) {
    const av = peers.get(id);
    if (!av) {
      pendingPose.set(id, p);
      return;
    }
    av.setTarget(p.x, p.y, p.z, p.yaw);
    av.setAfk(p.state === STATE_CODE.AFK);
  },
  async onFace(id, uv, z, jpeg) {
    const av = peers.get(id);
    if (!av) return;
    // Copy before awaiting: `jpeg` views the socket buffer.
    const blob = new Blob([jpeg.slice()], { type: "image/jpeg" });
    try {
      const bmp = await createImageBitmap(blob);
      const still = peers.get(id);
      if (still !== av) return; // peer churned while decoding
      av.head.setUVs(uv);
      av.head.drawWhole(bmp);
      bmp.close();
      const def = peerDeformers.get(id);
      if (def) {
        uvzToDeformSpace(uv, z, deformSpace);
        def.update(deformSpace, posScratch);
        av.head.setPositions(posScratch);
      }
    } catch {
      /* dropped frame; the previous one stays up */
    }
  },
});

function sendIdentity(): void {
  if (!me) return;
  // Deliberately the stored rest pose, not the live position attribute, which
  // the deformer overwrites every frame.
  net.send(encodeIdentity(me.head.rest, myColor));
}

// ------------------------------------------------------------------- capture

/**
 * Calibration wants a stricter gate than normal operation: the rest geometry is
 * frozen once and everything downstream inherits its mistakes.
 */
function goodForCalibration(lms: Landmark[]): boolean {
  const nose = lms[1], l = lms[234], r = lms[454];
  const dL = Math.abs(nose.x - l.x), dR = Math.abs(r.x - nose.x);
  return Math.min(dL, dR) / Math.max(dL, dR, 1e-6) > 0.8;
}

function finishCalibration(): void {
  const rest = calibrator.finish();
  me = new Avatar(rest, myColor || colorFor(1));
  deformer = new Deformer(rest);
  scene.add(me.group);
  calibrating = false;
  overlay.classList.add("hidden");
  barEl.classList.remove("on");
  sendIdentity();
}

function recalibrate(): void {
  calibrator.reset();
  calibrating = true;
  overlay.classList.remove("hidden");
  barEl.classList.add("on");
  barFill.style.width = "0%";
  startBtn.style.display = "none";
  // The deformer is bound to the old rest pose; a new calibration invalidates it.
  deformer = null;
  if (me) {
    me.dispose();
    me = null;
  }
}

let lastFaceSend = 0;
async function maybeSendFace(now: number): Promise<void> {
  if (!me || encodeInFlight || !net.connected) return;
  if (now - lastFaceSend < 1000 / FACE_HZ) return;
  lastFaceSend = now;
  encodeInFlight = true;
  try {
    encodeCtx.drawImage(me.head.canvas, 0, 0, JPEG_SIZE, JPEG_SIZE);
    const blob = await new Promise<Blob | null>((res) =>
      encodeCanvas.toBlob(res, "image/jpeg", JPEG_QUALITY)
    );
    if (blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      net.send(encodeFace(uvScratch, zScratch, bytes));
    }
  } finally {
    encodeInFlight = false;
  }
}

// ---------------------------------------------------------------- frame loop

let lastVideoTime = -1;
let lastFrame = performance.now();
let lastPoseSend = 0;
let fpsAvg = 0;
let hudTick = 0;
let toneTick = 0;

function tick(): void {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  fpsAvg += (1 / Math.max(dt, 1e-4) - fpsAvg) * 0.05;

  resize();

  // MediaPipe requires strictly increasing timestamps and gains nothing from
  // being run twice on the same camera frame.
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const res = landmarker.detectForVideo(video, now);
    const lms = res.faceLandmarks?.[0] as Landmark[] | undefined;
    const aspect = video.videoWidth / Math.max(video.videoHeight, 1);

    if (calibrating) {
      const ok = !!lms && isUsableFace(lms, aspect) && goodForCalibration(lms);
      if (ok && lms) {
        calibrator.add(lms, video.videoWidth, video.videoHeight);
        statusEl.textContent = "Hold still — building your head…";
        barFill.style.width = `${Math.round(calibrator.progress * 100)}%`;
        if (calibrator.done) finishCalibration();
      } else {
        statusEl.textContent = lms
          ? "Face the camera straight on"
          : "Looking for your face…";
      }
    } else {
      const usable = isUsableFace(lms, aspect);
      const refresh = faceState.update(usable, now);
      if (refresh && lms && me) {
        cropBox.update(lms, video.videoWidth, video.videoHeight);
        cropBox.toUVs(lms, video.videoWidth, video.videoHeight, uvScratch);
        cropBox.toZ(lms, video.videoWidth, zScratch);
        me.head.setUVs(uvScratch);
        me.head.drawSource(video, cropBox.x, cropBox.y, cropBox.w, cropBox.h);

        // Expression only — the rigid fit strips head rotation out, so the head
        // keeps facing wherever the body faces while the face still animates.
        if (deformer) {
          uvzToDeformSpace(uvScratch, zScratch, deformSpace);
          deformer.update(deformSpace, posScratch);
          me.head.setPositions(posScratch);
        }
      }
      me?.setAfk(faceState.state === "AFK");
    }
  }

  controls.update(dt, camera, EYE_HEIGHT);

  if (me) {
    me.group.position.set(controls.position.x, 0, controls.position.z);
    // Body facing is independent of the camera, so orbiting round to the front
    // shows your own face instead of spinning the avatar away from you.
    me.group.rotation.y = controls.bodyYaw;

    if (now - lastPoseSend >= 1000 / POSE_HZ) {
      lastPoseSend = now;
      net.send(encodePose(
        controls.position.x, 0, controls.position.z, controls.bodyYaw,
        STATE_CODE[faceState.state]
      ));
    }
    if (faceState.state === "LIVE") void maybeSendFace(now);
  }

  me?.animate(now / 1000);
  for (const p of peers.values()) {
    p.interpolate(Math.min(1, dt * 12));
    p.animate(now / 1000);
  }

  renderer.render(scene, camera);

  // getImageData is not free, so the cranium tint refreshes about once a second
  // rather than per frame. Nobody's colouring changes faster than that.
  if (now - toneTick > 1000) {
    toneTick = now;
    me?.matchCraniumToFace();
    for (const p of peers.values()) p.matchCraniumToFace();
  }

  if (now - hudTick > 250) {
    hudTick = now;
    const held = faceState.heldSeconds(now);
    hudState.textContent = calibrating
      ? "calibrating"
      : faceState.state + (faceState.state === "HELD" ? ` ${held.toFixed(0)}s` : "");
    hudState.className = "v state-" + (calibrating ? "HELD" : faceState.state);
    hudFps.textContent = fpsAvg.toFixed(0);
    hudPeers.textContent = String(peers.size);
    hudNet.textContent = net.connected
      ? `${(net.bytesUp / 1024).toFixed(0)}k↑ ${(net.bytesDown / 1024).toFixed(0)}k↓`
      : "offline";
  }
}

// ----------------------------------------------------------------- bootstrap

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  errEl.textContent = "";
  try {
    statusEl.textContent = "Starting camera…";
    await openCamera(video);
    statusEl.textContent = "Loading face model…";
    // Both are needed before the first avatar exists, and neither depends on
    // the other.
    [landmarker] = await Promise.all([createLandmarker(), loadBody()]);
    startBtn.style.display = "none";
    barEl.classList.add("on");
    const room = new URLSearchParams(location.search).get("room") ?? "lobby";
    net.connect(room);
  } catch (e) {
    startBtn.disabled = false;
    startBtn.textContent = "Enable camera";
    errEl.textContent = String(e instanceof Error ? e.message : e);
  }
});

addEventListener("keydown", (e) => {
  if (e.code === "KeyC" && !calibrating && landmarker) recalibrate();
});

tick();
