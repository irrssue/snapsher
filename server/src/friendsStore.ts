import { db, isUniqueConstraintError, type UserRow } from "./db.js";
import { avatarUrlFor } from "./avatarsStore.js";

/**
 * Row-level access control for friendships, on the same principle as
 * postsStore: every exported function takes the acting user, so a route
 * can't accidentally act on behalf of someone it didn't authenticate.
 */
export type Actor = { userId: number };

export type PublicFriend = {
  id: number;
  username: string;
  avatarUrl: string | null;
};

/**
 * Where the viewer stands with one search result, in one field.
 *
 * Search used to hide anyone with a pending request in either direction, which
 * made a sent request unrecoverable: "Requested" lived in component state that
 * died on reload, and afterwards the person you had just added truthfully
 * returned no results — indistinguishable from them not being on Snapsher at
 * all. They stay in the results now, and this says which of Add / Accept /
 * Requested / Friends the row should render.
 */
export type FriendRequestState = "none" | "incoming" | "outgoing" | "friends";

export type PublicSearchUser = PublicFriend & {
  /** Retained alongside `requestState` so both spellings of the same fact agree. */
  isFriend: boolean;
  requestState: FriendRequestState;
};

export type PublicFriendRequest = {
  /** The `friend_requests` row id — what accept, decline and cancel act on. */
  id: number;
  /**
   * The *other* party's `users` row id: the requester on an incoming request,
   * the addressee on an outgoing one. Both tables autoincrement from 1, so
   * these two ids collide constantly; the client needs the real user id to
   * build the friend entry it shows after accepting, or "Remove" unfriends
   * someone else.
   */
  userId: number;
  username: string;
  avatarUrl: string | null;
};

/** Both directions in one response, so a sent request is visible and cancellable. */
export type FriendRequests = {
  incoming: PublicFriendRequest[];
  outgoing: PublicFriendRequest[];
};

const SEARCH_LIMIT = 20;

type UserSummaryRow = Pick<UserRow, "id" | "username" | "avatar_file">;

function toPublicUser(row: UserSummaryRow): PublicFriend {
  return { id: row.id, username: row.username, avatarUrl: avatarUrlFor(row.avatar_file) };
}

function assertActor(actor: Actor) {
  if (!Number.isInteger(actor?.userId) || actor.userId <= 0) {
    throw new Error("friendsStore called without a valid actor.");
  }
}

const selectFriends = db.prepare(`
  SELECT users.id, users.username, users.avatar_file
    FROM friend_requests
    JOIN users
      ON users.id = CASE
           WHEN friend_requests.requester_id = ? THEN friend_requests.addressee_id
           ELSE friend_requests.requester_id
         END
   WHERE friend_requests.status = 'accepted'
     AND (friend_requests.requester_id = ? OR friend_requests.addressee_id = ?)
   ORDER BY users.username COLLATE NOCASE
`);

// `id DESC` behind `created_at DESC` because two requests can share a
// millisecond, and SQLite is under no obligation to break that tie the same way
// twice — cosmetic while these lists are whole, and wrong the moment anything
// pages through them with a cursor.
const selectIncomingRequests = db.prepare(`
  SELECT friend_requests.id, users.id AS user_id, users.username, users.avatar_file
    FROM friend_requests
    JOIN users ON users.id = friend_requests.requester_id
   WHERE friend_requests.addressee_id = ? AND friend_requests.status = 'pending'
   ORDER BY friend_requests.created_at DESC, friend_requests.id DESC
`);

const selectOutgoingRequests = db.prepare(`
  SELECT friend_requests.id, users.id AS user_id, users.username, users.avatar_file
    FROM friend_requests
    JOIN users ON users.id = friend_requests.addressee_id
   WHERE friend_requests.requester_id = ? AND friend_requests.status = 'pending'
   ORDER BY friend_requests.created_at DESC, friend_requests.id DESC
`);

const selectRequestById = db.prepare("SELECT * FROM friend_requests WHERE id = ?");

const selectUserExists = db.prepare("SELECT 1 FROM users WHERE id = ?");

const selectUserSummary = db.prepare("SELECT id, username, avatar_file FROM users WHERE id = ?");

const selectFriendship = db.prepare(`
  SELECT 1 FROM friend_requests
   WHERE status = 'accepted'
     AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))
`);

const selectRelation = db.prepare(`
  SELECT * FROM friend_requests
   WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
`);

const insertRequest = db.prepare(
  "INSERT INTO friend_requests (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'pending', ?)",
);
const acceptRequestStmt = db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?");
const deleteRequestStmt = db.prepare("DELETE FROM friend_requests WHERE id = ?");
const deleteRelationBetween = db.prepare(`
  DELETE FROM friend_requests
   WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
`);
/** Every like the first user left on the second user's posts. */
const deleteLikesByOn = db.prepare(`
  DELETE FROM likes
   WHERE user_id = ?
     AND post_id IN (SELECT id FROM posts WHERE user_id = ?)
`);
/**
 * The same, for comments. Kept here beside the likes statement rather than
 * imported from commentsStore, which would close an import cycle: that module
 * already depends on `areFriends` from this one.
 */
