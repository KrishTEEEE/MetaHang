import * as THREE from "three";

/**
 * The face tesselation is not a closed sheet — it has four boundary loops: the
 * face oval, both eye openings, and the mouth. `cranium.ts` deals with the
 * oval; this file deals with the other three.
 *
 * Nothing in `FACE_LANDMARKS_TESSELATION` spans the inner lip contour, so the
 * mouth is a genuine hole in the mesh: opening your jaw reveals the inside of
 * the cranium rather than teeth and tongue. Landmarks alone can never fix that,
 * because MediaPipe does not track anything behind the lips.
 *
 * The fix does not need to. The face texture is live video and the UVs *are*
 * the landmark positions, so the pixels of the real mouth interior — teeth,
 * tongue, shadow — are already sitting in the texture, in the region bounded by
 * the inner lip UVs. Fanning that hole shut and letting it sample the same
 * texture paints them straight back on, at zero extra cost and with no change
 * to the wire format.
 *
 * The apex is then pushed backward in proportion to how far the mouth is open,
 * so the patch reads as a cavity rather than as a decal across the teeth. That
 * depth is invented, not measured — the hybrid the eye actually wants.
 *
 * The eyes get the same treatment with zero depth: an eyeball sits at the
 * surface, and the alternative is looking through the socket at the skull.
 */

/** Inner lip contour, ordered. Exactly the mouth boundary loop of the mesh. */
export const MOUTH_HOLE = [
  14, 87, 178, 88, 95, 78, 191, 80, 81, 82,
  13, 312, 311, 310, 415, 308, 324, 318, 402, 317,
];

/** Eyelid contours, ordered. Exactly the two eye boundary loops of the mesh. */
export const EYE_HOLES = [
  [157, 173, 133, 155, 154, 153, 145, 144, 163, 7, 33, 246, 161, 160, 159, 158],
  [387, 388, 466, 263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386],
];

/** Innermost upper and lower lip, used to measure how far the mouth is open. */
const LIP_UPPER = 13;
const LIP_LOWER = 14;

/** Cavity depth as a fraction of the lip gap. Pure aesthetics; tune freely. */
const MOUTH_DEPTH = 0.7;
/** Ambient-occlusion cheat: the back of the cavity is darker than its rim. */
const MOUTH_SHADE = 0.45;

type Hole = { ring: number[]; base: number; apex: number; depth: number; shade: number; isEye: boolean };

/**
 * Video-textured membranes closing the mouth and eye holes.
 *
 * Parented to the face mesh, so it inherits the head transform and works in the
 * same local space as the deformed vertex positions. Driven from the face's own
 * position and uv attributes, which means a peer's mouth is derived from the
 * same numbers as its owner's and needs nothing extra sent.
 */
export class HoleFans {
  readonly mesh: THREE.Mesh;
  private geom = new THREE.BufferGeometry();
  readonly material: THREE.MeshStandardMaterial;
  private posAttr: THREE.BufferAttribute;
  private uvAttr: THREE.BufferAttribute;
  private holes: Hole[] = [];

  constructor(map: THREE.Texture) {
    const idx: number[] = [];
    const colors: number[] = [];
    let n = 0;
    const add = (ring: number[], depth: number, shade: number, eye = false) => {
      const base = n;
      n += ring.length;
      const apex = n++;
      for (let i = 0; i < ring.length; i++) {
        idx.push(base + i, base + ((i + 1) % ring.length), apex);
        colors.push(1, 1, 1);
      }
      colors.push(shade, shade, shade);
      this.holes.push({ ring, base, apex, depth, shade, isEye: eye });
    };
    add(MOUTH_HOLE, MOUTH_DEPTH, MOUTH_SHADE);
    for (const e of EYE_HOLES) add(e, 0, 1, true);

    this.posAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.uvAttr = new THREE.BufferAttribute(new Float32Array(n * 2), 2);
    this.uvAttr.setUsage(THREE.DynamicDrawUsage);
    this.geom.setAttribute("position", this.posAttr);
    this.geom.setAttribute("uv", this.uvAttr);
    this.geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    this.geom.setIndex(idx);

    this.material = new THREE.MeshStandardMaterial({
      map,
      vertexColors: true,
      roughness: 0.9,
      metalness: 0,
      // Winding is inherited from loops whose direction isn't documented, and a
      // cavity is seen from the outside anyway, so don't gamble on facing.
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geom, this.material);
    this.mesh.visible = false; // nothing meaningful until the first live frame
    this.mesh.renderOrder = 1;
  }

  /**
   * Rebuild from the face's current deformed positions and live UVs.
   *
   * 55 vertices, so this is cheap enough to run every frame alongside the face's
   * own normal recomputation.
   */
  /**
   * Vertical offset applied only to the eye membranes' texture coordinates.
   *
   * Looking at a screen points the eyes downward, so the avatar reads as
   * avoiding you. Sampling the eye region slightly higher moves the visible
   * iris up. It is a cosmetic shift of where the pixels come from, not real
   * gaze redirection — push it far and it will sample eyelid instead.
   */
  eyeLift = 0;

  update(pos: ArrayLike<number>, uv: ArrayLike<number>): void {
    const P = this.posAttr.array as Float32Array;
    const U = this.uvAttr.array as Float32Array;

    const dx = pos[LIP_UPPER * 3] - pos[LIP_LOWER * 3];
    const dy = pos[LIP_UPPER * 3 + 1] - pos[LIP_LOWER * 3 + 1];
    const dz = pos[LIP_UPPER * 3 + 2] - pos[LIP_LOWER * 3 + 2];
    const gap = Math.hypot(dx, dy, dz);

    for (const h of this.holes) {
      let cx = 0, cy = 0, cz = 0, cu = 0, cv = 0;
      for (let i = 0; i < h.ring.length; i++) {
        const v = h.ring[i];
        const o = (h.base + i) * 3;
        P[o] = pos[v * 3]; P[o + 1] = pos[v * 3 + 1]; P[o + 2] = pos[v * 3 + 2];
        cx += P[o]; cy += P[o + 1]; cz += P[o + 2];
        const t = (h.base + i) * 2;
        // v is texture-space, which runs bottom-up, so a positive lift raises
        // the sampled region and the iris appears to look further up.
        U[t] = uv[v * 2];
        U[t + 1] = uv[v * 2 + 1] + (h.isEye ? this.eyeLift : 0);
        cu += U[t]; cv += U[t + 1];
      }
      const k = h.ring.length;
      const a = h.apex * 3;
      P[a] = cx / k;
      P[a + 1] = cy / k;
      // Backward is -z: calibration negates MediaPipe z, so +z faces the viewer.
      P[a + 2] = cz / k - h.depth * gap;
      const b = h.apex * 2;
      U[b] = cu / k;
      U[b + 1] = cv / k;
    }

    this.posAttr.needsUpdate = true;
    this.uvAttr.needsUpdate = true;
    this.geom.computeVertexNormals();
    this.mesh.visible = true;
  }

  setAfk(afk: boolean): void {
    this.material.color.setHex(afk ? 0x6b7280 : 0xffffff);
  }

  dispose(): void {
    this.geom.dispose();
    this.material.dispose();
  }
}
