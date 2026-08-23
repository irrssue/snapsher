import { useState } from "react";
import { NavBar } from "./components/NavBar";
import { PostCard } from "./components/PostCard";
import { Countdown } from "./components/Countdown";
import { AuthPage, type AuthMode } from "./components/AuthPage";
import type { Post } from "./types";

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

const SAMPLE_POSTS: Post[] = [
  {
    id: "1",
    username: "username",
    description: "Photo description here\nLorem",
  },
  {
    id: "2",
    username: "username",
    description:
      "Photo description here\nLorem ipsum dolor sit amet\nconsectetur adipiscing elit",
  },
];

function App() {
  const [authed, setAuthed] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [view, setView] = useState<"home" | "profile">("home");
  const [nextAllowedAt] = useState(() => Date.now() + TWELVE_HOURS_MS);

  if (!authed) {
    return (
      <AuthPage
        mode={authMode}
        onModeChange={setAuthMode}
        onSubmit={() => setAuthed(true)}
      />
    );
  }

  return (
    <div className="min-h-screen bg-black">
      <NavBar active={view} onChange={setView} />

      <main className="flex justify-center px-6 py-24">
        {view === "home" ? (
          <div className="flex flex-col gap-16">
            {SAMPLE_POSTS.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-8 pt-16">
            <div className="h-24 w-24 rounded-full bg-neutral-300" />
            <span className="text-white">@username</span>
            <Countdown nextAllowedAt={nextAllowedAt} />
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
