import { createContext, useContext } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { PersonIcon } from "./icons";
import { useBodyScrollLock, useDialogFocus, useHistoryDismiss } from "../hooks";

/* ------------------------------------------------------------------ Avatar */

/**
 * Sizes deliberately mirror what the app already drew rather than rounding them
 * onto a tidier scale — this replaced seven hand-rolled avatars across six
 * sizes, and changing their dimensions in the same pass would have made every
 * layout regression look like a refactor bug.
 */
const AVATAR_SIZES = {
  xs: { box: "h-6 w-6", glyph: "h-4" },
  sm: { box: "h-7 w-7", glyph: "h-4" },
  md: { box: "h-8 w-8", glyph: "h-5" },
  lg: { box: "h-11 w-11", glyph: "h-6" },
  xl: { box: "h-24 w-24", glyph: "h-14" },
} as const;

/**
 * The one avatar in the app.
 *
 * Previously there were seven, in six sizes and two different colour schemes,
 * and one of them (the compose preview) drew a bare grey disc with no person
 * glyph at all — so the preview of a post didn't match the post. The
 * placeholder is `bg-field` with a `text-neutral-400` glyph everywhere now:
 * the old `bg-neutral-300` was a near-white disc on a near-black page, and its
 * `text-neutral-500` glyph sat at 3.19:1 against it, below AA either way.
 */
export function Avatar({
  url,
  size = "md",
  ring = false,
}: {
  url: string | null;
  size?: keyof typeof AVATAR_SIZES;
  ring?: boolean;
}) {
  const { box, glyph } = AVATAR_SIZES[size];
  const shell = `${box} shrink-0 overflow-hidden rounded-full ${ring ? "ring-1 ring-white/10" : ""}`;

  if (url) {
    return (
      <img
        src={url}
        // Decorative: every call site puts the visible `@username` next to it,
        // so naming the person again is a duplicate stop for a screen reader.
        alt=""
        loading="lazy"
        decoding="async"
        className={`${shell} object-cover`}
      />
    );
  }

  return (
    <span className={`${shell} flex items-center justify-center bg-field`} aria-hidden="true">
      <PersonIcon className={`${glyph} text-neutral-400`} />
    </span>
  );
}

/* ------------------------------------------------------------------ Button */

const BUTTON_VARIANTS = {
  primary:
    "bg-white text-black font-medium hover:bg-neutral-200 active:bg-neutral-200 disabled:bg-neutral-700 disabled:text-neutral-300",
  secondary:
    "bg-field text-white hover:bg-neutral-700 active:bg-neutral-700 disabled:bg-neutral-800 disabled:text-neutral-500",
  danger:
    // `red-600`, not `red-500`: white on #fb2c36 measures 3.82:1, under AA for
    // the button most worth reading carefully before pressing.
    "bg-red-600 text-white font-medium hover:bg-red-700 active:bg-red-700 disabled:bg-neutral-700 disabled:text-neutral-300",
  ghost: "text-neutral-300 hover:text-white active:text-white disabled:text-neutral-600",
} as const;

/**
 * One pill button, replacing three primary treatments and three secondary ones
 * that disagreed about weight, padding, hover (two shifted text colour, one
 * shifted background) and what "disabled" looks like.
 *
 * `min-h-11` is not decoration: every pill in the app was 36-40px tall, under
 * the 44px touch target the nav bar and the close buttons already respected.
 */
