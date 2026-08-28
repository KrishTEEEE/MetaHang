/**
 * JPEG encoding, off the main thread.
 *
 * Measured: canvas.toBlob on the main thread ran 6.6ms at p50 but 160ms at p95
 * and 672ms at worst, because it competes with MediaPipe inference for the same
 * thread. 30% of intended sends were skipped waiting on it. Encoding here means
 * detection and encoding stop fighting.
 */

type Req = { id: number; bitmap: ImageBitmap; size: number; quality: number };

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, bitmap, size, quality } = e.data;
  try {
    if (!canvas || canvas.width !== size) {
      canvas = new OffscreenCanvas(size, size);
      ctx = canvas.getContext("2d");
    }
    // The bitmap already arrives at `size`; drawing 1:1 avoids a second rescale.
    ctx!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    const buf = await blob.arrayBuffer();
    (self as unknown as Worker).postMessage({ id, buf }, [buf]);
  } catch (err) {
    bitmap.close();
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
