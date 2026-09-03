import type { Post } from "../types";
import { PostInteractions } from "./PostInteractions";

export function PostCard({
  post,
  onCountsChanged,
}: {
  post: Post;
  /** Bubbles a comment add/delete up so the profile grid can refetch too. */
  onCountsChanged?: () => void;
}) {
  return (
    <div className="flex w-full flex-col gap-3 md:flex-row md:items-center md:justify-center md:gap-10">
      {/*
       * `contents` on phones lets the photo sit *between* the description and
       * the action row, so a post reads top-to-bottom as author → description →
       * photo → like/comment. From md up this collapses back into the text
       * column that sits beside the photo. That ordering lives inside
       * `PostInteractions` itself.
       */}
      <PostInteractions
        postId={post.id}
        username={post.username}
        avatarUrl={post.avatarUrl}
        description={post.description}
        createdAt={post.createdAt}
        likedByMe={post.likedByMe}
        isOwner={post.isOwner}
        likeCount={post.likeCount}
        commentCount={post.commentCount}
        onCountsChanged={onCountsChanged}
      />

      <div className="aspect-square w-full overflow-hidden rounded-shell bg-field md:aspect-auto md:h-(--size-photo) md:w-(--size-photo) md:shrink-0">
        <img
          src={post.photoUrl}
          alt={post.description ?? `Photo shared by @${post.username}`}
          // Photos are now fetched through an authenticated route, so a feed of
          // 100 is 100 requests; only ask for the ones actually on screen.
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      </div>
    </div>
  );
}
