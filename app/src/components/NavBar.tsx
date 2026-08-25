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
  { key: "profile", label: "Profile", icon: (c) => <PersonIcon className={c} /> },
];

export function NavBar({ active, onChange, onAddPost }: NavBarProps) {
  return (
    <nav className="flex items-center justify-center gap-3 px-4 pt-6 md:pt-8">
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
                : "text-neutral-300 hover:text-white"
            }`}
          >
            {tab.icon("h-6 w-6")}
          </button>
        ))}
      </div>

      <button
        type="button"
        aria-label="Add post"
        onClick={onAddPost}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-black transition-transform hover:scale-105"
      >
        <PlusIcon className="h-4 w-4" />
      </button>
    </nav>
  );
}
