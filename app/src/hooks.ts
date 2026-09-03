import { useEffect, useRef } from "react";

/**
 * How many mounted modals currently want the page frozen, and the value to put
 * back when the last of them goes away. Module scope, not per-hook state:
 * modals stack (a grid photo opens over a public profile, a profile opens over
 * the friends popup), and a per-instance snapshot of `body.style.overflow`
 * would capture `"hidden"` — the value the modal underneath had already
 * written. React unmounts a deleted subtree's effects parent-first, so the
 * outer modal restored `""` and the inner one then wrote `"hidden"` back over
 * it, leaving the whole app unscrollable with nothing on screen to explain why.
 */
let scrollLockCount = 0;
let previousBodyOverflow = "";

/**
 * Freezes the page behind a modal for as long as it is mounted. Without it a
 * drag anywhere on the backdrop scrolls the feed underneath, so dismissing the
 * modal hands back a different scroll position than it was opened from.
 *
 * `overflow` on `body` propagates to the viewport, which is what actually stops
 * iOS Safari scrolling — no `position: fixed` juggling needed.
 */
export function useBodyScrollLock() {
  useEffect(() => {
    if (scrollLockCount++ === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    return () => {
      if (--scrollLockCount === 0) document.body.style.overflow = previousBodyOverflow;
    };
  }, []);
}

/**
 * Everything focusable, in DOM order. `:not([disabled])` matters because the
 * primary button in most of these dialogs spends its time disabled — trapping
 * onto it would strand the keyboard on a control that does nothing.
 */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Moves keyboard focus into a dialog when it opens, keeps it there while it is
 * open, and hands it back to whatever opened it on close. Returns the ref to
 * put on the dialog element, which also needs `tabIndex={-1}` to be focusable
 * at all.
 *
 * The trap is the part that was missing. `aria-modal="true"` confines a screen
 * reader's virtual cursor but does nothing to Tab, and nothing here ever set
 * `inert` on the page behind — so tabbing off the last control in a dialog
 * walked straight into the nav bar and the feed underneath the backdrop, where
 * a keyboard user could operate controls they could not see. Wrapping at both
 * ends is cheaper and less invasive than toggling `inert` on the app root,
 * which would have to know about a root it is deliberately unaware of.
 */
export function useDialogFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  // Captured during render because React applies a child's `autoFocus` in the
  // commit that runs before the effect below — by then `document.activeElement`
  // is that child, not the button that opened the dialog.
  const openerRef = useRef<Element | null>(null);
  openerRef.current ??= document.activeElement;

  useEffect(() => {
    const dialog = ref.current;
    // If something inside already claimed focus (an `autoFocus`ed field), leave
    // it there rather than pulling focus back out to the container.
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      // Re-queried on every Tab rather than cached: these dialogs swap their
      // contents constantly — a confirm panel replaces a footer, a step
      // replaces a form — and a list captured on open goes stale immediately.
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        // Nothing to land on; keep focus on the dialog rather than letting it
        // escape to the page behind.
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog?.addEventListener("keydown", onKeyDown);

    const opener = openerRef.current;
    return () => {
      dialog?.removeEventListener("keydown", onKeyDown);
      // A session that ends mid-modal unmounts the opener along with it, and
      // focusing a detached node silently drops focus to <body> instead.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return ref;
}

/* ------------------------------------------------------- History dismissal */

/**
 * Making the device Back gesture close an overlay instead of leaving the site
 * takes one throwaway history entry per open overlay. The bookkeeping for those
 * entries lives here, at module scope, because it is fundamentally a property
 * of the stack of overlays rather than of any one of them — and every bug this
 * replaced came from a shell trying to decide it alone.
 *
 * Two rules the per-shell version broke:
 *
 *  - A shell that closes while another opens in the same commit must leave the
 *    history depth alone. Settings handing off to Change password did a
 *    `history.back()` on the way out and a `pushState` on the way in; `back()`
 *    is asynchronous, so its `popstate` landed *after* the new entry existed
 *    and dismissed the dialog that had just opened. Change password, Delete
 *    account and the avatar cropper all vanished the instant they were asked
 *    for.
 *  - A `popstate` this code caused itself is not a Back gesture. Closing a
 *    stacked overlay used to unwind its own entry, and the listener still
 *    registered by the overlay *underneath* took that as Back — so dismissing
 *    a photo opened from a profile closed the profile with it.
 *
 * Both fall out of tracking a desired depth and reconciling to it once, in a
 * microtask, after React has finished committing.
 */
type Overlay = { dismiss: () => void };

/** Open overlays, oldest first — the last entry is the topmost. */
const overlays: Overlay[] = [];
/** Marker entries we believe are currently on the history stack. */
let markerCount = 0;
/** Set while a traversal we asked for is in flight, so we can ignore its pop. */
let unwinding = false;
let syncQueued = false;
let listening = false;

/** Identifies our own entries, and records the depth each one stands for. */
const MARKER = "snapsherOverlayDepth";

function markerDepth(state: unknown): number {
  if (typeof state !== "object" || state === null) return 0;
  const depth = (state as Record<string, unknown>)[MARKER];
  return typeof depth === "number" ? depth : 0;
}

/**
 * Brings the history depth in line with the number of open overlays. Deferred
 * and coalesced, so a close and an open that happen in the same commit cancel
 * out instead of racing each other through the history queue.
 */
function syncHistory() {
  syncQueued = false;
  // A traversal is still in flight; its `popstate` re-runs this with settled
  // numbers. Acting now would be reconciling against a depth we don't have yet.
  if (unwinding) return;

  const wanted = overlays.length;
  if (wanted === markerCount) return;

  if (wanted > markerCount) {
    while (markerCount < wanted) {
      markerCount++;
      window.history.pushState({ [MARKER]: markerCount }, "");
    }
    return;
  }

  const delta = markerCount - wanted;
  markerCount = wanted;
  unwinding = true;
  // One `go`, not `delta` calls to `back()`: a multi-step traversal reports a
  // single `popstate`, so unwinding two entries with two calls would leave the
  // second one waiting for an event that never arrives.
  window.history.go(-delta);
}

function scheduleSync() {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(syncHistory);
}

function onPopState(event: PopStateEvent) {
  if (unwinding) {
    unwinding = false;
    // Anything that changed while the traversal was in flight is still owed.
    scheduleSync();
    return;
  }

  // A real Back (or Forward): the entry we landed on says how many overlays
  // the user expects to still be open.
  const depth = markerDepth(event.state);
  markerCount = depth;
  // Topmost first, and off a copy — `dismiss` unmounts, which splices.
  for (const overlay of overlays.slice(depth).reverse()) overlay.dismiss();
  // An overlay that refuses to close (mid-delete, say) gets its entry pushed
  // straight back, so the next Back tries again rather than leaving the site.
  scheduleSync();
}

/**
 * Registers an overlay for Back-to-dismiss for as long as it is mounted.
 * `onClose` may decline to close — the history depth is reconciled to whatever
 * is actually still open either way.
 */
export function useHistoryDismiss(onClose: () => void) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const overlay: Overlay = { dismiss: () => onCloseRef.current() };
    overlays.push(overlay);
    if (!listening) {
      listening = true;
      window.addEventListener("popstate", onPopState);
    }
    scheduleSync();

    return () => {
      const index = overlays.indexOf(overlay);
      if (index !== -1) overlays.splice(index, 1);
      scheduleSync();
    };
  }, []);
}
