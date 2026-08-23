import { formatRemaining, useNow } from "../time";

export function Countdown({ nextAllowedAt }: { nextAllowedAt: number }) {
  const remaining = nextAllowedAt - useNow();
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
