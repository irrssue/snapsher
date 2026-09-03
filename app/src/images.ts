/**
 * The checks a picked file has to survive before anything decodes it.
 *
 * `accept="image/*"` on a file input is a picker filter, not a guarantee — the
 * user can switch the dialog to "All files", and a drag-and-drop or a share
 * sheet never consults it at all. The server has these limits; the client had
 * none, so the failure landed as a crashed tab rather than a message.
 */

/**
 * Below the server's own 8MB cap on the *encoded* upload, and well below what a
 * phone photo weighs. Checked before `createImageBitmap`, because the file size
 * is the only thing knowable about an image without decoding it — and decoding
 * is the expensive step we are trying not to reach.
 */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/**
 * 40 megapixels: comfortably above every consumer sensor a photo is likely to
 * come from, and far below the point where the bitmap stops fitting in memory.
 * A 20000x20000 PNG is a 3MB file that decodes to ~1.6GB, so the byte cap above
 * can't catch it — only the pixel count can, and only once the dimensions are
 * known. Checked before the canvas is allocated and drawn into, which is the
 * second allocation of the same size and the one that actually takes the tab
 * down.
 */
export const MAX_IMAGE_PIXELS = 40_000_000;

export class ImageRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRejected";
  }
}

/** Type and size, both knowable without decoding. Throws `ImageRejected`. */
export function assertPickableImage(file: File): void {
  // Some pickers hand back an empty `type` for a file they can't classify;
  // that is exactly the case worth refusing, so this is a positive test.
  if (!file.type.startsWith("image/")) {
    throw new ImageRejected("That file isn't a photo. Pick an image instead.");
  }
  if (file.size === 0) {
    throw new ImageRejected("That photo appears to be empty.");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ImageRejected("That photo is too large. Pick one under 15MB.");
  }
}

/** The dimension check, once a decode has made the dimensions knowable. */
export function withinPixelBudget(width: number, height: number): boolean {
  return width > 0 && height > 0 && width * height <= MAX_IMAGE_PIXELS;
}

export const TOO_MANY_PIXELS_MESSAGE =
  "That photo has too many pixels to open. Try a smaller one.";
