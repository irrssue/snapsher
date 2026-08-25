import { useEffect, useState } from "react";
import { CloseIcon, SearchIcon } from "./icons";
import { PersonRow } from "./FriendsTab";
import { useBodyScrollLock, useDialogFocus } from "../hooks";
import type { Friend } from "../api/friends";

type FriendsListPopupProps = {
  friends: Friend[];
  error: string | null;
  onClose: () => void;
  onRemoveFriend: (friend: Friend) => void;
};

export function FriendsListPopup({
  friends,
  error,
  onClose,
  onRemoveFriend,
}: FriendsListPopupProps) {
  const [query, setQuery] = useState("");
  const dialogRef = useDialogFocus<HTMLDivElement>();

  useBodyScrollLock();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const filtered = friends.filter((f) =>
    f.username.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 py-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Friends"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[30rem] w-full max-w-sm flex-col overflow-hidden rounded-3xl bg-neutral-900 p-5 outline-none"
      >
        <div className="flex shrink-0 items-center justify-between">
          <h2 className="text-sm font-medium text-white">Friends</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-2 p-2 text-neutral-400 transition-colors hover:text-white active:text-white"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <label className="relative mt-4 block shrink-0">
          <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            type="search"
            inputMode="search"
            enterKeyHint="search"
            // Autocorrect rewrites the username as it is typed — "irrssue"
            // becomes "issue" — and the list then truthfully reports that
            // nobody matches a name the user never entered.
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            // React runs `autoFocus` inside the click that opened this dialog,
            // so on a phone WebKit raises the keyboard over the bottom half of
            // the very list the dialog exists to show.
            autoFocus={window.matchMedia("(pointer: fine)").matches}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={30}
            placeholder="Search your friends"
            aria-label="Search your friends"
            className="w-full rounded-full bg-neutral-800 py-2 pl-10 pr-4 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-500"
          />
        </label>

        {error && <p className="mt-4 shrink-0 text-center text-xs text-red-400">{error}</p>}

        <div className="mt-4 flex flex-col gap-1 overflow-y-auto overscroll-contain">
          {filtered.map((friend) => (
            <PersonRow
              key={friend.id}
              avatarUrl={friend.avatarUrl}
              username={friend.username}
              action={
                <button
                  type="button"
                  onClick={() => onRemoveFriend(friend)}
                  className="shrink-0 rounded-full bg-neutral-800 px-4 py-2.5 text-xs text-neutral-300 transition-colors hover:text-white active:text-white"
                >
                  Remove
                </button>
              }
            />
          ))}

          {filtered.length === 0 && (
            <p className="break-words pt-8 text-center text-sm text-neutral-400">
              {friends.length === 0 ? "No friends yet." : `No one matches "${query}".`}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
