import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, CloseIcon } from "./icons";

/** On-screen size of the square crop viewport. */
const VIEWPORT = 288;
/** Side length, in pixels, of the square avatar we actually upload. */
const OUTPUT_SIZE = 640;
const JPEG_QUALITY = 0.9;
const MAX_ZOOM_MULTIPLIER = 3;

type Frame = { left: number; top: number; scale: number };

function clampFrame(frame: Frame, naturalWidth: number, naturalHeight: number): Frame {
  const displayWidth = naturalWidth * frame.scale;
  const displayHeight = naturalHeight * frame.scale;
  // The image must always fully cover the viewport: its edges can retreat
  // past the viewport's edges but never leave a gap inside it.
  const minLeft = VIEWPORT - displayWidth;
  const minTop = VIEWPORT - displayHeight;
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
  const [frame, setFrame] = useState<Frame | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [minScale, setMinScale] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const dragState = useRef<{ pointerId: number; startX: number; startY: number; frame: Frame } | null>(
    null,
  );

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
    setLoadError(null);
    setNaturalSize({ width: naturalWidth, height: naturalHeight });
    const cover = Math.max(VIEWPORT / naturalWidth, VIEWPORT / naturalHeight);
    setMinScale(cover);
    setFrame(
      clampFrame(
        {
          scale: cover,
          left: (VIEWPORT - naturalWidth * cover) / 2,
          top: (VIEWPORT - naturalHeight * cover) / 2,
        },
        naturalWidth,
        naturalHeight,
      ),
    );
  }, []);

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

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !exporting) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, exporting]);

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
      ),
    );
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (dragState.current?.pointerId === e.pointerId) dragState.current = null;
    setDragging(false);
  }

  // Memoised only so the wheel effect below can depend on it honestly rather
  // than close over a stale copy; the slider calls the same function.
  const rescale = useCallback(
    (nextScale: number) => {
      const img = imgRef.current;
      if (!frame || !img) return;
      const { naturalWidth, naturalHeight } = img;
      // Keep the point at the viewport's center fixed in image-space while the
      // zoom level changes, instead of re-centering on every slider nudge.
      const centerX = (VIEWPORT / 2 - frame.left) / frame.scale;
      const centerY = (VIEWPORT / 2 - frame.top) / frame.scale;
      setFrame(
        clampFrame(
          {
            scale: nextScale,
            left: VIEWPORT / 2 - centerX * nextScale,
            top: VIEWPORT / 2 - centerY * nextScale,
          },
          naturalWidth,
          naturalHeight,
        ),
      );
    },
    [frame],
  );

  /**
   * Wheel-zoom has to be a hand-attached native listener rather than an
   * `onWheel` prop. React registers `wheel` at the root container as a
   * *passive* listener, which makes `preventDefault()` on its synthetic event a
   * silent no-op — the image zoomed and the page behind the modal scrolled at
   * the same time, logging a console warning on every notch. `passive: false`
   * is the only thing that can cancel the scroll.
   *
   * Re-subscribing whenever the zoom inputs change is deliberate: the handler
   * reads `frame` and `minScale`, so the listener and the function it calls
   * always agree about the current zoom.
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !frame) return;

    function onWheel(e: WheelEvent) {
      if (!frame) return;
      e.preventDefault();
      const maxScale = minScale * MAX_ZOOM_MULTIPLIER;
      rescale(Math.min(maxScale, Math.max(minScale, frame.scale * (1 - e.deltaY * 0.001))));
    }

    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [frame, minScale, rescale]);

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
    const sourceSize = VIEWPORT / frame.scale;
    const sourceX = -frame.left / frame.scale;
    const sourceY = -frame.top / frame.scale;
    ctx.drawImage(img, sourceX, sourceY, sourceSize, sourceSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

    onConfirm(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
  }

  const maxScale = minScale * MAX_ZOOM_MULTIPLIER;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Position your profile photo"
        className="flex w-full max-w-sm flex-col items-center gap-5 rounded-3xl bg-neutral-900 p-6"
      >
        <p className="text-xs uppercase tracking-widest text-neutral-500">
          Drag to reposition
        </p>

        <div
          ref={viewportRef}
          className="relative touch-none select-none overflow-hidden rounded-2xl bg-neutral-800"
          style={{ width: VIEWPORT, height: VIEWPORT }}
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
              width: VIEWPORT,
              height: VIEWPORT,
              transform: "translate(-50%, -50%)",
              boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
            }}
          />
        </div>

        {loadError && <p className="text-center text-xs text-red-400">{loadError}</p>}

        <input
          type="range"
          min={minScale || 0}
          max={maxScale || 1}
          step={(maxScale - minScale) / 100 || 0.01}
          value={frame?.scale ?? minScale}
          onChange={(e) => rescale(Number(e.target.value))}
          disabled={!frame}
          aria-label="Zoom"
          className="w-full max-w-56 accent-white"
        />

        <div className="flex w-full items-center justify-between px-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={exporting}
            aria-label="Cancel"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-800 text-white transition-colors hover:bg-neutral-700 disabled:opacity-40"
          >
            <CloseIcon className="h-5 w-5" />
          </button>

          <button
            type="button"
            onClick={handleConfirm}
            disabled={!frame || exporting}
            aria-label="Confirm"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-black transition-transform hover:scale-105 disabled:opacity-40"
          >
            <CheckIcon className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
