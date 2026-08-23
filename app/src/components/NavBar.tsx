import { PlusIcon } from "./icons";

type View = "home" | "profile";

type NavBarProps = {
  active: View;
  onChange: (view: View) => void;
  onAddPost?: () => void;
};

const TABS: { key: View; label: string }[] = [
  { key: "home", label: "Home" },
  { key: "profile", label: "Profile" },
];

export function NavBar({ active, onChange, onAddPost }: NavBarProps) {
  return (
    <nav className="flex items-center justify-center gap-3 pt-8">
      <div className="flex gap-1 rounded-full bg-neutral-800 p-1">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            className={`rounded-full px-5 py-1.5 text-sm transition-colors ${
              active === tab.key
                ? "bg-neutral-200 text-black"
                : "text-neutral-300 hover:text-white"
            }`}
          >
            {tab.label}
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
