type View = "home" | "profile";

type NavBarProps = {
  active: View;
  onChange: (view: View) => void;
};

const TABS: { key: View; label: string }[] = [
  { key: "home", label: "Home" },
  { key: "profile", label: "Profile" },
];

export function NavBar({ active, onChange }: NavBarProps) {
  return (
    <nav className="flex justify-center pt-8">
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
    </nav>
  );
}