export function Button({
  variant = "primary",
  className = "",
  type = "button",
  ...rest
}: {
  variant?: keyof typeof BUTTON_VARIANTS;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={`flex min-h-11 items-center justify-center rounded-full px-4 text-sm transition-colors disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}

/* -------------------------------------------------------------- ModalShell */

/**
 * How many shells are already open above this one.
 *
 * Context rather than a module counter, because the backdrop has to be decided
 * during render and a counter mutated in an effect is both a render too late
 * and double-counted under StrictMode. A grid photo opened from someone's
 * public profile is the case that mattered: two `bg-black/80` backdrops
 * composite to about 96% black, so the page behind read as switched off rather
 * than dimmed, and the same photo looked different depending on which route
 * reached it.
 */
const ModalDepth = createContext(0);

export function ModalShell({
  label,
  labelledBy,
  onClose,
  dismissible = true,
  size = "sm",
  scroll = true,
  className = "",
  children,
}: {
  /** Ignored when `labelledBy` names a visible heading, which is preferred. */
  label?: string;
  labelledBy?: string;
  onClose: () => void;
  /** False while an irreversible action is in flight. */
  dismissible?: boolean;
  size?: "sm" | "lg";
  /**
   * False when the dialog caps its own height and scrolls an inner region
   * instead — the friends list pins its search field and scrolls only the rows.
   */
  scroll?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const depth = useContext(ModalDepth);
  const dialogRef = useDialogFocus<HTMLDivElement>();

  useBodyScrollLock();
  // Back closes the topmost overlay instead of leaving the site. Registered
  // per-shell, so a stack unwinds one at a time.
  useHistoryDismiss(() => {
    if (dismissible) onClose();
  });

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center px-4 py-6 md:px-6 md:py-10 ${
        depth === 0 ? "bg-black/80" : ""
      }`}
      onClick={() => {
        if (dismissible) onClose();
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        // Escape is handled on the dialog rather than on `window`. Every modal
        // used to register its own `window` listener, so one keypress ran all
        // of them and dismissed the entire stack at once. `useDialogFocus`
        // puts focus inside this node on open, so the keydown arrives here;
        // `stopPropagation` then keeps a nested dialog's Escape from reaching
        // the dialog wrapped around it — the same scoping the backdrop click
        // above already relies on, so pointer and keyboard finally agree.
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !dismissible) return;
          e.stopPropagation();
          onClose();
        }}
        className={`max-h-full w-full rounded-shell bg-surface p-5 outline-none motion-safe:animate-[modal-in_150ms_ease-out] ${
          scroll ? "overflow-y-auto overscroll-contain" : "overflow-hidden"
        } ${size === "lg" ? "max-w-md md:max-w-3xl md:p-8" : "max-w-sm"} ${className}`}
      >
        <ModalDepth.Provider value={depth + 1}>{children}</ModalDepth.Provider>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ States */

/** A neutral bar used to hold a shape while its data is in flight. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`block animate-pulse rounded-full bg-field ${className}`} aria-hidden="true" />;
}

/**
 * Every error in the app used to be dead text: no `role`, so a screen reader
 * announced nothing, and no way forward, so the only recovery from a failed
 * feed was a manual page reload that nothing on screen suggested.
 */
export function ErrorState({
  message,
  onRetry,
  className = "",
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center gap-2 ${className}`} role="alert">
      <p className="text-center text-sm text-neutral-300">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-11 text-sm text-neutral-300 underline underline-offset-4 transition-colors hover:text-white active:text-white"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/** One line of red, announced. Sized so its absence doesn't shift the layout. */
export function FieldError({ id, message }: { id?: string; message?: string | null }) {
  return (
    <p id={id} role="alert" className="min-h-4 text-center text-xs text-red-400">
      {message}
    </p>
  );
}

/* ---------------------------------------------------------------- Wordmark */

/**
 * The app's name and its one rule, on the two screens a user sees before any of
 * their own content exists. "Snapsher" used to appear exactly once in the whole
 * client — in the `<title>` — so the first screen of a brand-new sign-up was an
 * unlabelled black page with two fields on it, and nothing anywhere stated the
 * premise they were signing up to.
 */
export function Wordmark({ tagline = true }: { tagline?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <span className="text-lg font-medium tracking-tight text-white">Snapsher</span>
      {tagline && <span className="text-xs text-neutral-400">One photo, every 12 hours.</span>}
    </div>
  );
}

