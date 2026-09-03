import { useId, useState } from "react";
import { CloseIcon, SearchIcon } from "./icons";
import { PersonRow } from "./FriendsTab";
import { Button, FieldError, ModalShell } from "./ui";
import type { Friend } from "../api/friends";

type FriendsListPopupProps = {
  friends: Friend[];
  error: string | null;
  onClose: () => void;
  onRemoveFriend: (friend: Friend) => void;
  onViewProfile: (userId: number) => void;
};

export function FriendsListPopup({
  friends,
  error,
  onClose,
  onRemoveFriend,
  onViewProfile,
}: FriendsListPopupProps) {
  const [query, setQuery] = useState("");
  /** The friend whose removal is waiting on a confirmation — null means none. */
  const [confirming, setConfirming] = useState<Friend | null>(null);
  const headingId = useId();

  const filtered = friends.filter((f) =>
    f.username.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <ModalShell
      labelledBy={headingId}
      scroll={false}
      className="flex flex-col max-h-[min(30rem,100%)]"
      onClose={() => {
        // Escape and the backdrop back out of the confirmation before they
        // close the list — the innermost thing on screen goes first.
        if (confirming) setConfirming(null);
        else onClose();
      }}
    >
      <>
        <div className="flex shrink-0 items-center justify-between">
          <h2 id={headingId} className="text-base font-medium text-white">
            Friends
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-3.5 p-3.5 text-neutral-400 transition-colors hover:text-white active:text-white"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        {confirming ? (
          /*
           * A panel inside this dialog rather than a second dialog over it:
           * two stacked `bg-black/80` backdrops composite to ~96% black, which
           * reads as the page having gone out rather than being dimmed.
           */
          <div className="mt-4 flex flex-col gap-4">
            <div>
              <h3 className="text-base font-medium break-words text-white">
                Remove @{confirming.username}?
              </h3>
              <p className="mt-2 text-xs text-neutral-400">
                You'll both stop seeing each other's photos, and every like and comment
                the two of you left on each other's posts is deleted — theirs on yours
                and yours on theirs. That part can't be undone by adding them back.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <Button variant="secondary" className="flex-1" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                className="flex-1"
                onClick={() => {
                  const friend = confirming;
                  setConfirming(null);
                  onRemoveFriend(friend);
                }}
              >
                Remove
              </Button>
            </div>
          </div>
        ) : (
          <>
            <label className="relative mt-4 block shrink-0">
              <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
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
                className="min-h-11 w-full rounded-full bg-field pl-10 pr-4 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-white/60"
              />
            </label>

            {error && (
              <div className="mt-4 shrink-0">
                <FieldError message={error} />
              </div>
            )}

            <div className="mt-4 flex flex-col gap-1 overflow-y-auto overscroll-contain">
              {filtered.map((friend) => (
                <PersonRow
                  key={friend.id}
                  avatarUrl={friend.avatarUrl}
                  username={friend.username}
                  onClick={() => onViewProfile(friend.id)}
                  action={
                    <button
                      type="button"
                      // Asks first: removing also deletes both people's likes and
                      // comments on each other's posts, which is content on
                      // *someone else's* profile and is not recoverable by adding
                      // them back. Far too much to hang on one mis-aimed tap at a
                      // 44px row.
                      onClick={() => setConfirming(friend)}
                      className="min-h-11 shrink-0 rounded-full bg-field px-4 text-xs text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-white active:bg-neutral-700 active:text-white"
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
          </>
        )}
      </>
    </ModalShell>
  );
}
