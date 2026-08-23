import { formatRemaining, useNow } from "../time";

export function Countdown({ nextAllowedAt }: { nextAllowedAt: number | null }) {
  const now = useNow();

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
