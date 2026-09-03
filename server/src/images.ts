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
    // Start of scan, or end of image: no more headers follow.
    if (marker === 0xda || marker === 0xd9) return null;

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
 * Header-only by necessity: there is no image library here and none can be
 * added, since the homeserver deploy never runs `npm install`. Reading the
 * handful of bytes that carry the dimensions is enough to refuse a
 * decompression bomb before it is ever written to disk.
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

/** True when a JPEG carries an APP1 `Exif\0\0` block. */
function jpegCarriesMetadata(bytes: Buffer): boolean {
  const EXIF_SIGNATURE = "Exif\0\0";
  return (
    walkJpegSegments(bytes, (marker, segmentAt, length) => {
      if (marker !== 0xe1) return undefined;
      // Payload starts after the marker and its two length bytes; the length
      // counts itself, so the payload is `length - 2` bytes long.
      const payloadAt = segmentAt + 4;
      if (length - 2 < EXIF_SIGNATURE.length) return undefined;
      if (payloadAt + EXIF_SIGNATURE.length > bytes.length) return undefined;
      return bytes.subarray(payloadAt, payloadAt + EXIF_SIGNATURE.length).toString("latin1") ===
        EXIF_SIGNATURE
        ? true
        : undefined;
    }) === true
  );
}

/**
 * Chunk types that carry photographer-identifying data in a PNG.
 *
 * `eXIf` is a verbatim Exif block — GPS, camera serial, original timestamp.
 * `tEXt`/`zTXt`/`iTXt` are the generic text chunks, which is where exporters
 * park "Software", "Author", "Comment" and, from a phone, frequently the whole
 * Exif set transcoded into key/value pairs. All four are refused rather than
 * inspected: reading *which* keys a text chunk holds would mean parsing
 * attacker-supplied (and, for `zTXt`/`iTXt`, zlib-compressed) content to decide
 * whether to keep it, and nothing the client produces has any of these chunks
 * at all — a `<canvas>` PNG export carries IHDR, IDAT and IEND.
 */
const PNG_METADATA_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt"]);

/**
 * Walks a PNG's chunk chain. Each chunk is a 4-byte big-endian length, a 4-byte
 * type, that many bytes of payload, then a 4-byte CRC — self-describing the
 * same way JPEG segments are, so this reads only headers.
 *
 * The length is `uint32`, so a crafted file can declare a chunk longer than the
 * buffer or long enough to overflow the cursor; both end the walk rather than
 * being trusted. A chain that can't be walked is treated as carrying metadata,
 * on the same rule as `dimensionsOf`: bytes that can't be checked can't be
 * cleared.
 */
function pngCarriesMetadata(bytes: Buffer): boolean {
  // 8-byte signature, then the first chunk.
  let i = 8;
  while (i + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(i);
    const type = bytes.subarray(i + 4, i + 8).toString("latin1");
    if (PNG_METADATA_CHUNKS.has(type)) return true;
    // IEND is the only clean way out of this loop. IDAT is *not* a stopping
    // point: an `eXIf` chunk placed after the image data is legal, and a walk
    // that stopped at the pixels would miss exactly the file worth catching.
    // Each IDAT is skipped by its declared length like any other chunk.
    if (type === "IEND") return false;
    // 12 = the length field, the type, and the trailing CRC. A chunk claiming
    // to run past the buffer is a chain that doesn't describe itself, and so is
    // one that never reaches IEND — both are refused, on the same rule as an
    // unreadable dimension header: bytes that can't be checked can't be
    // cleared.
    const next = i + 12 + length;
    if (next > bytes.length) return true;
    i = next;
  }
  return true;
}

/**
 * Chunk fourccs that carry metadata in a WebP: a verbatim Exif block, and XMP,
 * which holds the same GPS and camera fields in RDF/XML.
 */
const WEBP_METADATA_CHUNKS = new Set(["EXIF", "XMP "]);

/**
 * Walks a RIFF chunk chain. Structure: "RIFF", a 4-byte little-endian file
 * size, "WEBP", then chunks of a 4-byte fourcc, a 4-byte little-endian payload
 * size, the payload, and a pad byte when that size is odd.
 *
 * Only VP8X-flagged files can carry EXIF/XMP at all, but the flag is not
 * consulted — a file that lies about its flags and appends the chunk anyway is
 * exactly the file this is looking for. Same failure rule as the PNG walk: an
 * unwalkable chain counts as carrying metadata.
 */
function webpCarriesMetadata(bytes: Buffer): boolean {
  let i = 12;
  while (i + 8 <= bytes.length) {
    const fourcc = bytes.subarray(i, i + 4).toString("latin1");
    if (WEBP_METADATA_CHUNKS.has(fourcc)) return true;

    const size = bytes.readUInt32LE(i + 4);
    const payloadEnd = i + 8 + size;
    if (payloadEnd > bytes.length) return true;

    // RIFF pads an odd-sized payload to an even boundary, but not every encoder
    // writes that byte on the *final* chunk — so landing on (or one past) the
    // end here is the chain finishing cleanly, not a truncation. The client's
    // single-chunk `VP8 ` output from `<canvas>` exits exactly here.
    const next = payloadEnd + (size % 2);
    if (next >= bytes.length) return false;
    i = next;
  }
  return true;
}

/**
 * True when an upload carries embedded metadata of its own.
 *
 * Both upload paths in the client re-encode through a `<canvas>`, which emits
 * the bare minimum for each format and no metadata at all — so bytes that still
 * carry an Exif or XMP block did not come from the client, and storing them
 * verbatim would re-serve the uploader's GPS coordinates, camera serial and
 * original timestamps to every member who can see the photo. Refusing them
 * forces every upload through the re-encode the client already does. Stripping
 * the block instead would need a decoder, and therefore a dependency this
 * deploy cannot install.
 *
 * This was JPEG-only on the reasoning that JPEG is what phone cameras produce.
 * That was the wrong boundary: what the *client* sends is not what the API
 * accepts, and `/api/posts` and `/api/auth/avatar` both take a declared
 * `image/png` or `image/webp` whose magic bytes agree. A camera roll photo
 * converted to PNG by any ordinary tool keeps its Exif in an `eXIf` chunk, and
 * every check in front of this one waves it straight through.
 */
export function carriesExifMetadata(bytes: Buffer, format: ImageFormat): boolean {
  if (format === "png") return pngCarriesMetadata(bytes);
  if (format === "webp") return webpCarriesMetadata(bytes);
  return jpegCarriesMetadata(bytes);
}
