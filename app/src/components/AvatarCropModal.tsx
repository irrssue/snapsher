import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, CloseIcon } from "./icons";
import { useBodyScrollLock, useDialogFocus } from "../hooks";
import { TOO_MANY_PIXELS_MESSAGE, withinPixelBudget } from "../images";

/** Largest on-screen size of the square crop viewport. */
const MAX_VIEWPORT = 288;
/** Side length, in pixels, of the square avatar we actually upload. */
const OUTPUT_SIZE = 640;
const JPEG_QUALITY = 0.9;
const MAX_ZOOM_MULTIPLIER = 3;

/**
 * The square has to fit between the backdrop's `px-4` and the dialog's `p-5`,
 * which is 72px of the window's width. A fixed 288 spilled out of the rounded
 * modal on anything narrower than ~360px — 40px of overflow on a 320px phone —
 * and, with nothing clipping the document, scrolled the whole page sideways.
 *
 * Height needs the same treatment. Sizing from width alone put a 288px square
 * inside a `max-h-full` dialog only 327px tall on a 667×375 landscape phone,
 * which pushed the zoom slider and both action buttons ~150px below the fold —
 * and the square is `touch-none`, so dragging inside it pans the photo instead
 * of scrolling down to them. `CHROME_HEIGHT` is everything stacked above and
 * below the square: the backdrop's `py-6` (48) plus, inside the dialog, `p-5`
 * (40), the "Drag to reposition" label (16), three `gap-5` gaps (60), the zoom
 * slider (20) and the 44px button row.
 */
const CHROME_HEIGHT = 48 + 40 + 16 + 60 + 20 + 44;

function measureViewport() {
  return Math.max(
    160,
    Math.min(MAX_VIEWPORT, window.innerWidth - 32 - 40, window.innerHeight - CHROME_HEIGHT),
  );
}

type Frame = { left: number; top: number; scale: number };

function clampFrame(
  frame: Frame,
  naturalWidth: number,
  naturalHeight: number,
  viewport: number,
): Frame {
  const displayWidth = naturalWidth * frame.scale;
  const displayHeight = naturalHeight * frame.scale;
  // The image must always fully cover the viewport: its edges can retreat
  // past the viewport's edges but never leave a gap inside it.
  const minLeft = viewport - displayWidth;
  const minTop = viewport - displayHeight;
  return {
    ...frame,
    left: Math.min(0, Math.max(minLeft, frame.left)),
    top: Math.min(0, Math.max(minTop, frame.top)),
  };
}

type AvatarCropModalProps = {
  imageUrl: string;
  onCancel: () => void;
  onConfirm: (photo: string) => void;
};

/**
 * An Instagram-style "position your photo" step: pan and zoom a picked photo
 * of any aspect ratio inside a fixed square, then export exactly that square.
 * Cropping to a fixed, moderate output size is also what keeps the upload
 * well under the server's size limit regardless of how large the original
 * photo was.
 */
