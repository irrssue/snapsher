import { formatRemaining, useNow } from "../time";
import { Skeleton } from "./ui";

/** The window the server enforces. Only used to draw the ring's progress. */
const WINDOW_MS = 12 * 60 * 60 * 1000;

const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Spoken form of the remaining time. The digits render as "07:14:22", which a
 * screen reader voices as three unrelated numbers — accurate and useless.
 * Deliberately not `aria-live`: this updates every second, and announcing it
 * every second would make the rest of the page unusable.
 */
function spokenRemaining(msRemaining: number) {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours === 0 && minutes === 0) return "Less than a minute until your next photo";
  const parts = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return `${parts.join(" ")} until your next photo`;
}

export function Countdown({
  nextAllowedAt,
  clockOffset,
  variant = "inline",
}: {
  /**
   * Three states, not two: `undefined` while the quota call is still in
   * flight, `null` once it has failed. Collapsing them made every load flash
   * "Couldn't check your posting window." before the real answer arrived —
   * an error message as the app's first impression, on a screen that was
   * working perfectly.
   */
  nextAllowedAt: number | null | undefined;
  /** Added to the local clock so this counts down in the server's time, not the device's. */
  clockOffset: number;
  /**
   * `hero` is the home screen's version: the ring, the large digits, and the
   * line naming the rule. `inline` is the quiet one-liner the profile keeps.
   */
  variant?: "hero" | "inline";
}) {
  // Once the window is open there is nothing left to count, so the interval
  // stops rather than re-rendering a static string once a second forever. The
  // deadline is converted to the local clock, which is what `useNow` reads.
  const now =
    useNow(1000, typeof nextAllowedAt === "number" ? nextAllowedAt - clockOffset : null) +
    clockOffset;

  const hero = variant === "hero";

  if (nextAllowedAt === undefined) {
    return hero ? (
      <div className="flex flex-col items-center gap-3" role="status">
        <Skeleton className="h-28 w-28 rounded-full" />
        <Skeleton className="h-4 w-40" />
        <span className="sr-only">Checking your posting window…</span>
      </div>
    ) : (
      <span className="text-sm text-neutral-400" role="status">
        Checking your posting window…
      </span>
    );
  }

  // Null means the window couldn't be read, which is not the same as "go
  // ahead" — saying so beats counting down from a number we don't have.
  if (nextAllowedAt === null) {
    return (
      <span className="text-sm text-neutral-400" role="alert">
        Couldn't check your posting window.
      </span>
    );
  }

  const remaining = nextAllowedAt - now;
  const canPost = remaining <= 0;

  if (!hero) {
    return (
      <div className="flex flex-col items-center gap-2 text-white">
        {canPost ? (
          <span className="text-sm text-neutral-300">You can share a photo now</span>
        ) : (
          <>
            <span className="text-xs uppercase tracking-widest text-neutral-400">Next photo in</span>
            <time
              role="timer"
              aria-label={spokenRemaining(remaining)}
              className="font-mono text-2xl tabular-nums"
            >
              {formatRemaining(remaining)}
            </time>
          </>
        )}
      </div>
    );
  }

  if (canPost) {
    return (
      <div className="flex flex-col items-center gap-2 py-2 text-center">
        <p className="text-base text-white">Your window is open.</p>
        <p className="text-xs text-neutral-400">One photo, every 12 hours.</p>
      </div>
    );
  }

  // Fraction of the window already served. Clamped because a clock that drifts
  // the wrong way would otherwise draw an arc longer than the circle.
  const elapsed = Math.min(1, Math.max(0, (WINDOW_MS - remaining) / WINDOW_MS));

  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <div className="relative h-28 w-28">
        <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" aria-hidden="true">
          <circle
            cx="60"
            cy="60"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            className="text-field"
          />
          {/*
           * The arc fills as the window is served rather than draining, so the
           * shape reads as progress towards something instead of a depleting
           * resource — the difference between a promise and a penalty on a
           * product whose whole premise is the wait.
           */}
          <circle
            cx="60"
            cy="60"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - elapsed)}
            className="text-neutral-300 transition-[stroke-dashoffset] duration-1000 ease-linear"
          />
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <time
            role="timer"
            aria-label={spokenRemaining(remaining)}
            className="font-mono text-xl tabular-nums tracking-tight text-white"
          >
            {formatRemaining(remaining)}
          </time>
        </div>
      </div>

      <p className="text-xs text-neutral-400">One photo, every 12 hours.</p>
    </div>
  );
}
