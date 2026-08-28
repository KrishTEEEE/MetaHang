import * as THREE from "three";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { createLandmarker, openCamera, type Landmark } from "./face/landmarker";
import { Calibrator, VERTEX_COUNT } from "./face/calibrate";
import { FaceStateMachine, isUsableFace } from "./face/validity";
import { CropBox } from "./face/faceMesh";
import { Deformer, uvzToDeformSpace } from "./face/deform";
import { M, timed } from "./metrics";
import { Tuning } from "./tuning";
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
const mEl = {
  detect: $<HTMLSpanElement>("m-detect"), crop: $<HTMLSpanElement>("m-crop"),
  deform: $<HTMLSpanElement>("m-deform"), encode: $<HTMLSpanElement>("m-encode"),
  render: $<HTMLSpanElement>("m-render"), frame: $<HTMLSpanElement>("m-frame"),
  rtt: $<HTMLSpanElement>("m-rtt"), buf: $<HTMLSpanElement>("m-buf"),
  facehz: $<HTMLSpanElement>("m-facehz"), jpeg: $<HTMLSpanElement>("m-jpeg"),
  peers: $<HTMLDivElement>("m-peers"),
};

const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v) : 0);
/** "p50/p95" with a colour cue once a stage starts costing real time. */
function showStat(el: HTMLElement, st: { p50: number; p95: number }, warn: number, bad: number): void {
  el.textContent = `${n0(st.p50)}/${n0(st.p95)}`;
  el.className = "v" + (st.p95 >= bad ? " bad" : st.p95 >= warn ? " warn" : "");
}

const { renderer, scene, camera, resize, setLightScale } = createScene(canvas);
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

/**
 * Off-thread JPEG encoder. Falls back to the main thread if the browser lacks
 * OffscreenCanvas, so this is an optimisation rather than a requirement.
 */
