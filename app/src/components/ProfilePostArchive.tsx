import { PostGrid } from "./PostGrid";
import { Button, ErrorState, Skeleton } from "./ui";
import type { useProfilePosts } from "../useProfilePosts";

type Props = Omit<Parameters<typeof PostGrid>[0], "posts"> & {
  archive: ReturnType<typeof useProfilePosts>;
};

export function ProfilePostArchive({ archive, ...gridProps }: Props) {
  const { posts, loading, error, hasMore, retry, loadMore } = archive;
  return (
    <div className="flex w-full flex-col items-center gap-4" aria-busy={loading}>
      {loading && posts.length === 0 ? (
        <div className="grid w-full grid-cols-3 gap-0.5" role="status" aria-label="Loading photos">
          {Array.from({ length: 9 }, (_, index) => <Skeleton key={index} className="aspect-square w-full" />)}
        </div>
      ) : posts.length > 0 || !error ? (
        <PostGrid posts={posts} {...gridProps} />
      ) : null}
      {error && <ErrorState message={error} onRetry={retry} />}
      {hasMore && !error && (
        <Button variant="ghost" disabled={loading} onClick={loadMore}>
          {loading ? "Loading photos…" : "Load older photos"}
        </Button>
      )}
    </div>
  );
}
