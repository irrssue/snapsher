import { useEffect, useId, useState } from "react";
import { CloseIcon, LockIcon } from "./icons";
import { Avatar, ErrorState, ModalShell, Skeleton } from "./ui";
import { fetchUserProfile, fetchUserPosts, type PublicProfile } from "../api/friends";
import { ApiError } from "../api/http";
import { PostGrid } from "./PostGrid";
import type { PostSummary } from "../types";

type PublicProfileModalProps = {
  userId: number;
  onClose: () => void;
};

/**
 * Any other user's profile, as seen by someone who isn't its owner: avatar,
 * username, post count, and their post grid. No friends count here on
 * purpose — per `about.md`, that number is only ever shown to the account
 * owner themself.
 *
 * The header is public; the photos are not. A stranger gets the avatar,
 * username and post count — enough to recognise who they found — and a locked
 * grid in place of the photos.
 */
export function PublicProfileModal({ userId, onClose }: PublicProfileModalProps) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The grid is friends-only and this viewer isn't one — a state, not a failure. */
  const [locked, setLocked] = useState(false);
  const headingId = useId();

  useEffect(() => {
    let active = true;
    setProfile(null);
    setPosts([]);
    setError(null);
    setLocked(false);
    fetchUserProfile(userId)
      .then((next) => {
        if (active) setProfile(next);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Couldn't load that profile.");
      });
    // Fetched independently of the profile above: a post-grid failure
    // shouldn't block the avatar/username/count from showing.
    fetchUserPosts(userId)
      .then((next) => {
        if (active) setPosts(next);
      })
      .catch((err) => {
        // Photos are friends-only, so a 403 here is the ordinary answer for
        // someone you haven't added — not an error, and emphatically not the
        // "No posts yet." an empty grid would otherwise claim about a profile
        // that may be full of them.
        if (active && err instanceof ApiError && err.code === "not_friends") {
          setLocked(true);
          return;
        }
        // Anything else: the grid just stays empty — not worth its own error
        // message beside a header that loaded fine.
      });
    return () => {
      active = false;
    };
  }, [userId]);

  return (
    <ModalShell labelledBy={headingId} onClose={onClose} className="flex flex-col">
      <>
        <div className="flex shrink-0 items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-3.5 p-3.5 text-neutral-400 transition-colors hover:text-white active:text-white"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col items-center gap-4 pb-4">
          {error ? (
            <ErrorState className="py-8" message={error} />
          ) : !profile ? (
            // The skeleton stands in for the avatar *and* the two text rows below
            // it. With only the circle the dialog was ~190px tall, and because the
            // backdrop centres it, the profile landing grew it in both directions
            // and slid the avatar upward out from under the pointer.
            <>
              <Skeleton className="h-24 w-24 shrink-0" />
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-5 w-20" />
            </>
          ) : (
            <>
              <Avatar url={profile.avatarUrl} size="xl" />

              <h2 id={headingId} className="break-words text-lg text-white">
                @{profile.username}
              </h2>

              <span className="text-sm text-neutral-300">{profile.postCount} posts</span>

              {locked ? (
                /*
                 * Not an error and not an empty grid. Photos are friends-only,
                 * so this is the ordinary view of someone you haven't added —
                 * and saying so is the difference between "there's nothing
                 * here" and "there's something here you can't see yet", on a
                 * profile whose post count directly above may read 40.
                 */
                <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-field">
                    <LockIcon className="h-5 w-5 text-neutral-400" />
                  </span>
                  <p className="break-words text-sm text-neutral-300">
                    Add @{profile.username} as a friend to see their photos.
                  </p>
                </div>
              ) : (
                <PostGrid
                  posts={posts}
                  username={profile.username}
                  avatarUrl={profile.avatarUrl}
                  emptyLabel={`@${profile.username} hasn't shared a photo yet.`}
                />
              )}
            </>
          )}
        </div>
      </>
    </ModalShell>
  );
}
