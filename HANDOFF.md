# FaceHangout — context handoff

State as of 2026-07-26. Read this plus `README.md` (which carries the design
rationale) before changing anything.

---

## What it is

A multiplayer 3D hangout space. Your webcam face is mapped onto a 3D head shaped
from your own facial geometry. Built from scratch in one session; working
end-to-end, single-player and multiplayer.

```bash
npm install
npm run dev          # vite :5173 + ws relay :8787
```

Open http://localhost:5173, click **Enable camera**, face the camera straight on
until the bar fills. `?room=name` for a specific room; two tabs in one room to
test multiplayer.

Controls: `WASD` move · hold **right-click** to orbit · scroll zoom · `C`
recalibrate.

**Must be a real browser.** Headless/non-compositing panes pause
`requestAnimationFrame` and the scene appears frozen even when everything works.

---

## Stack

Vite 8 + TypeScript 7, three.js 0.185, `@mediapipe/tasks-vision` 0.10.35, `ws`.
Node 22. No framework, no bundled UI library. `git` is **not** initialised.

Model, wasm and the body GLB are served locally from `public/`, not a CDN.

`public/models/body.glb` is a single un-skinned 480-triangle mesh with one
texture and one animation. It is loaded once and shared: every avatar reuses the
same prepared geometry and clones only the material, to tint it.

---

## Layout

```
src/main.ts              orchestrator: rAF loop, calibration, net wiring   (321)
src/face/
  landmarker.ts          MediaPipe init; triangle topology extraction       (54)
  calibrate.ts           30-frame neutral capture -> rest geometry          (81)
  validity.ts            quality gate + LIVE/HELD/AFK state machine        (101)
  faceMesh.ts            FaceHead (geometry/texture) + CropBox             (198)
  cranium.ts             back-of-head dome grown from the face silhouette  (108)
  holes.ts               mouth/eye membranes, textured from the video      (157)
  deform.ts              Procrustes fit; expression-only vertex motion     (183)
src/body.ts              GLB load, head cut, idle breathe                  (152)
src/avatar.ts            body + head + neck assembly, AFK badge           (160)
src/scene.ts             renderer, lights, floor                            (52)
src/controls.ts          Roblox-style orbit + movement                     (122)
src/net/codec.ts         binary wire format                                (107)
src/net/client.ts        websocket client                                   (75)
server/index.ts          relay: rooms, fan-out, late-joiner replay          (93)
public/models/body.glb   the avatar body (23 KB, from Sketchfab)
test/                    7 suites, 128 assertions
```

---

## The one idea that matters

The head is driven by **two separate channels**, and conflating them is how every
bug in this project happened.

1. **UVs** track landmarks — vertex *i* always samples landmark *i*.
2. **Vertex positions** carry expression only. Each frame a rigid transform is
   fitted from live landmarks onto the calibrated rest pose and **removed**. What
   survives is jaw/lip/brow motion; head rotation cancels by construction.

Head *orientation* is deliberately **not** driven by the face. It follows the
body. This was an explicit product decision — see "Decisions" below.

If you only had channel 1, the face is an anatomically rigid mask: your lip
pixels are glued to the lip vertex forever, so opening your mouth renders as a
closed mouth. That symptom looks like a geometry problem and is not one.

---

## Decisions, and why (do not silently revert these)

**Head pose is not tracked from the face.** Originally planned, dropped by the
user. The avatar's head follows body facing. This removed handedness conversion,
mirror-sign ambiguity and a double-rotation artefact. `deform.ts` exists to
*preserve* this while still animating expression.

**Rest geometry is the user's own face**, averaged over ~30 frames, not
MediaPipe's canonical model. No external asset, and the head resembles them.
Calibration uses a stricter gate than runtime because everything downstream
inherits its mistakes.

**HELD is invisible to others; only 30s sustained absence shows as AFK.** User's
call — glancing away should not broadcast that you glanced away.

**Camera orbit and body facing are decoupled** (Roblox-style). Pinning body yaw
to camera yaw makes your own face permanently unreachable.

**Peers reconstruct expression rather than receiving it.** UVs already are the
landmark x/y, so only depth ships (936 B/frame).

**The mouth and eyes are holes in the tesselation, filled with the video
itself.** MediaPipe tracks no teeth, tongue or eyeball, and doesn't need to: the
pixels are already in the face texture, bounded by the inner lip / eyelid UVs.
`holes.ts` fans each hole shut and samples the same texture, so nothing extra
goes over the wire. Mouth cavity depth is invented from the lip gap — aesthetic,
not measured.

---

## Traps that already bit, encoded as tests

Each of these shipped or nearly shipped. The tests exist specifically to stop
them recurring — if one starts failing, read the test comment before "fixing" it.

| Trap | Symptom | Guard |
|---|---|---|
| `Float32Array` view at byte offset 5 | throws the instant calibration completes | `codec.test.ts` |
| Camera basis sign | A and D swapped | `controls.test.ts` projects into view space |
| Skull sphere reaching past the cheeks | face buried; only brow + lips visible | `cranium.test.ts` raycasts all 468 verts |
| Position attribute aliasing rest pose | peers receive a live expression as your "neutral" | `FaceHead.rest` is a separate copy |
| Relay reading `PORT` | dev harness sets it; ws steals Vite's port | uses `WS_PORT` |
| Assuming the tesselation is a closed sheet | open jaw shows the inside of the skull | `holes.test.ts` re-derives all 4 boundary loops |
| Body height as a constant | chin punches into the shoulders on jaw drop | `avatar.ts` sizes the body from the calibrated chin |
| "Narrowest ring above the torso" as the neck | that's the crown; the cut removes nothing | `body.test.ts` asserts the cut is a real waist |
| Rings keyed by rounded height | hard-edge duplicates split; cut lands on the shoulders | `body.ts` sweeps by height with a tolerance |
| Neck cone based *below* the cut | crescent of hollow body visible from above | flared end sits at the cut |

