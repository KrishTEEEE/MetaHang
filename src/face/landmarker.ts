import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

export type Landmark = { x: number; y: number; z: number };

/**
 * Triangle index list for the face mesh.
 *
 * The package only ships FACE_LANDMARKS_TESSELATION, which is an *edge* list
 * intended for drawing wireframes. It is however generated from the underlying
 * triangle list and preserves that order: every consecutive run of three edges
 * forms one closed triangle (verified — 2556 edges, 852 triangles, no
 * exceptions). So the triangles fall straight out of it.
 */
export function buildFaceTriangles(): Uint16Array {
  const edges = FaceLandmarker.FACE_LANDMARKS_TESSELATION;
  const tris = new Uint16Array(edges.length);
  for (let i = 0; i < edges.length; i += 3) {
    tris[i] = edges[i].start;
    tris[i + 1] = edges[i + 1].start;
    tris[i + 2] = edges[i + 2].start;
  }
  return tris;
}

export async function createLandmarker(): Promise<FaceLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks("/wasm");
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: "/models/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    // Head pose is not derived from the face — the avatar's head follows the
    // body — so the transformation matrices and blendshapes stay off.
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  });
}

export async function openCamera(video: HTMLVideoElement): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  // Dimensions are not populated until metadata lands.
  if (!video.videoWidth) {
    await new Promise<void>((res) => {
      video.onloadedmetadata = () => res();
    });
  }
}
