import { useEffect, useState } from "react";

/**
 * Re-renders on an interval so time-based UI (countdowns) stays live.
 *
 * `stopAt` exists because the old version never stopped: it ticked once a
 * second for the whole session, including while the tab was in the background
 * and including after the countdown had already reached zero and was rendering
 * a static string. A backgrounded tab is throttled but not silenced, and this
 * drove a re-render of the feed's countdown and the compose modal for no
 * output at all.
 *
 * It is a *deadline* rather than an `active` boolean deliberately: a boolean
 * has to be computed by the caller, and the only way to compute it is to read
 * `Date.now()` during render, which is exactly the impurity this hook exists to
 * contain. Given the timestamp, the decision to stop happens inside the tick.
 * `stopAt` is on the local clock — subtract any server offset before passing it.
 */
export function useNow(intervalMs = 1000, stopAt?: number | null) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;

    const stop = () => {
      if (id !== undefined) clearInterval(id);
      id = undefined;
    };
    const elapsed = () => typeof stopAt === "number" && Date.now() >= stopAt;
    const tick = () => {
      setNow(Date.now());
      if (elapsed()) stop();
    };
    const start = () => {
      if (id === undefined && !elapsed()) id = setInterval(tick, intervalMs);
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        // Catch up immediately: coming back to a countdown that is a minute
        // stale until the next tick reads as a frozen clock.
        tick();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, stopAt]);

  return now;
}

/** Milliseconds to a clamped HH:MM:SS string. */
export function formatRemaining(msRemaining: number) {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}
