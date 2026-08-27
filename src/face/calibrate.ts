import type { Landmark } from "./landmarker";

export const VERTEX_COUNT = 468; // tesselated face, excluding the 10 iris points
export const HEAD_HEIGHT = 0.46; // world units, roughly a human head

/**
 * Builds the head's rest geometry by averaging the user's own landmarks over a
 * short neutral pose.
 *
 * Using the user's face instead of MediaPipe's canonical model means no
 * external asset to ship, and the head is actually shaped like their head.
 */
export class Calibrator {
  private sum = new Float32Array(VERTEX_COUNT * 3);
  private frames = 0;

  constructor(private readonly targetFrames = 30) {}

  get progress(): number {
    return Math.min(1, this.frames / this.targetFrames);
  }
  get done(): boolean {
    return this.frames >= this.targetFrames;
  }

  reset(): void {
    this.sum.fill(0);
    this.frames = 0;
  }

  /** Accumulate one frame. Caller must have already gated on face quality. */
  add(lms: Landmark[], videoW: number, videoH: number): void {
    for (let i = 0; i < VERTEX_COUNT; i++) {
      const p = lms[i];
      // MediaPipe normalises x by width and y by height, so y must be scaled
      // back by the video aspect or the head comes out stretched. z is already
      // in roughly the same units as x.
      this.sum[i * 3] += p.x * videoW;
      this.sum[i * 3 + 1] += p.y * videoH;
      this.sum[i * 3 + 2] += p.z * videoW;
    }
    this.frames++;
  }

  /**
   * Centre, scale and convert into three.js space.
   *
   * The camera image is *not* mirrored, so image-x maps straight to world-x: a
   * point on the user's right sits on the left of the image, which is exactly
   * where a viewer facing them expects to see it. Image y grows downward and
   * MediaPipe z grows away from the camera, so both are negated.
   */
  finish(): Float32Array {
    const n = this.frames || 1;
    const avg = new Float32Array(VERTEX_COUNT * 3);
    for (let i = 0; i < avg.length; i++) avg[i] = this.sum[i] / n;

    let cx = 0, cy = 0, cz = 0;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < VERTEX_COUNT; i++) {
      cx += avg[i * 3];
      cy += avg[i * 3 + 1];
      cz += avg[i * 3 + 2];
      const y = avg[i * 3 + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    cx /= VERTEX_COUNT;
    cy /= VERTEX_COUNT;
    cz /= VERTEX_COUNT;

    const scale = HEAD_HEIGHT / Math.max(maxY - minY, 1e-6);
    const out = new Float32Array(VERTEX_COUNT * 3);
    for (let i = 0; i < VERTEX_COUNT; i++) {
      out[i * 3] = (avg[i * 3] - cx) * scale;
      out[i * 3 + 1] = -(avg[i * 3 + 1] - cy) * scale;
      out[i * 3 + 2] = -(avg[i * 3 + 2] - cz) * scale;
    }
    return out;
  }
}