export function AvatarCropModal({ imageUrl, onCancel, onConfirm }: AvatarCropModalProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>();
  const [viewport, setViewport] = useState(measureViewport);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [minScale, setMinScale] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const dragState = useRef<{ pointerId: number; startX: number; startY: number; frame: Frame } | null>(
    null,
  );

  useBodyScrollLock();

  /**
   * Re-measures the square and re-fits the photo inside it — the two always
   * move together. The box is sized from the window rather than fixed, so a
   * rotation changes it, and a frame scaled and clamped for the old box would
   * leave gaps inside a larger one. Re-fitting resets the position, which is
   * the honest answer: the crop it described no longer exists.
   */
  const fitToWindow = useCallback(() => {
    const nextViewport = measureViewport();
    setViewport(nextViewport);

    const img = imgRef.current;
    if (!img?.naturalWidth || !img.naturalHeight) return;
    const { naturalWidth, naturalHeight } = img;
    const cover = Math.max(nextViewport / naturalWidth, nextViewport / naturalHeight);
    setMinScale(cover);
    setFrame(
      clampFrame(
        {
          scale: cover,
          left: (nextViewport - naturalWidth * cover) / 2,
          top: (nextViewport - naturalHeight * cover) / 2,
        },
        naturalWidth,
        naturalHeight,
        nextViewport,
      ),
    );
  }, []);

  const handleImageLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const { naturalWidth, naturalHeight } = img;
    // A decoded image with no dimensions can't be cropped and would divide by
    // zero below, so it is treated as a failed load rather than a usable one.
    if (!naturalWidth || !naturalHeight) {
      setLoadError("Couldn't read that photo. Try a different one.");
      return;
    }
    // Refused here rather than at export time: leaving `frame` and
    // `naturalSize` null keeps Confirm disabled, so `drawImage` — which would
    // allocate a second copy of a bitmap already too big to hold — is never
    // reached. The picker's size check can't catch this one; a 3MB PNG can
    // decode to well over a gigabyte.
    if (!withinPixelBudget(naturalWidth, naturalHeight)) {
      setLoadError(TOO_MANY_PIXELS_MESSAGE);
      return;
    }
    setLoadError(null);
    setNaturalSize({ width: naturalWidth, height: naturalHeight });
    fitToWindow();
  }, [fitToWindow]);

  /**
   * A cached image can finish decoding before React attaches `onLoad`, and that
   * event never fires retroactively — leaving `frame` null, the image hidden
   * and Confirm disabled forever, with nothing on screen explaining why.
   * `complete` is the state that `onLoad` would have announced, so check for it
   * once on mount and run the same handler.
   */
  useEffect(() => {
    if (imgRef.current?.complete) handleImageLoad();
  }, [handleImageLoad]);

  // Deliberately `frame !== null` and not `frame` itself: the guard below only
  // asks whether there is a crop worth preserving, and depending on the object
  // would resubscribe the listener on every pointer move of a drag.
  const hasFrame = frame !== null;

  useEffect(() => {
    // `fitToWindow` always re-centres and re-scales, so firing it on a resize
    // that leaves the square exactly the size it already is threw away a crop
    // the user had positioned, for nothing visible in return — every desktop
    // window drag on the height axis, and every Android Chrome URL-bar
    // collapse, used to do this. Now that `measureViewport` reads the height
    // too, a resize that genuinely changes the box still refits.
    function onResize() {
      if (hasFrame && measureViewport() === viewport) return;
      fitToWindow();
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fitToWindow, hasFrame, viewport]);

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!frame) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    dragState.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, frame };
    setDragging(true);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragState.current;
    const img = imgRef.current;
    if (!drag || drag.pointerId !== e.pointerId || !img) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    setFrame(
      clampFrame(
        { ...drag.frame, left: drag.frame.left + dx, top: drag.frame.top + dy },
        img.naturalWidth,
        img.naturalHeight,
        viewport,
      ),
    );
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (dragState.current?.pointerId === e.pointerId) dragState.current = null;
    setDragging(false);
  }

  /**
   * Everything the wheel handler needs to read, mirrored where it can be read
   * without being closed over. A handler that captures `frame` directly has to
   * be torn down and re-attached every time the frame changes — which is once
   * per pointer move of a drag, hundreds of add/removeEventListener pairs for
   * a single gesture. Synced in an effect rather than during render so the
   * mirror is only ever updated from a committed value.
   */
  const zoomRef = useRef({ frame, minScale, viewport });
  useEffect(() => {
    zoomRef.current = { frame, minScale, viewport };
  }, [frame, minScale, viewport]);

  // Reads its inputs through the ref above so it can be stable, which is what
  // lets the wheel listener subscribe once. The slider calls the same function.
  const rescale = useCallback((nextScale: number) => {
    const img = imgRef.current;
    const { frame: current, viewport: box } = zoomRef.current;
    if (!current || !img) return;
    const { naturalWidth, naturalHeight } = img;
    // Keep the point at the viewport's center fixed in image-space while the
    // zoom level changes, instead of re-centering on every slider nudge.
    const centerX = (box / 2 - current.left) / current.scale;
    const centerY = (box / 2 - current.top) / current.scale;
    setFrame(
      clampFrame(
        {
          scale: nextScale,
          left: box / 2 - centerX * nextScale,
          top: box / 2 - centerY * nextScale,
        },
        naturalWidth,
        naturalHeight,
        box,
      ),
    );
  }, []);

  /**
   * Wheel-zoom has to be a hand-attached native listener rather than an
   * `onWheel` prop. React registers `wheel` at the root container as a
   * *passive* listener, which makes `preventDefault()` on its synthetic event a
   * silent no-op — the image zoomed and the page behind the modal scrolled at
   * the same time, logging a console warning on every notch. `passive: false`
   * is the only thing that can cancel the scroll.
   */
  useEffect(() => {
    // Named for the element, not the `viewport` size above it, which is a
    // number and would otherwise be shadowed here.
    const node = viewportRef.current;
    if (!node) return;

    function onWheel(e: WheelEvent) {
      const { frame: current, minScale: min } = zoomRef.current;
      // No frame yet means the photo hasn't been measured, so there is no zoom
      // to change — and no reason to swallow the page's scroll either.
      if (!current) return;
      e.preventDefault();
      const maxScale = min * MAX_ZOOM_MULTIPLIER;
      rescale(Math.min(maxScale, Math.max(min, current.scale * (1 - e.deltaY * 0.001))));
    }

    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [rescale]);

  function handleConfirm() {
    const img = imgRef.current;
    if (!frame || !img || exporting) return;
    setExporting(true);

    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setExporting(false);
      return;
    }

    // The source rectangle, in the original photo's own pixels, that the
    // viewport is currently framing.
    const sourceSize = viewport / frame.scale;
    const sourceX = -frame.left / frame.scale;
    const sourceY = -frame.top / frame.scale;
    ctx.drawImage(img, sourceX, sourceY, sourceSize, sourceSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

    onConfirm(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
  }

  const maxScale = minScale * MAX_ZOOM_MULTIPLIER;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/80 px-4 py-6"
      role="presentation"
    >
      {/* The dialog is taller than a phone in landscape, and centring it in a
          fixed layer overflows at both ends at once — which put Cancel and
          Confirm off-screen with no way to scroll to them. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Position your profile photo"
        tabIndex={-1}
        // Escape is handled on the dialog rather than on `window`. Every modal
        // used to register its own `window` listener, so one keypress ran all
        // of them and dismissed the entire stack at once. `useDialogFocus`
        // puts focus inside this node on open, so the keydown arrives here;
        // `stopPropagation` then keeps a nested dialog's Escape from reaching
        // the dialog wrapped around it — the same scoping the backdrop click
        // above already relies on, so pointer and keyboard finally agree.
        onKeyDown={(e) => {
          if (e.key !== "Escape" || exporting) return;
          e.stopPropagation();
          onCancel();
        }}
        className="flex max-h-full w-full max-w-sm flex-col items-center gap-5 overflow-y-auto overscroll-contain rounded-3xl bg-neutral-900 p-5 outline-none"
      >
        <p className="shrink-0 text-xs uppercase tracking-widest text-neutral-400">
          Drag to reposition
        </p>

        <div
          ref={viewportRef}
          className="relative shrink-0 touch-none select-none overflow-hidden rounded-2xl bg-neutral-800"
          style={{ width: viewport, height: viewport }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <img
            ref={imgRef}
            src={imageUrl}
            alt=""
            onLoad={handleImageLoad}
            // A file the browser can't decode would otherwise leave a hidden
            // image and a disabled Confirm with nothing explaining why.
            onError={() => setLoadError("Couldn't read that photo. Try a different one.")}
            draggable={false}
            className="absolute left-0 top-0 max-w-none origin-top-left cursor-grab active:cursor-grabbing"
            style={
              frame && naturalSize
                ? {
                    width: naturalSize.width * frame.scale,
                    height: naturalSize.height * frame.scale,
                    transform: `translate(${frame.left}px, ${frame.top}px)`,
                  }
                : { visibility: "hidden" }
            }
          />

          {/* Rule-of-thirds grid, shown while actively dragging. */}
          {dragging && (
            <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="border border-white/40" />
              ))}
            </div>
          )}

          {/* Circular preview mask: the classic oversized-box-shadow trick,
              darkening everything outside the circle without an SVG mask. */}
          <div
            className="pointer-events-none absolute rounded-full"
            style={{
              left: "50%",
              top: "50%",
              width: viewport,
              height: viewport,
              transform: "translate(-50%, -50%)",
              boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
            }}
          />
        </div>

        {loadError && <p className="shrink-0 text-center text-xs text-red-400">{loadError}</p>}

        <input
          type="range"
          min={minScale || 0}
          max={maxScale || 1}
          step={(maxScale - minScale) / 100 || 0.01}
          value={frame?.scale ?? minScale}
          onChange={(e) => rescale(Number(e.target.value))}
          disabled={!frame}
          aria-label="Zoom"
          className="w-full max-w-56 shrink-0 accent-white"
        />

        <div className="flex w-full shrink-0 items-center justify-between px-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={exporting}
            aria-label="Cancel"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-white transition-colors hover:bg-neutral-700 active:bg-neutral-700 disabled:opacity-40"
          >
            <CloseIcon className="h-5 w-5" />
          </button>

          <button
            type="button"
            onClick={handleConfirm}
            disabled={!frame || exporting}
            aria-label="Confirm"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-black transition-transform hover:scale-105 active:scale-95 disabled:opacity-40"
          >
            <CheckIcon className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
