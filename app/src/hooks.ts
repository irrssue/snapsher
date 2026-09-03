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

/**
 * Makes the device Back gesture close an overlay instead of leaving the site.
 *
 * Nothing in the app touched `history`, so on Android the hardware Back button
 * and on iOS the edge swipe navigated away from Snapsher entirely — with a
 * photo preview open, the reflex that every other app trains dumped the user
 * out. This pushes one throwaway entry while the overlay is mounted and pops it
 * on close, so Back and the close button do the same thing.
 *
 * `closingRef` keeps the two paths from fighting: closing via the UI has to
 * remove the entry this pushed, and doing that fires `popstate`, which would
 * otherwise call `onClose` a second time.
 */
export function useHistoryDismiss(onClose: () => void) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const marker = { snapsherOverlay: Date.now() };
    window.history.pushState(marker, "");
    let popped = false;

    const onPopState = () => {
      popped = true;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPopState);

    return () => {
      window.removeEventListener("popstate", onPopState);
      // Already unwound by the Back gesture itself; going back again would eat
      // a real entry and navigate the user off the page.
      if (popped) return;
      window.history.back();
    };
  }, []);
}
