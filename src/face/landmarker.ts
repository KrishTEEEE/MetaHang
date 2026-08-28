import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { BASE } from "../basePath";

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
  const fileset = await FilesetResolver.forVisionTasks(`${BASE}wasm`);
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: `${BASE}models/face_landmarker.task`,
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

/**
 * Turns a getUserMedia failure into something a person can act on.
 *
 * The raw message ("Could not start video source") names a symptom, not a
 * cause, and leaves the user with nothing to try.
 */
export function describeCameraError(e: unknown): string {
  const name = (e as { name?: string })?.name ?? "";
  const raw = e instanceof Error ? e.message : String(e);
  switch (name) {
    case "NotReadableError":
    case "TrackStartError":
      return (
        "Another program already has the camera.\n\n" +
        "Close Zoom, Teams, FaceTime, OBS or any other tab with this page open, " +
        "then press Retry. On Windows, check no background app is holding it."
      );
    case "NotAllowedError":
    case "PermissionDeniedError":
      return (
        "Camera permission was blocked.\n\n" +
        "Click the camera icon in the address bar, allow access, then press Retry. " +
        "On macOS also check System Settings > Privacy & Security > Camera."
      );
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera was found. Connect one and press Retry.";
    case "OverconstrainedError":
      return `This camera cannot provide a usable video format (${raw}).`;
    case "SecurityError":
      return "The camera needs a secure page. Use the https:// address, not http://.";
    default:
      return raw || "The camera could not be started.";
  }
}

/**
 * Opens the webcam, relaxing the request if the preferred format is refused.
 *
 * Asking for 1280x720 up front and giving up on failure is fragile: plenty of
 * cameras, virtual devices and locked-down machines will refuse a specific size
 * but happily hand over whatever they do support. Each rung is tried in turn and
 * only a failure of the last one is reported.
 */
export async function openCamera(video: HTMLVideoElement): Promise<void> {
  const ladder: MediaStreamConstraints[] = [
    { video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }, audio: false },
    { video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
    { video: true, audio: false },
  ];

  let lastError: unknown;
  for (const constraints of ladder) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();
      // Dimensions are not populated until metadata lands.
      if (!video.videoWidth) {
        await new Promise<void>((res) => {
          video.onloadedmetadata = () => res();
        });
      }
      return;
    } catch (e) {
      lastError = e;
      // A camera held by another process fails every rung, so stop early
      // rather than prompting three times for the same reason.
      const name = (e as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "NotReadableError" || name === "NotFoundError") break;
    }
  }
  throw lastError;
}
