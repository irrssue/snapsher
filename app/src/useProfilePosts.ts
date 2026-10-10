import { useCallback, useEffect, useRef, useState } from "react";
import { fetchUserPostPage } from "./api/friends";
import { ApiError } from "./api/http";
import type { PostSummary } from "./types";

/** Shared archive state for your profile and friends' profiles. */
export function useProfilePosts(userId: number) {
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryMore, setRetryMore] = useState(false);
  const [locked, setLocked] = useState(false);
  const generation = useRef(0);
  const busy = useRef(false);
  const loadedCount = useRef(0);

  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.code === "not_friends") {
      setPosts([]);
      loadedCount.current = 0;
      setNextCursor(null);
      setLocked(true);
      setError(null);
    } else {
      setError(err instanceof Error ? err.message : "Couldn't load these photos.");
    }
  }, []);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      // Keep an already opened archive intact when a comment refreshes counts.
      const target = Math.max(36, loadedCount.current);
      let cursor: string | undefined;
      let next: string | null = null;
      const collected: PostSummary[] = [];
      do {
        const page = await fetchUserPostPage(userId, cursor);
        if (current !== generation.current) return;
        collected.push(...page.posts);
        next = page.nextCursor;
        cursor = next ?? undefined;
      } while (next && collected.length < target);
      setPosts(collected);
      loadedCount.current = collected.length;
      setNextCursor(next);
      setLocked(false);
    } catch (err) {
      if (current === generation.current) {
        setRetryMore(false);
        fail(err);
      }
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [userId, fail]);

  useEffect(() => {
    loadedCount.current = 0;
    // Reset the archive when its owner changes before synchronizing with the API.
    // oxlint-disable-next-line react/set-state-in-effect
    setPosts([]);
    setNextCursor(null);
    setLocked(false);
    void refresh();
    // This is a request version, not a DOM ref: cleanup must invalidate the latest request.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    return () => { ++generation.current; };
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (busy.current || !nextCursor) return;
    busy.current = true;
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchUserPostPage(userId, nextCursor);
      if (current !== generation.current) return;
      setPosts((previous) => {
        const ids = new Set(previous.map((post) => post.id));
        const combined = [...previous, ...page.posts.filter((post) => !ids.has(post.id))];
        loadedCount.current = combined.length;
        return combined;
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (current === generation.current) {
        setRetryMore(true);
        fail(err);
      }
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [userId, nextCursor, fail]);

  const removePost = useCallback((id: string) => {
    // Invalidate reads started before deletion so they cannot restore the photo.
    ++generation.current;
    busy.current = false;
    setLoading(false);
    setPosts((previous) => previous.filter((post) => post.id !== id));
    loadedCount.current = Math.max(0, loadedCount.current - 1);
  }, []);

  return { posts, loading, error, locked, hasMore: nextCursor !== null, refresh, loadMore, retry: retryMore ? loadMore : refresh, removePost };
}
