import { formatRemaining, useNow } from "../time";

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
  const now = useNow() + clockOffset;

  if (nextAllowedAt === undefined) {
    return <span className="text-sm text-neutral-500">Checking your posting window…</span>;
  }

  // Null means the window couldn't be read, which is not the same as "go
  // ahead" — saying so beats counting down from a number we don't have.
  if (nextAllowedAt === null) {
    return (
      <span className="text-sm text-neutral-400">
        Couldn't check your posting window.
      </span>
    );
  }

  const remaining = nextAllowedAt - now;
  const canPost = remaining <= 0;

  return (
    <div className="flex flex-col items-center gap-2 text-white">
      {canPost ? (
        <span className="text-sm text-neutral-300">
          You can share a photo now
        </span>
      ) : (
        <>
          <span className="text-xs uppercase tracking-widest text-neutral-400">
            Next photo in
          </span>
          <span className="font-mono text-2xl">{formatRemaining(remaining)}</span>
        </>
      )}
    </div>
  );
}
