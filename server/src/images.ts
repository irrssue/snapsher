export const PHOTO_DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

export type ImageFormat = "jpeg" | "png" | "webp";

export const EXTENSION_BY_FORMAT: Record<ImageFormat, string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
};

export const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Reads the format out of the bytes themselves. The declared `data:image/...`
 * prefix is attacker-controlled, so trusting it would let anything at all —
 * an HTML file, a script — be stored under an image extension and later served
 * back from our own origin.
 */
export function sniffFormat(bytes: Buffer): ImageFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

/**
 * Upper bound on the pixel count an upload may *declare*.
 *
 * Nothing here decodes an image, so the byte cap on an upload says nothing
 * about what it costs to display: a ~1 MB PNG can legally declare 40,000 x
 * 40,000 pixels and expand to gigabytes of RGBA inside whichever decoder opens
 * it. Because a stored photo is re-served to every member who opens the
 * author's grid, one such upload is a stored denial of service against every
 * viewer, and the only person who can retract it is the uploader.
 *
 * 12 megapixels is roughly six times what the app itself can produce (the
 * client re-encodes every upload at 1440px on its longest edge, ~2 MP) and
 * still comfortably above a full-resolution phone camera frame, so this only
 * ever binds on bytes that were hand-crafted to be large. It was 40 MP, which
 * is ~160 MB of RGBA in the decoder of every viewer who opens the grid — a
 * budget that admitted a stored denial of service rather than refusing one.
 */
const MAX_PIXELS = 12_000_000;

export type ImageDimensions = { width: number; height: number };

/**
 * SOFn segments carry a JPEG's dimensions. Three markers share the 0xc0-0xcf
 * range without being frame headers: DHT (0xc4), JPG (0xc8) and DAC (0xcc).
 */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Walks a JPEG's segment chain from just past the SOI marker, handing each
 * segment's marker and the offset of its length field to `visit`. Segments are
 * self-describing — a two-byte marker then a two-byte length that counts
 * itself — so this only ever reads headers, never image data, and stops at the
 * scan (0xda) where the pixels begin.
 *
 * `visit` returning a value ends the walk with that value. A malformed chain
 * ends it with `null`, which every caller treats as a rejection.
 */
function walkJpegSegments<T>(
  bytes: Buffer,
  visit: (marker: number, segmentAt: number, length: number) => T | undefined,
): T | null {
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null;

    // 0xff also serves as padding between segments; skip any run of it.
    let marker = bytes[i + 1];
    while (marker === 0xff && i + 2 < bytes.length) {
      i += 1;
      marker = bytes[i + 1];
    }
    if (i + 3 >= bytes.length) return null;

    // Standalone markers carry no length field at all.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // Start of scan, or end of image: no more headers follow. Visited anyway,
    // with a zero length, so a caller that needs to know *where* the header
    // chain ended cleanly can say so — every other visitor ignores the marker
    // and still gets the `null` that ending here has always produced.
    if (marker === 0xda || marker === 0xd9) {
      const end = visit(marker, i, 0);
      return end === undefined ? null : end;
    }

    const length = bytes.readUInt16BE(i + 2);
    // A length below 2 doesn't even cover its own field, and would walk this
    // loop backwards forever.
    if (length < 2) return null;

    const found = visit(marker, i, length);
    if (found !== undefined) return found;

    i += 2 + length;
  }
  return null;
}

function jpegDimensions(bytes: Buffer): ImageDimensions | null {
  return walkJpegSegments(bytes, (marker, segmentAt) => {
    if (!isStartOfFrame(marker)) return undefined;
    // Inside a SOFn: two length bytes, one precision byte, then height, then
    // width — each two bytes, big endian.
    if (segmentAt + 9 >= bytes.length) return null;
    return {
      height: bytes.readUInt16BE(segmentAt + 5),
      width: bytes.readUInt16BE(segmentAt + 7),
    };
  });
}

