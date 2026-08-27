import * as THREE from "three";
import { buildFaceTriangles, type Landmark } from "./landmarker";
import { VERTEX_COUNT } from "./calibrate";
import { HoleFans } from "./holes";

export const CROP_SIZE = 256; // texture resolution for the face crop

let TRIANGLES: Uint16Array | null = null;
function triangles(): Uint16Array {
  return (TRIANGLES ??= buildFaceTriangles());
}

/**
 * A 3D head whose geometry is fixed and whose UVs are rewritten every frame.
 *
 * This is the whole trick. Building the mesh from live 3D landmarks would make
 * the geometry rotate with the user's real head — which we explicitly don't
 * want, since the avatar's head follows its body. Instead the geometry stays at
 * its calibrated rest pose and only the texture coordinates move, so the face
 * always reads forward while still being genuinely three-dimensional.
 */
export class FaceHead {
  readonly mesh: THREE.Mesh;
  readonly canvas: HTMLCanvasElement;
  /**
   * The calibrated pose, kept separate from the live position attribute. The
   * attribute is overwritten every frame by the deformer, so aliasing the two
   * would mean `sendIdentity` broadcasting whatever expression happened to be
   * on screen instead of the neutral rest pose.
   */
  readonly rest: Float32Array;
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private uvAttr: THREE.BufferAttribute;
  private posAttr: THREE.BufferAttribute;
  private material: THREE.MeshStandardMaterial;
  /** Mouth and eye openings, closed with video-textured membranes. */
  private fans: HoleFans;

  constructor(restPositions: Float32Array, tint = 0xffffff) {
    this.rest = Float32Array.from(restPositions);
    const geom = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(Float32Array.from(restPositions), 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute("position", this.posAttr);
    this.uvAttr = new THREE.BufferAttribute(new Float32Array(VERTEX_COUNT * 2), 2);
    this.uvAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute("uv", this.uvAttr);
    geom.setIndex(new THREE.BufferAttribute(triangles(), 1));
    geom.computeVertexNormals();

    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = CROP_SIZE;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: false })!;
    this.ctx.fillStyle = "#2a3240";
    this.ctx.fillRect(0, 0, CROP_SIZE, CROP_SIZE);

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    this.material = new THREE.MeshStandardMaterial({
      map: this.texture,
      color: tint,
      roughness: 0.85,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geom, this.material);

    // Parented to the face, so it rides the same transform and reads the same
    // local-space positions the deformer writes.
    this.fans = new HoleFans(this.texture);
    this.mesh.add(this.fans.mesh);
  }

  setUVs(uv: Float32Array): void {
    this.uvAttr.array.set(uv);
    this.uvAttr.needsUpdate = true;
    this.fans.update(this.posAttr.array, this.uvAttr.array);
  }

  /**
   * Live expression geometry. Normals must be recomputed or the shading stays
   * frozen at the rest pose and an open mouth reads as a flat dark patch —
   * cheap here, since it's only 852 triangles.
   */
  setPositions(pos: Float32Array): void {
    (this.posAttr.array as Float32Array).set(pos);
    this.posAttr.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.fans.update(this.posAttr.array, this.uvAttr.array);
  }

  /** Blit a new face crop in. Skipping this call is what "hold last valid" is. */
  drawSource(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number): void {
    this.ctx.drawImage(src, sx, sy, sw, sh, 0, 0, CROP_SIZE, CROP_SIZE);
    this.texture.needsUpdate = true;
  }

  drawWhole(src: CanvasImageSource): void {
    this.ctx.drawImage(src, 0, 0, CROP_SIZE, CROP_SIZE);
    this.texture.needsUpdate = true;
  }

  /**
   * Average colour of the middle of the face crop, used to tint the back of the
   * head so it reads as part of the same person rather than a dark shell.
   * Cheap enough to call about once a second; not per frame.
   */
  sampleSkinTone(): number | null {
    const q = Math.floor(CROP_SIZE / 4);
    let data: Uint8ClampedArray;
    try {
      data = this.ctx.getImageData(q, q, q * 2, q * 2).data;
    } catch {
      return null; // tainted canvas
    }
    let r = 0, g = 0, b = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]; g += data[i + 1]; b += data[i + 2];
    }
    // Darkened a little: the cranium reads as hair/shadow more than lit skin.
    return (
      (Math.round((r / n) * 0.62) << 16) |
      (Math.round((g / n) * 0.62) << 8) |
      Math.round((b / n) * 0.62)
    );
  }

  /** AFK dimming. Held-but-not-AFK is deliberately indistinguishable from live. */
  setAfk(afk: boolean): void {
    this.material.color.setHex(afk ? 0x6b7280 : 0xffffff);
    this.fans.setAfk(afk);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.fans.dispose();
  }
}

/**
 * Face bounding box in pixels, lightly smoothed.
 *
 * Smoothing here is cosmetic rather than load-bearing: UVs are computed against
 * the same box used for the crop, so any jitter cancels out and the face stays
 * locked to the geometry regardless. The EMA just stops the resampling from
 * shimmering.
 */
export class CropBox {
  x = 0; y = 0; w = 0; h = 0;
  private init = false;
  constructor(private readonly alpha = 0.35, private readonly pad = 1.35) {}

  update(lms: Landmark[], videoW: number, videoH: number): void {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < VERTEX_COUNT; i++) {
      const p = lms[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const cx = ((minX + maxX) / 2) * videoW;
    const cy = ((minY + maxY) / 2) * videoH;
    // Square box, so the crop's aspect matches the square texture.
    const size = Math.max((maxX - minX) * videoW, (maxY - minY) * videoH) * this.pad;

    if (!this.init) {
      this.x = cx - size / 2; this.y = cy - size / 2; this.w = this.h = size;
      this.init = true;
      return;
    }
    const a = this.alpha;
    const tx = cx - size / 2, ty = cy - size / 2;
    this.x += (tx - this.x) * a;
    this.y += (ty - this.y) * a;
    this.w += (size - this.w) * a;
    this.h = this.w;
  }

  /**
   * Landmark depth in the same units as the UVs (fractions of the crop width),
   * negated so +z points at the viewer like the rest geometry does.
   *
   * MediaPipe scales z by the video width, hence the videoW factor before
   * dividing through by the crop.
   */
  toZ(lms: Landmark[], videoW: number, out: Float32Array): Float32Array {
    for (let i = 0; i < VERTEX_COUNT; i++) {
      out[i] = (-lms[i].z * videoW) / this.w;
    }
    return out;
  }

  /** Landmark positions expressed as UVs inside this crop. */
  toUVs(lms: Landmark[], videoW: number, videoH: number, out: Float32Array): Float32Array {
    for (let i = 0; i < VERTEX_COUNT; i++) {
      const p = lms[i];
      out[i * 2] = (p.x * videoW - this.x) / this.w;
      // Texture v runs bottom-up, image y runs top-down.
      out[i * 2 + 1] = 1 - (p.y * videoH - this.y) / this.h;
    }
    return out;
  }
}
