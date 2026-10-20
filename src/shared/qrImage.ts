import { invoke } from "@tauri-apps/api/core";

/// Larger pictures are scaled down first: a two-factor QR code stays several
/// pixels a module, and the pixels cross IPC raw.
const MAX_SIDE = 1600;

/// The text of the QR code in a picture or a camera frame, or `null` when
/// there is none. The webview draws it, so any format it shows works; Rust
/// finds and reads the code (`src-tauri/src/qr.rs`).
export async function qrFromSource(source: CanvasImageSource, width: number, height: number): Promise<string | null> {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas");
  // White under a transparent picture, so its clear parts read as paper.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const grey = new Uint8Array(w * h);
  for (let i = 0; i < grey.length; i++) {
    grey[i] = (data[i * 4]! * 299 + data[i * 4 + 1]! * 587 + data[i * 4 + 2]! * 114) / 1000;
  }
  return invoke<string | null>("qr_from_pixels", grey, {
    headers: { "x-width": String(w), "x-height": String(h) },
  });
}

/// The same for a picture file. Throws when it will not open.
export async function qrFromPicture(picture: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(picture);
  try {
    return await qrFromSource(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}