function pngDimensions(bytes: Buffer): ImageDimensions | null {
  // The spec requires IHDR to be the first chunk, so the dimensions sit at
  // fixed offsets: 8-byte signature, 4-byte chunk length, 4-byte chunk type.
  if (bytes.length < 24) return null;
  if (bytes.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function webpDimensions(bytes: Buffer): ImageDimensions | null {
  // WebP has three encodings inside one RIFF container, and each stores its
  // size differently. The fourcc of the first chunk says which one this is.
  if (bytes.length < 30) return null;
  const chunk = bytes.subarray(12, 16).toString("latin1");

  if (chunk === "VP8X") {
    // Extended: 24-bit canvas width-1 and height-1, little endian.
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  if (chunk === "VP8 ") {
    // Lossy: a 3-byte frame tag, the 3-byte start code, then 14-bit width and
    // height. Without the start code this isn't a VP8 keyframe.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    // Lossless: a signature byte, then 14 bits of width-1 and 14 of height-1
    // packed least-significant-bit first into the following four bytes.
    if (bytes[20] !== 0x2f) return null;
    const packed = bytes.readUInt32LE(21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * Reads the width and height an image declares in its own header bytes.
 *
 * Header-only on purpose: reading the handful of bytes that carry the
 * dimensions is enough to refuse a decompression bomb before it is ever
 * written to disk, and it costs no decoder — so the check itself can't be
 * turned into the very exhaustion it exists to prevent.
 *
 * `null` means the header could not be read, which callers treat as a
 * rejection — a size that can't be read is a size that can't be bounded.
 */
export function dimensionsOf(bytes: Buffer, format: ImageFormat): ImageDimensions | null {
  if (format === "png") return pngDimensions(bytes);
  if (format === "webp") return webpDimensions(bytes);
  return jpegDimensions(bytes);
}

/** Run on every upload after `sniffFormat`; see `MAX_PIXELS` for what it stops. */
export function withinPixelBudget(bytes: Buffer, format: ImageFormat): boolean {
  const size = dimensionsOf(bytes, format);
  if (!size) return false;
  return size.width > 0 && size.height > 0 && size.width * size.height <= MAX_PIXELS;
}

/**
 * JPEG segments that are dropped from every upload before it is stored.
 *
 * APP1 is where both Exif and XMP live — GPS coordinates, camera serial,
 * original capture time, and in XMP's case the author's name. APP13 is
 * Photoshop's resource block, which is where IPTC credit and location fields
 * end up. APP3 through APP12, APP15 and COM are the long tail: maker notes,
 * Ducky/Picture Info, JUMBF, and free-text comments. None of them are needed to
 * decode the image.
 *
 * Three neighbours are deliberately kept, because dropping them changes how the
 * pixels are *read*: APP0 (JFIF density), APP14 (Adobe's colour transform,
 * without which a YCCK/CMYK file decodes with inverted colour) and an APP2 that
 * holds an ICC profile. An APP2 that holds anything else — MPF, the multi-frame
 * index an iPhone writes alongside a portrait shot, which carries its own
 * embedded thumbnails — is dropped like the rest.
 */
const ICC_PROFILE_SIGNATURE = "ICC_PROFILE\0";

function isDroppableJpegSegment(bytes: Buffer, marker: number, segmentAt: number): boolean {
  if (marker === 0xfe) return true; // COM
  if (marker === 0xe0 || marker === 0xee) return false; // APP0 JFIF, APP14 Adobe
  if (marker === 0xe2) {
    // Payload starts after the marker and its two length bytes.
    const payloadAt = segmentAt + 4;
    return (
      bytes.subarray(payloadAt, payloadAt + ICC_PROFILE_SIGNATURE.length).toString("latin1") !==
      ICC_PROFILE_SIGNATURE
    );
  }
  return marker >= 0xe1 && marker <= 0xef; // every other APPn
}

function stripJpegMetadata(bytes: Buffer): Buffer | null {
  // SOI, then whichever header segments survive, then the scan verbatim.
  const kept: Buffer[] = [bytes.subarray(0, 2)];
  let scanAt = -1;
  let malformed = false;

  walkJpegSegments<true>(bytes, (marker, segmentAt, length) => {
    if (marker === 0xda || marker === 0xd9) {
      scanAt = segmentAt;
      return true;
    }
    // The walk trusts a declared length far enough to step over it; copying it
    // out means the bytes have to actually be there.
    const segmentEnd = segmentAt + 2 + length;
    if (segmentEnd > bytes.length) {
      malformed = true;
      return true;
    }
    if (!isDroppableJpegSegment(bytes, marker, segmentAt)) {
      kept.push(bytes.subarray(segmentAt, segmentEnd));
    }
    return undefined;
  });

  // Never reaching a scan means the chain didn't describe itself, and a chain
  // that can't be walked is one whose metadata can't be accounted for.
  if (malformed || scanAt < 0) return null;
  kept.push(bytes.subarray(scanAt));
  return Buffer.concat(kept);
}

/**
 * Chunk types dropped from every PNG upload.
 *
 * `eXIf` is a verbatim Exif block — GPS, camera serial, original timestamp.
 * `tEXt`/`zTXt`/`iTXt` are the generic text chunks, which is where exporters
 * park "Software", "Author", "Comment" and, from a phone, frequently the whole
 * Exif set transcoded into key/value pairs. `tIME` is the last-modification
 * time. All five are dropped wholesale rather than inspected: reading *which*
 * keys a text chunk holds would mean parsing attacker-supplied (and, for
 * `zTXt`/`iTXt`, zlib-compressed) content to decide whether to keep it.
 *
 * `iCCP` is not on the list — like a JPEG's ICC APP2, it describes how to read
 * the colour rather than who took the photo.
 */
const PNG_METADATA_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

/**
 * Walks a PNG's chunk chain, copying through everything that isn't metadata.
 * Each chunk is a 4-byte big-endian length, a 4-byte type, that many bytes of
 * payload, then a 4-byte CRC — self-describing the same way JPEG segments are,
 * so this reads only headers and never touches compressed pixel data. Dropping
 * a whole chunk needs no CRC recomputation; every surviving chunk keeps the one
 * it arrived with.
 *
 * The length is `uint32`, so a crafted file can declare a chunk longer than the
 * buffer; that ends the walk as `null` rather than being trusted, on the same
 * rule as `dimensionsOf` — bytes that can't be read can't be cleared.
 */
function stripPngMetadata(bytes: Buffer): Buffer | null {
  const kept: Buffer[] = [bytes.subarray(0, 8)]; // signature
  // 8-byte signature, then the first chunk.
  let i = 8;
  while (i + 8 <= bytes.length) {
    const type = bytes.subarray(i + 4, i + 8).toString("latin1");
    // 12 = the length field, the type, and the trailing CRC.
    const next = i + 12 + bytes.readUInt32BE(i);
    if (next > bytes.length) return null;

    if (!PNG_METADATA_CHUNKS.has(type)) kept.push(bytes.subarray(i, next));
    // IEND is the only clean way out of this loop. IDAT is *not* a stopping
    // point: an `eXIf` chunk placed after the image data is legal, and a walk
    // that stopped at the pixels would miss exactly the file worth catching.
    if (type === "IEND") return Buffer.concat(kept);
    i = next;
  }
  return null;
}

/**
 * Chunk fourccs dropped from every WebP upload: a verbatim Exif block, and XMP,
 * which holds the same GPS and camera fields in RDF/XML.
 */
const WEBP_METADATA_CHUNKS = new Set(["EXIF", "XMP "]);

/** VP8X's flag bits for "an Exif chunk follows" and "an XMP chunk follows". */
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

/**
 * Walks a RIFF chunk chain, copying through everything that isn't metadata.
 * Structure: "RIFF", a 4-byte little-endian file size, "WEBP", then chunks of a
 * 4-byte fourcc, a 4-byte little-endian payload size, the payload, and a pad
 * byte when that size is odd.
 *
 * Only VP8X-flagged files may carry EXIF/XMP at all, but the flag is not
 * consulted on the way in — a file that lies about its flags and appends the
 * chunk anyway is exactly the file worth catching. On the way out the flags do
 * matter: a VP8X still advertising an Exif chunk that no longer exists is a
 * file some decoders reject outright, so the two bits are cleared and the RIFF
 * size rewritten to match what was actually kept.
 */
function stripWebpMetadata(bytes: Buffer): Buffer | null {
  const kept: Buffer[] = [];
  let vp8xIndex = -1;
  let dropped = false;
  let i = 12;

  while (i + 8 <= bytes.length) {
    const fourcc = bytes.subarray(i, i + 4).toString("latin1");
    const size = bytes.readUInt32LE(i + 4);
    const payloadEnd = i + 8 + size;
    if (payloadEnd > bytes.length) return null;
    // RIFF pads an odd-sized payload to an even boundary, but not every encoder
    // writes that byte on the *final* chunk — so landing on (or one past) the
    // end is the chain finishing cleanly, not a truncation.
    const next = payloadEnd + (size % 2);

    if (WEBP_METADATA_CHUNKS.has(fourcc)) {
      dropped = true;
    } else {
      if (fourcc === "VP8X") vp8xIndex = kept.length;
      kept.push(bytes.subarray(i, Math.min(next, bytes.length)));
    }

    if (next >= bytes.length) {
      // Nothing to rewrite when nothing went away — and rebuilding a file we
      // did not change is a chance to get it subtly wrong for no gain.
      if (!dropped) return bytes;
      if (vp8xIndex >= 0) {
        // The flags are the first byte of VP8X's payload: 8 bytes of chunk
        // header, then the flags.
        const vp8x = Buffer.from(kept[vp8xIndex]);
        vp8x[8] &= ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
        kept[vp8xIndex] = vp8x;
      }
      const body = Buffer.concat(kept);
      const header = Buffer.alloc(12);
      header.write("RIFF", 0, "latin1");
      // The RIFF size counts everything after the size field itself: the
      // "WEBP" fourcc plus every chunk.
      header.writeUInt32LE(4 + body.length, 4);
      header.write("WEBP", 8, "latin1");
      return Buffer.concat([header, body]);
    }
    i = next;
  }
  return null;
}

/**
 * Returns the upload with every metadata block removed, or `null` when the
 * file's own structure could not be walked.
 *
 * A photo straight off a phone carries the GPS coordinates it was taken at, the
 * camera's serial number and the original timestamp, and storing those verbatim
 * re-serves them to every member who can see the photo. Stripping is
 * structural: each format describes its own segments, so the blocks can be
 * dropped by walking headers alone — no decoder, and the compressed pixel data
 * is copied through untouched.
 *
 * This used to *refuse* an upload carrying metadata, on the reasoning that both
 * upload paths in the client re-encode through a `<canvas>` and so could only
 * ever produce bare files. That reasoning held for Chrome and Firefox and was
 * wrong everywhere else: on macOS and iOS, `toDataURL` hands the frame to
 * ImageIO, which writes its own `Exif\0\0` APP1 into every JPEG it encodes.
 * Safari could therefore not upload a photo at all — the rule meant to protect
 * the uploader's location rejected the uploader instead.
 */
export function stripMetadata(bytes: Buffer, format: ImageFormat): Buffer | null {
  if (format === "png") return stripPngMetadata(bytes);
  if (format === "webp") return stripWebpMetadata(bytes);
  return stripJpegMetadata(bytes);
}
