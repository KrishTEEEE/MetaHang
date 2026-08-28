import * as THREE from "three";

export function createScene(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d12);
  scene.fog = new THREE.Fog(0x0b0d12, 18, 46);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);

  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x1a1f2b, 1.1);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(5, 9, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -18;
  key.shadow.camera.right = 18;
  key.shadow.camera.top = 18;
  key.shadow.camera.bottom = -18;
  scene.add(key);
  // Fill from the front so faces aren't lit only from one side.
  const fill = new THREE.DirectionalLight(0xaac4ff, 0.5);
  fill.position.set(-4, 3, -6);
  scene.add(fill);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(24, 64).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x161b26, roughness: 0.95 })
  );
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(48, 48, 0x2a3240, 0x1d2430);
  grid.position.y = 0.01;
  scene.add(grid);

  function resize(): void {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width === w * renderer.getPixelRatio() && canvas.height === h * renderer.getPixelRatio()) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  }
  resize();
  addEventListener("resize", resize);

  /**
   * The face is a *lit* MeshStandardMaterial, so scene brightness directly
   * changes how dark a face looks. Exposed so the tuning panel can scale the
   * lights independently of the texture, which is what separates a dark capture
   * from dark lighting.
   */
  const baseIntensity = { hemi: hemi.intensity, key: key.intensity, fill: fill.intensity };
  function setLightScale(scale: number): void {
    hemi.intensity = baseIntensity.hemi * scale;
    key.intensity = baseIntensity.key * scale;
    fill.intensity = baseIntensity.fill * scale;
  }

  return { renderer, scene, camera, resize, setLightScale };
}
