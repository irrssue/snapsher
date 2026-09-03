import { formatRemaining, useNow } from "../time";

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
}) {
  // Once the window is open there is nothing left to count, so the interval
  // stops rather than re-rendering a static string once a second forever. The
  // deadline is converted to the local clock, which is what `useNow` reads.
  const now =
    useNow(1000, typeof nextAllowedAt === "number" ? nextAllowedAt - clockOffset : null) +
    clockOffset;

  if (nextAllowedAt === undefined) {
    return (
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