const deleteCommentsByOn = db.prepare(`
  DELETE FROM comments
   WHERE user_id = ?
     AND post_id IN (SELECT id FROM posts WHERE user_id = ?)
`);

/**
 * Every match, with the relationship attached rather than filtered on.
 *
 * The old statement excluded anyone with a pending request in either direction,
 * on the reasoning that there was nothing useful to show for them. There was:
 * with no way to cancel a request and no outgoing list, the person you had just
 * added disappeared from search entirely and stayed gone, which reads as "they
 * aren't on Snapsher" rather than "you already asked". The unique index on the
 * normalised pair still makes a duplicate send impossible, so nothing here is
 * relying on the exclusion for correctness.
 *
 * One correlated subquery instead of two: `status` and `requester_id` come from
 * the same row, and asking twice would let them describe different rows if one
 * changed between them. The `LIMIT 1` is belt and braces — the normalised
 * unique index already means at most one row per pair.
 */
const searchUsersStmt = db.prepare(`
  SELECT users.id, users.username, users.avatar_file,
         relation.status AS rel_status,
         relation.requester_id AS rel_requester_id
    FROM users
    LEFT JOIN friend_requests AS relation
      ON relation.id = (
           SELECT id FROM friend_requests
            WHERE (requester_id = @me AND addressee_id = users.id)
               OR (requester_id = users.id AND addressee_id = @me)
            LIMIT 1
         )
   WHERE users.id != @me
     AND users.username LIKE @pattern ESCAPE '\\'
   ORDER BY users.username COLLATE NOCASE
   LIMIT @limit
`);

export function listFriends(actor: Actor): PublicFriend[] {
  assertActor(actor);
  return (selectFriends.all(actor.userId, actor.userId, actor.userId) as UserSummaryRow[]).map(
    toPublicUser,
  );
}

/**
 * Whether these two are friends, asked directly. `friendIdsFor` answers the
 * same question by materialising and sorting the actor's whole friend list,
 * which is the right shape for building a feed and the wrong one for a check
 * repeated once per photo in that feed.
 */
export function areFriends(actor: Actor, otherUserId: number): boolean {
  assertActor(actor);
  return !!selectFriendship.get(actor.userId, otherUserId, otherUserId, actor.userId);
}

/** Every user id the actor is friends with — used to scope the feed. */
export function friendIdsFor(actor: Actor): number[] {
  assertActor(actor);
  return (selectFriends.all(actor.userId, actor.userId, actor.userId) as UserSummaryRow[]).map(
    (row) => row.id,
  );
}

type RequestJoinRow = UserSummaryRow & { id: number; user_id: number };

function toPublicRequest(row: RequestJoinRow): PublicFriendRequest {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    avatarUrl: avatarUrlFor(row.avatar_file),
  };
}

/**
 * Both directions at once. Outgoing requests were previously invisible to the
 * only person who could act on them, which is what made "Requested" a
 * client-side fiction that a reload erased.
 */
export function listFriendRequests(actor: Actor): FriendRequests {
  assertActor(actor);
  return {
    incoming: (selectIncomingRequests.all(actor.userId) as RequestJoinRow[]).map(toPublicRequest),
    outgoing: (selectOutgoingRequests.all(actor.userId) as RequestJoinRow[]).map(toPublicRequest),
  };
}

/**
 * Users matching a query, each carrying where the actor stands with them.
 * Nobody is filtered out: friends, people who have asked, and people who have
 * been asked all stay findable, and `requestState` is what the client renders
 * the right button from.
 */
export function searchUsers(actor: Actor, query: string): PublicSearchUser[] {
  assertActor(actor);
  const escaped = query.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const rows = searchUsersStmt.all({
    me: actor.userId,
    pattern: `%${escaped}%`,
    limit: SEARCH_LIMIT,
  }) as (UserSummaryRow & { rel_status: string | null; rel_requester_id: number | null })[];

  return rows.map((row) => {
    let requestState: FriendRequestState = "none";
    if (row.rel_status === "accepted") {
      requestState = "friends";
    } else if (row.rel_status === "pending") {
      requestState = row.rel_requester_id === actor.userId ? "outgoing" : "incoming";
    }
    return {
      ...toPublicUser(row),
      isFriend: requestState === "friends",
      requestState,
    };
  });
}

/**
 * Looked up by id rather than scoped to an actor: this backs the public
 * profile view, where anyone signed in may look up anyone else. Friend
 * status and friend count are deliberately not part of this shape — a
 * viewer who isn't the account owner never sees them, per `about.md`.
 */
export function getPublicUser(userId: number): PublicFriend | null {
  const row = selectUserSummary.get(userId) as UserSummaryRow | undefined;
  return row ? toPublicUser(row) : null;
}

