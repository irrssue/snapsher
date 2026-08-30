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
 * Moves keyboard focus into a dialog when it opens and hands it back to
 * whatever opened it on close. Returns the ref to put on the dialog element,
 * which also needs `tabIndex={-1}` to be focusable at all.
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

    const opener = openerRef.current;
    return () => {
      // A session that ends mid-modal unmounts the opener along with it, and
      // focusing a detached node silently drops focus to <body> instead.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return ref;
}
