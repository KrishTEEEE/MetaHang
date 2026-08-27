import * as THREE from "three";
import { FaceHead } from "./face/faceMesh";
import { buildCranium } from "./face/cranium";
import { HEAD_HEIGHT } from "./face/calibrate";
import { bodyTemplate, breathe } from "./body";

export const EYE_HEIGHT = 1.3;
/**
 * Gap between the chin and the top of the body.
 *
 * The body cannot simply be "tall enough to look right": the jaw is the one
 * part of the face that deforms *downward*, so any shoulder that reaches the
 * resting chin gets a chin driven through it the moment the mouth opens.
 * Sizing the body from the calibrated chin rather than from a constant means
 * this holds for a long face as well as a short one.
 */
const JAW_CLEARANCE = 0.07;
/** How far the body's own colouring is pulled toward the peer's hue. */
const BODY_TINT = 0.55;

/** Lowest point of the calibrated face — the chin. */
function minY(rest: Float32Array): number {
  let y = Infinity;
  for (let i = 1; i < rest.length; i += 3) if (rest[i] < y) y = rest[i];
  return y;
}

/** Midpoint of the head's front-to-back extent, face shell plus cranium. */
function headCentreZ(rest: Float32Array, cranium: THREE.BufferGeometry): number {
  let lo = Infinity, hi = -Infinity;
  const scan = (a: ArrayLike<number>) => {
    for (let i = 2; i < a.length; i += 3) {
      if (a[i] < lo) lo = a[i];
      if (a[i] > hi) hi = a[i];
    }
  };
  scan(rest);
  scan((cranium.getAttribute("position") as THREE.BufferAttribute).array as Float32Array);
  return (lo + hi) / 2;
}

function afkBadge(): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(15,18,26,0.9)";
  g.roundRect(0, 0, 256, 64, 16);
  g.fill();
  g.fillStyle = "#f87171";
  g.font = "600 34px ui-monospace, Menlo, monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("AFK", 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(0.5, 0.125, 1);
  sprite.position.y = EYE_HEIGHT + HEAD_HEIGHT * 0.9;
  sprite.visible = false;
  return sprite;
}

export class Avatar {
  readonly group = new THREE.Group();
  readonly head: FaceHead;
  private badge: THREE.Sprite;
  private craniumMat: THREE.MeshStandardMaterial;
  private bodyMat: THREE.Material | null = null;
  private targetPos = new THREE.Vector3();
  private targetYaw = 0;
  /** Everything that breathes: the body shell and the neck plugged into it. */
  private torso = new THREE.Group();
  private headPivot = new THREE.Group();
  private shoulderY = 0;
  /** So a room full of avatars doesn't breathe in unison. */
  private phase = Math.random();