export class FriendRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function sendFriendRequest(actor: Actor, targetUserId: number): void {
  assertActor(actor);
  if (targetUserId === actor.userId) {
    throw new FriendRequestError("You can't friend yourself.", 400);
  }

  // Checked explicitly rather than inferred from a failed insert: the foreign
  // key is only one of several reasons the write can fail, and treating every
  // one of them as "no such user" would report a locked or full database as a
  // typo the user is supposed to fix.
  //
  // The *answer*, though, is the same 409 as an existing relation. A distinct
  // 404 turned this route into an existence oracle over sequential user ids —
  // 201/409 means "that account is real", 404 means it isn't — walkable at 30
  // an hour from any fresh account. Nobody reaches this route by typing an id;
  // every caller picked a row out of search results, so the only person who can
  // tell the two cases apart is the one probing.
  const existing = selectRelation.get(actor.userId, targetUserId, targetUserId, actor.userId);
  if (existing || !selectUserExists.get(targetUserId)) {
    throw new FriendRequestError("A request already exists between you two.", 409);
  }

  try {
    insertRequest.run(actor.userId, targetUserId, Date.now());
  } catch (err) {
    // The check above races another request from the same pair; the unique
    // index is what actually settles it, and losing that race is still a 409.
    // Anything else is ours, and rethrowing is what gets it logged.
    if (!isUniqueConstraintError(err)) throw err;
    throw new FriendRequestError("A request already exists between you two.", 409);
  }
}

/** Accepts an incoming request — only the addressee may accept it. */
export function acceptFriendRequest(actor: Actor, requestId: number): void {
  assertActor(actor);
  const row = selectRequestById.get(requestId) as
    | { id: number; addressee_id: number; status: string }
    | undefined;
  if (!row || row.addressee_id !== actor.userId || row.status !== "pending") {
    throw new FriendRequestError("That request no longer exists.", 404);
  }
  acceptRequestStmt.run(requestId);
}

/**
 * Declines an incoming request, or cancels one the actor sent. Either party may
 * call it; only while the row is still `pending`.
 *
 * That status guard is not defensive tidiness — without it this function
 * silently un-friended people. Friendship *is* the accepted state of this same
 * row (see db.ts), so declining an already-accepted request deleted the
 * friendship, from a route that returns 200 and says nothing. Two tabs on the
 * Requests screen was enough to reach it: the stale one still lists a request
 * the other one accepted. Worse than the un-friending itself, it bypassed
 * `removeFriendship` below, so every like and comment the two had left on each
 * other's posts survived — outliving the access that justified them, with
 * neither party able to retract them, because every route that could now 404s
 * for a post they can no longer see. Exactly the state that transaction exists
 * to prevent.
 */
export function declineFriendRequest(actor: Actor, requestId: number): void {
  assertActor(actor);
  const row = selectRequestById.get(requestId) as
    | { id: number; addressee_id: number; requester_id: number; status: string }
    | undefined;
  if (
    !row ||
    row.status !== "pending" ||
    (row.addressee_id !== actor.userId && row.requester_id !== actor.userId)
  ) {
    throw new FriendRequestError("That request no longer exists.", 404);
  }
  deleteRequestStmt.run(requestId);
}

/**
 * Un-friending has to take the likes and comments with it, in one transaction
 * so they can never disagree. Neither is placeable by anyone who can't see the
 * post, and ending the friendship ends that — but the rows would otherwise
 * outlive the access that justified them: the ex-friend stays in the author's
 * likers popup and keeps padding the count forever, their comments stay on the
 * post, and they can retract neither, because both routes now answer 404 for a
 * post they can no longer see.
 *
 * Both directions go, since either side may have liked or commented on the
 * other's posts and either side may be the one pressing Remove.
 */
const removeFriendship = db.transaction((actorId: number, friendUserId: number) => {
  deleteRelationBetween.run(actorId, friendUserId, friendUserId, actorId);
  deleteLikesByOn.run(actorId, friendUserId);
  deleteLikesByOn.run(friendUserId, actorId);
  deleteCommentsByOn.run(actorId, friendUserId);
  deleteCommentsByOn.run(friendUserId, actorId);
});

export function removeFriend(actor: Actor, friendUserId: number): void {
  assertActor(actor);
  // Nobody is their own friend, so this was always a no-op — but it stopped
  // being a harmless one once likes and comments were part of the transaction:
  // both directions would collapse onto the same user and wipe the actor's own
  // likes and comments on their own posts. The route will take any id, so it is
  // refused here.
  if (friendUserId === actor.userId) return;

  // The route accepts any id, and the transaction below is five statements with
  // two correlated subqueries over `posts` — a real cost to run against a pair
  // that has no relation at all. One indexed read settles it first, so a walk
  // through `DELETE /api/friends/1..N` from a fresh account buys nothing but
  // that read. Nothing is disclosed by the early return: the route answers the
  // same way either way.
  if (!selectRelation.get(actor.userId, friendUserId, friendUserId, actor.userId)) return;

  removeFriendship(actor.userId, friendUserId);
}