Two tests initially passed while testing nothing, and both were caught only by
checking they could fail:

- The first codec test **duplicated** the encode/decode logic instead of
  importing it. Rewritten against the real module, it immediately threw.
- `cranium.test.ts` re-runs its occlusion check against the **old sphere** and
  requires it to fail (169/468 buried). Keep that guard.

---

## Wire protocol

Client sends `[u8 type][payload]`; server rewrites to `[u8 type][u16 senderId][payload]`
and fans out. The id is assigned by the server, never trusted from the client.
Every decode is therefore at **offset 3**.

| Type | Rate | Size | Contents |
|---|---|---|---|
| `POSE` = 1 | 20Hz | 20 B | x, y, z, yaw (f32), state (u8) |
| `FACE` = 2 | 10Hz, LIVE only | ~7.8 KB | 936 UVs (u16) + 468 depths (i16) + JPEG |
| `IDENTITY` = 3 | on join | 5.6 KB | colour (u32) + 468×3 rest positions (f32) |

~76 KB/s (~610 kbps) up per participant; six-person room ≈ 3 Mbps down.

Server caches each peer's identity, last pose and last face and replays them to
late joiners. Control messages (`welcome`/`join`/`leave`) are JSON text frames.

**Changing the FACE layout is a breaking change** — there is no version
negotiation. Stale tabs misparse silently. Reload all clients.

---

## Verification status

```bash
npm test          # 5 suites, 106 assertions, headless
npm run test:relay  # needs the server running
npm run typecheck
```

Covered: wire codec round-trips; calibration scale and all three coordinate
conventions; validity gate and every state-machine edge including the 30s AFK
boundary; camera basis at 7 angles; cranium non-occlusion; the deformer (rigid
motion removal to 1e-6, rotation recovery to 0.00°, expression surviving
rotation, rim pinning, sender/receiver agreement).

**Not covered, and this is the important gap:** the live webcam path — camera →
landmarks → crop → texture → deform. It needs a real camera pointed at a real
face. Everything feeding it and everything downstream is tested; the seam is
verified by eye only. Any change touching `CropBox`, `Calibrator` or the
landmarker needs a human to look at it.

---

## Open items

- **Unconfirmed:** whether the idle breathe is too much. `AMPLITUDE = 0.1` and
  `PERIOD = 1.0` in `body.ts` are the artist's own values; a 10% squash at 1Hz
  is a lot of breathing once there's a real face above it.
- **Unconfirmed:** `BODY_TINT = 0.55` in `avatar.ts`. The model's texture is a
  saturated yellow, so peers are lerped toward their hue rather than multiplied
  by it — multiplying collapses half the palette into the same olive. Lerping
  still can't make a peer look blue.
- **Unconfirmed:** whether the mouth cavity depth (`MOUTH_DEPTH = 0.7` in
  `holes.ts`) and its darkening (`MOUTH_SHADE`) read right on real video, and
  whether the eye membranes are an improvement or should be reverted to holes.
- **Unconfirmed:** whether `JAW_CLEARANCE = 0.07` in `avatar.ts` is enough
  headroom for a full jaw drop, and whether the forward head shift now overshoots.
- **Unconfirmed:** whether jaw drop reads as too subtle. If so the knob is
  `PIN_FALLOFF` in `deform.ts` (currently `0.12 × HEAD_HEIGHT`), which may be
  clamping the lower lip more than intended. Awaiting user feedback.
- **Unconfirmed:** whether the face is left-right mirrored. The coordinate
  convention is internally consistent and test-pinned against *synthetic*
  landmarks, so only real video settles which convention is right. If it is
  flipped, it is a one-line sign change in `calibrate.ts`.
- Bandwidth: the 2.8 KB of UVs+depths is a fixed 16-bit floor. Delta-encoding is
  the next win before WebRTC, if rooms need to grow.
- No audio. No collision. No persistence. Room list is in-memory only.
- `PCFSoftShadowMap` is deprecated in three 0.185; using `PCFShadowMap`.
- The body model has no arms and is a surface of revolution, so it gives no
  facing cue of its own. The old direction nub is gone — the head is the cue now.

---

## Gotchas for whoever picks this up

- `FACE_LANDMARKS_TESSELATION` is an **edge** list, not triangles — but every
  consecutive run of three edges is one closed triangle (2556 edges → 852
  triangles, verified, no exceptions). Same chaining trick recovers the 36-vertex
  oval loop from `FACE_LANDMARKS_FACE_OVAL`.
- MediaPipe normalises x by width and y by height. Scale y by aspect or the head
  comes out stretched. z is in roughly x's units, so multiply by `videoW`.
- The camera image is **not** mirrored. Image-x maps straight to world-x. Image y
  and MediaPipe z are both negated.
- The cranium's winding is auto-corrected at build time (pole normal must point
  backward) because the oval loop's direction is undocumented.
- The face mesh is an open shell. Anything placed behind it must be grown from
  the silhouette, not positioned near it — that is what `cranium.ts` is for.
- Deformation smoothing (`SMOOTH = 0.5`) is load-bearing; live landmarks are far
  noisier than the calibration average and the mesh shimmers without it.
- Crop-box EMA smoothing, by contrast, is purely cosmetic — UVs are computed
  against the same box used for the crop, so jitter cancels.
