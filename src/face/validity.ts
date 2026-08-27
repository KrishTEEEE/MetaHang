import type { Landmark } from "./landmarker";

export type FaceState = "LIVE" | "HELD" | "AFK";

// Landmark indices on the MediaPipe face mesh.
const NOSE_TIP = 1;
const CHEEK_L = 234;
const CHEEK_R = 454;

const ENTER_HELD_FRAMES = 5; // ~150ms at 30fps
const LEAVE_HELD_FRAMES = 5;
const AFK_AFTER_MS = 30_000;
// A sustained return to LIVE — not a single stray good frame — clears the AFK
// countdown, so blinking back into frame every 29s can't dodge the timer.
const AFK_RESET_FRAMES = 15;

const MIN_FACE_FRACTION = 0.08; // too far from the camera
const MAX_FACE_FRACTION = 0.9; // clipped / too close
const MIN_SYMMETRY = 0.35; // turned too far to texture usefully

/**
 * Is this detection good enough to texture a head with?
 *
 * `landmarks.length > 0` is not enough: on a profile view MediaPipe returns a
 * confident but badly wrong face rather than returning nothing. So we also
 * check apparent size and left/right symmetry. Symmetry doubles as a cheap yaw
 * proxy — no pose matrix required.
 */
export function isUsableFace(lms: Landmark[] | undefined, aspect: number): boolean {
  if (!lms || lms.length < 468) return false;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of lms) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const w = maxX - minX;
  const h = (maxY - minY) / aspect; // normalise y back into x's units
  const size = Math.max(w, h);
  if (!Number.isFinite(size)) return false;
  if (size < MIN_FACE_FRACTION || size > MAX_FACE_FRACTION) return false;

  const nose = lms[NOSE_TIP], l = lms[CHEEK_L], r = lms[CHEEK_R];
  if (!nose || !l || !r) return false;
  const dL = Math.abs(nose.x - l.x);
  const dR = Math.abs(r.x - nose.x);
  const symmetry = Math.min(dL, dR) / Math.max(dL, dR, 1e-6);
  return symmetry >= MIN_SYMMETRY;
}

/**
 * LIVE → HELD → AFK, with hysteresis on every edge.
 *
 * Without the frame counters the head strobes between live and frozen whenever
 * the user sits right at the quality threshold.
 */
export class FaceStateMachine {
  state: FaceState = "HELD";
  private badRun = 0;
  private goodRun = 0;
  private heldSince = 0;

  /** @returns true when the caller should refresh the texture and UVs. */
  update(usable: boolean, now: number): boolean {
    if (usable) {
      this.goodRun++;
      this.badRun = 0;
    } else {
      this.badRun++;
      this.goodRun = 0;
    }

    if (this.state === "LIVE") {
      if (this.badRun >= ENTER_HELD_FRAMES) {
        this.state = "HELD";
        this.heldSince = now;
      }
    } else {
      if (this.goodRun >= LEAVE_HELD_FRAMES) {
        this.state = "LIVE";
      } else if (this.state === "HELD" && now - this.heldSince >= AFK_AFTER_MS) {
        this.state = "AFK";
      }
    }

    // Coming back from AFK needs a sustained presence before the clock resets.
    if (this.state === "LIVE" && this.goodRun >= AFK_RESET_FRAMES) {
      this.heldSince = 0;
    }

    return this.state === "LIVE" && usable;
  }

  /** Seconds held, for the HUD. */
  heldSeconds(now: number): number {
    return this.state === "LIVE" || !this.heldSince ? 0 : (now - this.heldSince) / 1000;
  }
}