const encodeWorker: Worker | null = (() => {
  try {
    if (typeof OffscreenCanvas === "undefined") return null;
    return new Worker(new URL("./encodeWorker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
})();

let encodeReqId = 0;
const encodeWaiting = new Map<number, (b: ArrayBuffer | null) => void>();
if (encodeWorker) {
  encodeWorker.onmessage = (e: MessageEvent<{ id: number; buf?: ArrayBuffer }>) => {
    const done = encodeWaiting.get(e.data.id);
    if (!done) return;
    encodeWaiting.delete(e.data.id);
    done(e.data.buf ?? null);
  };
}

async function encodeJpeg(source: HTMLCanvasElement, quality: number): Promise<Uint8Array | null> {
  const useWorker = encodeWorker && tuning.get("network", "worker") === 1;
  if (useWorker) {
    const t0 = performance.now();
    const bitmap = await createImageBitmap(source);
    M.bitmap.push(performance.now() - t0);
    const id = ++encodeReqId;
    const t1 = performance.now();
    const buf = await new Promise<ArrayBuffer | null>((res) => {
      encodeWaiting.set(id, res);
      encodeWorker!.postMessage({ id, bitmap, size: JPEG_SIZE, quality }, [bitmap]);
    });
    M.workerEncode.push(performance.now() - t1);
    return buf ? new Uint8Array(buf) : null;
  }
  encodeCtx.drawImage(source, 0, 0, JPEG_SIZE, JPEG_SIZE);
  const blob = await new Promise<Blob | null>((res) =>
    encodeCanvas.toBlob(res, "image/jpeg", quality)
  );
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

// ------------------------------------------------------------------- tuning

const tuning = new Tuning({
  capture: {
    title: "Face texture",
    note: "Applied as the crop is blitted. Affects what peers see too.",
    params: {
      brightness: { label: "brightness", min: 0.2, max: 3, step: 0.05, value: 1.6, suffix: "×" },
      contrast:   { label: "contrast",   min: 0.2, max: 3, step: 0.05, value: 1, suffix: "×" },
      saturate:   { label: "saturate",   min: 0,   max: 3, step: 0.05, value: 1, suffix: "×" },
      preview:    { label: "raw cam preview", kind: "toggle", min: 0, max: 1, step: 1, value: 0,
                    hint: "Unprocessed webcam feed. If that looks fine while the avatar is dark, the cause is lighting, not capture." },
    },
  },
  lighting: {
    title: "Lighting",
    note: "The face is a lit material, so these change it without touching the texture.",
    params: {
      selfLit: { label: "self-lit", min: 0, max: 1, step: 0.05, value: 0.25, suffix: "×",
                 hint: "1.0 makes the face ignore scene lights entirely." },
      lights:  { label: "scene lights", min: 0, max: 4, step: 0.05, value: 2.65, suffix: "×" },
    },
  },
  gaze: {
    title: "Gaze",
    note: "Shifts where the eye region samples the video. Cosmetic, not true gaze redirection.",
    params: {
      // Texture v is 1 - normalised image y, so *lower* v samples further down
      // the image. Looking at a screen puts the iris low in the eye opening, so
      // countering it needs a negative value, not a positive one.
      lift: { label: "eye lift", min: -0.06, max: 0.06, step: 0.002, value: -0.008,
              hint: "Negative samples lower, countering eyes aimed down at a screen." },
    },
  },
  network: {
    title: "Network",
    params: {
      faceHz:   { label: "face rate", min: 2, max: 20, step: 1, value: FACE_HZ, suffix: "Hz" },
      quality:  { label: "jpeg quality", min: 0.2, max: 0.95, step: 0.05, value: JPEG_QUALITY },
      worker: { label: "off-thread encode", kind: "toggle", min: 0, max: 1, step: 1, value: 1,
                hint: "Encode JPEG in a worker instead of on the main thread, where it competes with MediaPipe. Toggle to A/B it." },
      maxBuffered: { label: "drop above", min: 0, max: 400, step: 10, value: 190, suffix: "KB",
                     hint: "Skip a frame rather than queue it when the socket is this far behind. 0 disables." },
    },
  },
});

const camPreview = document.createElement("video");
camPreview.autoplay = true; camPreview.playsInline = true; camPreview.muted = true;
camPreview.style.cssText =
  "position:fixed;bottom:12px;right:12px;width:220px;border:1px solid #232a38;" +
  "border-radius:8px;z-index:19;display:none;background:#000";
document.body.appendChild(camPreview);

function applyTuning(): void {
  const b = tuning.get("capture", "brightness");
  const c = tuning.get("capture", "contrast");
  const sat = tuning.get("capture", "saturate");
  const filter = b === 1 && c === 1 && sat === 1
    ? ""
    : `brightness(${b}) contrast(${c}) saturate(${sat})`;
  const selfLit = tuning.get("lighting", "selfLit");
  const lift = tuning.get("gaze", "lift");

  // The filter runs on the canvas that gets JPEG-encoded, so it is already
  // baked into what peers receive. Applying it to their heads as well would
  // brighten twice (1.6 x 1.6). Capture settings are the sender's business.
  me?.head.setTextureFilter(filter);

  // Lighting and gaze are local render choices, so they do apply to everyone
  // on screen — each viewer corrects what they see.
  for (const head of [me?.head, ...[...peers.values()].map((p) => p.head)]) {
    head?.setSelfLit(selfLit);
    head?.setEyeLift(lift);
  }
  setLightScale(tuning.get("lighting", "lights"));
  camPreview.style.display = tuning.get("capture", "preview") ? "block" : "none";
}
tuning.onChange(applyTuning);

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
    M.dropPeer(id);
  },
  onIdentity(id, rest, color) {
    peers.get(id)?.dispose();
    const av = new Avatar(rest, color);
    scene.add(av.group);
    peers.set(id, av);
    // Same rest pose plus the same UV+z stream means a peer's deformer lands on
    // exactly the mesh its owner is rendering.
    peerDeformers.set(id, new Deformer(rest));
    applyTuning();
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
    const t0 = performance.now();
    try {
      const bmp = await createImageBitmap(blob);
      M.peer(id).decode.push(performance.now() - t0);
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
  applyTuning();
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
  if (!me || !net.connected) return;
  if (now - lastFaceSend < 1000 / tuning.get("network", "faceHz")) return;
  // A send skipped because the previous encode is still running is the signal
  // that encoding, not the network, is capping the frame rate.
  if (encodeInFlight) {
    M.encodeQueued.push(now - lastFaceSend);
    return;
  }
  lastFaceSend = now;
  encodeInFlight = true;
  const t0 = performance.now();
  try {
    const bytes = await encodeJpeg(me.head.canvas, tuning.get("network", "quality"));
    if (bytes) {
      M.encode.push(performance.now() - t0);
      M.encodeBytes.push(bytes.byteLength);
      // Queueing a real-time frame behind a backlog only makes it arrive later
      // and staler. Past the threshold, drop it and send the next one instead.
      const cap = tuning.get("network", "maxBuffered") * 1024;
      if (cap > 0 && net.bufferedAmount > cap) {
        M.dropped.push(net.bufferedAmount);
      } else {
        net.send(encodeFace(uvScratch, zScratch, bytes));
        M.faceSend.mark(performance.now());
      }
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
  const frameStart = performance.now();
  const now = frameStart;
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  fpsAvg += (1 / Math.max(dt, 1e-4) - fpsAvg) * 0.05;

  resize();

  // MediaPipe requires strictly increasing timestamps and gains nothing from
  // being run twice on the same camera frame.
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const res = timed(M.detect, () => landmarker!.detectForVideo(video, now));
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
        timed(M.crop, () => {
          cropBox.update(lms, video.videoWidth, video.videoHeight);
          cropBox.toUVs(lms, video.videoWidth, video.videoHeight, uvScratch);
          cropBox.toZ(lms, video.videoWidth, zScratch);
          me!.head.setUVs(uvScratch);
          me!.head.drawSource(video, cropBox.x, cropBox.y, cropBox.w, cropBox.h);
        });

        // Expression only — the rigid fit strips head rotation out, so the head
        // keeps facing wherever the body faces while the face still animates.
        if (deformer) {
          timed(M.deform, () => {
            uvzToDeformSpace(uvScratch, zScratch, deformSpace);
            deformer!.update(deformSpace, posScratch);
            me!.head.setPositions(posScratch);
          });
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
      M.poseSend.mark(now);
    }
    if (faceState.state === "LIVE") void maybeSendFace(now);
  }

  me?.animate(now / 1000);
  for (const p of peers.values()) {
    p.interpolate(Math.min(1, dt * 12));
    p.animate(now / 1000);
  }

  timed(M.render, () => renderer.render(scene, camera));

  // getImageData is not free, so the cranium tint refreshes about once a second
  // rather than per frame. Nobody's colouring changes faster than that.
  if (now - toneTick > 1000) {
    toneTick = now;
    me?.matchCraniumToFace();
    for (const p of peers.values()) p.matchCraniumToFace();
  }

  M.frame.push(performance.now() - frameStart);
  net.sampleBuffered();

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
      ? `${(M.up.perSecond(now) / 1024).toFixed(0)}↑ ${(M.down.perSecond(now) / 1024).toFixed(0)}↓ KB/s`
      : "offline";

    // A stage over ~16ms is eating a frame at 60fps; over 33ms it is halving it.
    showStat(mEl.detect, M.detect, 16, 33);
    showStat(mEl.crop, M.crop, 4, 10);
    showStat(mEl.deform, M.deform, 4, 10);
    showStat(mEl.encode, M.encode, 20, 50);
    showStat(mEl.render, M.render, 8, 16);
    showStat(mEl.frame, M.frame, 20, 40);
    // RTT is the network floor; nothing downstream can be faster than this.
    showStat(mEl.rtt, M.rtt, 120, 300);
    // Anything persistently buffered means we are sending faster than the link.
    mEl.buf.textContent = `${n0(M.buffered.p95)} B`;
    mEl.buf.className = "v" + (M.buffered.p95 > 200_000 ? " bad" : M.buffered.p95 > 20_000 ? " warn" : "");

    const hz = M.faceSend.perSecond(now);
    mEl.facehz.textContent = `${hz.toFixed(1)}/${FACE_HZ} Hz`;
    mEl.facehz.className = "v" + (hz < FACE_HZ * 0.6 ? " bad" : hz < FACE_HZ * 0.85 ? " warn" : "");
    mEl.jpeg.textContent = `${(M.encodeBytes.p50 / 1024).toFixed(1)} KB · ${M.dropped.count} drop`;

    if (peers.size === 0) {
      mEl.peers.textContent = "none";
    } else {
      const lines: string[] = [];
      for (const id of peers.keys()) {
        const pm = M.peer(id);
        const stale = pm.lastFaceAt ? now - pm.lastFaceAt : NaN;
        lines.push(
          `#${id} gap ${n0(pm.faceGap.p50)}/${n0(pm.faceGap.p95)}` +
            `  stale ${n0(stale)}` +
            `  ${pm.faceRate.perSecond(now).toFixed(1)}fps` +
            `  dec ${n0(pm.decode.p50)}`
        );
      }
      mEl.peers.textContent = lines.join("\n");
    }
  }
}

// ----------------------------------------------------------------- bootstrap

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  errEl.textContent = "";
  try {
    statusEl.textContent = "Starting camera…";
    await openCamera(video);
    camPreview.srcObject = video.srcObject;
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
  if (e.code === "KeyM") {
    const snap = {
      ...M.snapshot(performance.now()),
      room: new URLSearchParams(location.search).get("room") ?? "lobby",
      userAgent: navigator.userAgent,
      relay: import.meta.env.VITE_RELAY_URL ?? "(dev proxy)",
      videoSize: [video.videoWidth, video.videoHeight],
      peerCount: peers.size,
    };
    const json = JSON.stringify(snap, null, 2);
    console.log("[metrics]", snap);
    navigator.clipboard?.writeText(json).then(
      () => console.log("[metrics] copied to clipboard"),
      () => console.log("[metrics] clipboard blocked — copy from the object above")
    );
  }
});

tick();
