import type { ReactElement } from "react";
import { HomeIcon, PlusIcon, SearchIcon, PersonIcon } from "./icons";

type View = "home" | "friends" | "profile";

type NavBarProps = {
  active: View;
  onChange: (view: View) => void;
  onAddPost?: () => void;
};

const TABS: { key: View; label: string; icon: (className: string) => ReactElement }[] = [
  { key: "home", label: "Home", icon: (c) => <HomeIcon className={c} /> },
  { key: "friends", label: "Search", icon: (c) => <SearchIcon className={c} /> },
];

export function NavBar({ active, onChange, onAddPost }: NavBarProps) {
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
        <button
          type="button"
          aria-label="Add post"
          onClick={onAddPost}
          className="flex h-11 w-11 items-center justify-center rounded-full text-neutral-300 transition-colors hover:text-white active:text-white"
        >
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
