import type { ReactElement } from "react";
import { HomeIcon, PlusIcon, SearchIcon, PersonIcon } from "./icons";
import { formatRemaining, useNow } from "../time";

type View = "home" | "friends" | "profile";

type NavBarProps = {
  active: View;
  onChange: (view: View) => void;
  onAddPost?: () => void;
  /** `undefined`/`null` mean the quota isn't known — see `windowClosed` below. */
  nextAllowedAt?: number | null;
  clockOffset?: number;
};

/** The window the server enforces, used only to draw the ring. */
const WINDOW_MS = 12 * 60 * 60 * 1000;
const RING_RADIUS = 19;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const TABS: { key: View; label: string; icon: (className: string) => ReactElement }[] = [
  { key: "home", label: "Home", icon: (c) => <HomeIcon className={c} /> },
  { key: "friends", label: "Search", icon: (c) => <SearchIcon className={c} /> },
];

export function NavBar({
  active,
  onChange,
  onAddPost,
  nextAllowedAt,
  clockOffset = 0,
}: NavBarProps) {
  /**
   * Only a *known* closed window disables the control. An unread quota — the
   * call still in flight, or failed — leaves the button live: refusing to open
   * compose because we couldn't check would turn one failed request into an
   * app that looks broken, and the server rejects an over-quota post anyway.
   */
  const windowClosed = typeof nextAllowedAt === "number";
  const now =
    useNow(1000, windowClosed ? nextAllowedAt - clockOffset : null) + clockOffset;
  const remaining = windowClosed ? nextAllowedAt - now : 0;
  const locked = windowClosed && remaining > 0;
  const elapsed = locked ? Math.min(1, Math.max(0, (WINDOW_MS - remaining) / WINDOW_MS)) : 1;

  return (
    // Notched iPhones reserve a band at the bottom for the home indicator,
    // and it swallows taps — the pill has to clear it, not sit in it.
    <nav className="fixed inset-x-0 bottom-0 z-10 flex items-center justify-center gap-3 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:static md:pt-8 md:pb-0">
      <div className="flex gap-1 rounded-full bg-neutral-800 p-1">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            aria-label={tab.label}
            onClick={() => onChange(tab.key)}
            className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
              active === tab.key
                ? "bg-neutral-200 text-black"
                : "text-neutral-300 hover:text-white active:text-white"
            }`}
          >
            {tab.icon("h-6 w-6")}
          </button>
        ))}
        {/*
         * The window, shown before it costs anything. The button used to be
         * permanently enabled, so the way people learned about the 12-hour rule
         * was: tap +, open the picker, choose a photo, and only then read that
         * Share is greyed out for another seven hours. A ring that fills as the
         * wait is served says the same thing up front, and turns the constraint
         * from a wall into the thing the product is actually about.
         */}
        <button
          type="button"
          aria-label={
            locked ? `Next photo in ${formatRemaining(remaining)}` : "Share a photo"
          }
          onClick={onAddPost}
          disabled={locked}
          className="relative flex h-11 w-11 items-center justify-center rounded-full text-neutral-300 transition-colors hover:text-white active:text-white disabled:cursor-not-allowed disabled:text-neutral-500"
        >
          {locked && (
            <svg viewBox="0 0 44 44" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden="true">
              <circle
                cx="22"
                cy="22"
                r={RING_RADIUS}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={RING_CIRCUMFERENCE * (1 - elapsed)}
                className="text-neutral-400 transition-[stroke-dashoffset] duration-1000 ease-linear"
              />
            </svg>
          )}
          <PlusIcon className="h-6 w-6" />
        </button>
      </div>

      <button
        type="button"
        aria-label="Profile"
        onClick={() => onChange("profile")}
        className={`flex h-11 w-11 items-center justify-center rounded-full transition-transform hover:scale-105 active:scale-95 ${
          active === "profile" ? "bg-neutral-200 text-black" : "bg-white text-black"
        }`}
      >
        <PersonIcon className="h-5 w-5" />
      </button>
    </nav>
  );
}
