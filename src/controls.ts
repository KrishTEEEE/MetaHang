import * as THREE from "three";

const SPEED = 3.2; // world units per second
const ROOM_RADIUS = 22;
const TURN_RATE = 10; // how fast the body swings toward its heading

/**
 * Roblox-style third-person camera.
 *
 * The camera orbit and the body's facing are deliberately *decoupled*: hold
 * right mouse to swing the camera anywhere, including around to the front, and
 * the body stays put. That's the only way to ever look at your own face.
 *
 * Movement is expressed in the camera's frame — W is "away from the camera" —
 * and the body then turns to face whichever way it is actually travelling.
 */
/**
 * Ground-projected camera basis for a given orbit yaw.
 *
 * The camera sits at -(sin, cos) * distance and looks back at the body, so its
 * forward is (sin, cos) and its right is forward × up = (-cos, sin). Getting
 * the sign of `right` wrong silently swaps A and D, which is exactly what
 * happened the first time — hence `test/controls.test.ts`.
 */
export function cameraBasis(yaw: number) {
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  return { fwdX: sin, fwdZ: cos, rightX: -cos, rightZ: sin };
}

export class Controls {
  /** Camera orbit, not the body's heading. */
  yaw = 0;
  pitch = 0.14;
  distance = 4.2;
  /** Where the body points. Follows movement, never the camera. */
  bodyYaw = 0;
  readonly position = new THREE.Vector3(0, 0, 6);

  private keys = new Set<string>();
  private orbiting = false;

  constructor(dom: HTMLElement) {
    addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => this.keys.clear());

    // Right-drag orbits; left-drag is left alone so it stays available for
    // clicking things in the world later.
    dom.addEventListener("contextmenu", (e) => e.preventDefault());
    dom.addEventListener("pointerdown", (e) => {
      if (e.button !== 2) return;
      this.orbiting = true;
      dom.setPointerCapture(e.pointerId);
      dom.style.cursor = "none";
      e.preventDefault();
    });
    const stop = (e: PointerEvent) => {
      if (!this.orbiting) return;
      this.orbiting = false;
      if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
      dom.style.cursor = "";
    };
    dom.addEventListener("pointerup", stop);
    dom.addEventListener("pointercancel", stop);
    dom.addEventListener("pointermove", (e) => {
      if (!this.orbiting) return;
      this.yaw -= e.movementX * 0.005;
      this.pitch = THREE.MathUtils.clamp(this.pitch + e.movementY * 0.004, -0.4, 1.1);
    });
    dom.addEventListener("wheel", (e) => {
      this.distance = THREE.MathUtils.clamp(this.distance + e.deltaY * 0.004, 1.6, 9);
      e.preventDefault();
    }, { passive: false });
  }

  update(dt: number, camera: THREE.PerspectiveCamera, focusY: number): void {
    let fx = 0, fz = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) fz += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) fz -= 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) fx -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) fx += 1;

    const { fwdX, fwdZ, rightX, rightZ } = cameraBasis(this.yaw);

    if (fx || fz) {
      const len = Math.hypot(fx, fz);
      fx /= len; fz /= len;
      const dirX = fwdX * fz + rightX * fx;
      const dirZ = fwdZ * fz + rightZ * fx;

      this.position.x += dirX * SPEED * dt;
      this.position.z += dirZ * SPEED * dt;

      const r = Math.hypot(this.position.x, this.position.z);
      if (r > ROOM_RADIUS) {
        this.position.x *= ROOM_RADIUS / r;
        this.position.z *= ROOM_RADIUS / r;
      }

      // The body's local +z is its face, so the heading is atan2(x, z).
      this.turnToward(Math.atan2(dirX, dirZ), dt);
    }

    const horiz = Math.cos(this.pitch) * this.distance;
    camera.position.set(
      this.position.x - fwdX * horiz,
      focusY + Math.sin(this.pitch) * this.distance,
      this.position.z - fwdZ * horiz
    );
    camera.lookAt(this.position.x, focusY, this.position.z);
  }

  private turnToward(target: number, dt: number): void {
    let d = target - this.bodyYaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.bodyYaw += d * Math.min(1, dt * TURN_RATE);
  }
}
