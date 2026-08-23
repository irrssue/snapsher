import { useEffect, useState } from "react";

function format(msRemaining: number) {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

export function Countdown({ nextAllowedAt }: { nextAllowedAt: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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
          <span className="font-mono text-2xl">{format(remaining)}</span>
        </>
      )}
    </div>
  );
}