  constructor(restPositions: Float32Array, color: number) {
    this.head = new FaceHead(restPositions);

    // The face mesh is an open shell, so it needs a back. This dome is grown
    // from the face's own silhouette rather than being a sphere or hemisphere
    // placed behind it — see cranium.ts for why that distinction matters.
    this.craniumMat = new THREE.MeshStandardMaterial({ color: 0x2b3040, roughness: 0.92 });
    const craniumGeom = buildCranium(restPositions);
    const cranium = new THREE.Mesh(craniumGeom, this.craniumMat);
    cranium.castShadow = true;

    // Rest geometry is centred on the *landmark* centroid, which is a point on
    // the face — so the face sits near z=0 and the whole cranium hangs behind
    // it. Dropping that straight onto the body puts the spine level with the
    // cheeks: the head reads as set back, and the chin ends up directly over
    // the shoulders with nowhere to go when the jaw opens. Re-centre on the
    // head's actual front-to-back extent instead, which leaves the face
    // overhanging the chest the way a real one does.
    // The head is parented to the body, so body yaw carries it along — the
    // avatar's head simply points wherever the avatar points.
    this.headPivot.position.set(0, EYE_HEIGHT, -headCentreZ(restPositions, craniumGeom));
    this.headPivot.add(this.head.mesh);
    this.headPivot.add(cranium);
    this.group.add(this.headPivot);

    // Measured, not assumed: a calibration with a long jaw needs a shorter body.
    this.shoulderY = EYE_HEIGHT + minY(restPositions) - JAW_CLEARANCE;

    // Sized so the model's own neck lands exactly on the shoulder line, which
    // is where the chin needs it — the character's proportions are preserved,
    // its overall height is not.
    const t = bodyTemplate();
    let neckRadius = 0.1;
    if (t) {
      const fit = this.shoulderY / t.neckY;
      this.bodyMat = (t.material as THREE.MeshStandardMaterial).clone();
      // Lerped rather than multiplied: the model's texture is a saturated
      // yellow, and multiplying by a hue would collapse half the palette into
      // the same olive. Lerping keeps peers apart while leaving the dark bands
      // dark.
      (this.bodyMat as THREE.MeshStandardMaterial).color.lerp(new THREE.Color(color), BODY_TINT);
      const body = new THREE.Mesh(t.geometry, this.bodyMat);
      body.scale.setScalar(fit);
      body.castShadow = true;
      this.torso.add(body);
      neckRadius = t.neckRadius * fit;
    }

    // Spans the clearance gap and plugs the open cut left by removing the
    // model's head — hence the flare out past the cut's own radius. Left on the
    // body axis, which now sits behind the chin rather than under it, so the
    // neck reads as a neck instead of propping up the jaw.
    //
    // The flared end has to sit *at* the cut, not below it: a cone wide enough
    // at its base is still too narrow by the time it rises to the shoulder
    // line, which leaves a crescent of the body's hollow interior on show.
    const neckH = JAW_CLEARANCE + 0.07;
    const neck = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, neckRadius * 1.08, neckH, 12),
      new THREE.MeshStandardMaterial({ color: 0x1b2130, roughness: 0.9 })
    );
    neck.position.y = this.shoulderY - 0.01 + neckH / 2;
    this.torso.add(neck);
    this.group.add(this.torso);

    this.badge = afkBadge();
    this.group.add(this.badge);
  }

  /**
   * The idle breathe. The body scales about its feet, so the shoulder line
   * drops by `shoulderY·(1−s)` — and the head has to drop with it or it floats
   * off the neck. It does *not* scale with the body: a face that rhythmically
   * changes size reads as a bug, not as breathing.
   */
  animate(seconds: number): void {
    const s = breathe(seconds + this.phase);
    this.torso.scale.setScalar(s);
    this.headPivot.position.y = EYE_HEIGHT - this.shoulderY * (1 - s);
  }

  /** Remote peers arrive at 20Hz; interpolate toward the last known transform. */
  setTarget(x: number, y: number, z: number, yaw: number): void {
    this.targetPos.set(x, y, z);
    this.targetYaw = yaw;
  }

  snapTo(x: number, y: number, z: number, yaw: number): void {
    this.setTarget(x, y, z, yaw);
    this.group.position.copy(this.targetPos);
    this.group.rotation.y = yaw;
  }

  interpolate(alpha: number): void {
    this.group.position.lerp(this.targetPos, alpha);
    let d = this.targetYaw - this.group.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.group.rotation.y += d * alpha;
  }

  setAfk(afk: boolean): void {
    this.head.setAfk(afk);
    this.badge.visible = afk;
  }

  /** Tint the back of the head toward the wearer's own colouring. */
  matchCraniumToFace(): void {
    const tone = this.head.sampleSkinTone();
    if (tone !== null) this.craniumMat.color.setHex(tone);
  }

  dispose(): void {
    this.head.dispose();
    // The template's geometry and material are shared by every avatar; only the
    // per-avatar tinted clone is ours to release.
    this.bodyMat?.dispose();
    this.group.removeFromParent();
  }
}
