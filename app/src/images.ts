/**
 * The checks a picked file has to survive before anything decodes it.
 *
 * `accept="image/*"` on a file input is a picker filter, not a guarantee — the
 * user can switch the dialog to "All files", and a drag-and-drop or a share
 * sheet never consults it at all. The server has these limits; the client had
 * none, so the failure landed as a crashed tab rather than a message.
 */

/**
 * The cap on the *picked* file, which is a different quantity from the server's
 * 8MB cap on what finally arrives: everything here is re-encoded down to 1440px
 * before it is sent, so a large original never travels. Checked before
 * `createImageBitmap`, because the file size is the only thing knowable about
 * an image without decoding it — and decoding is the expensive step we are
 * trying not to reach.
 *
 * 40MB rather than the 15MB it was, for the same reason as the pixel cap below:
 * a high-quality 48MP export or a long panorama clears 15MB routinely, and the
 * limit is here to turn away a mistakenly picked video, not a large photo.
 */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

/**
 * 80 megapixels, and far below the point where the bitmap stops fitting in
 * memory. A 20000x20000 PNG is a 3MB file that decodes to ~1.6GB, so the byte
 * cap above can't catch it — only the pixel count can, and only once the
 * dimensions are known. Checked before the canvas is allocated and drawn into,
 * which is the second allocation of the same size and the one that actually
 * takes the tab down.
 *
 * This was 40MP on the belief that no consumer sensor reaches it. Two do: a
 * recent iPhone's 48MP HEIF mode, and its panorama, which stitches past 60MP —
 * so the cap that was meant to catch a crafted file was instead refusing the
 * photos this app exists to share.
 */
export const MAX_IMAGE_PIXELS = 80_000_000;

export class ImageRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRejected";
  }
}

/** Type and size, both knowable without decoding. Throws `ImageRejected`. */
export function assertPickableImage(file: File): void {
  // Only a type the picker was sure about, and sure was *not* an image, is
  // refused here. This used to be a positive test — anything not declaring
  // `image/` was rejected — which turned every picker that can't classify a
  // file into a wall: a `.heic` off a camera roll, a drag-and-drop from an
  // app that sets no type, an `.avif` on a browser that doesn't know the
  // extension all arrive with `type` empty. Whether those bytes are really a
  // photo is a question only the decoder can answer, so the empty case is left
  // for it to answer; a picked video still fails fast right here.
  if (file.type !== "" && !file.type.startsWith("image/")) {
    throw new ImageRejected("That file isn't a photo. Pick an image instead.");
  }
  if (file.size === 0) {
    throw new ImageRejected("That photo appears to be empty.");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ImageRejected("That photo is too large. Pick one under 40MB.");
  }
}

/** The dimension check, once a decode has made the dimensions knowable. */
export function withinPixelBudget(width: number, height: number): boolean {
  return width > 0 && height > 0 && width * height <= MAX_IMAGE_PIXELS;
}

export const TOO_MANY_PIXELS_MESSAGE =
  "That photo has too many pixels to open. Try a smaller one.";

/**
 * What every file input in the app accepts.
 *
 * `image/*` alone is not enough. It expands to whatever image types the OS has
 * registered, and on Windows and older Androids that list has no entry for
 * HEIC — so an iPhone photo copied to a laptop is greyed out in the picker with
 * no explanation. Naming the extensions outright puts them back in the list.
 */
export const PICKER_ACCEPT = "image/*,.heic,.heif,.hif,.avif,.jfif";

/** Extensions a browser is likely to hand over and then refuse to decode. */
const HEIF_FILE = /\.(heic|heif|hif)$/i;

/**
 * The message for a file that survived every check above and still would not
 * decode.
 *
 * Worth distinguishing HEIF by name: it is the iPhone camera's default format,
 * Safari opens it and Chrome and Firefox do not, and "couldn't read that photo"
 * on a photo the same phone displays fine reads as the app being broken. The
 * two ways out are both the user's to take, so both are named.
 */
export function undecodableMessage(file: File): string {
  if (HEIF_FILE.test(file.name) || /^image\/(heic|heif)/i.test(file.type)) {
    return "This browser can't open HEIC photos. Try Safari, or set iPhone Settings \u2192 Camera \u2192 Formats to Most Compatible.";
  }
  return "Couldn't read that photo. Try a different one.";
}
