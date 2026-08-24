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

export type PublicFriendRequest = {
  /** The `friend_requests` row id — what accept/decline act on. */
  id: number;
  /**
   * The requester's `users` row id. Both tables autoincrement from 1, so these
   * two ids collide constantly; the client needs the real user id to build the
   * friend entry it shows after accepting, or "Remove" unfriends someone else.
   */
  userId: number;
  username: string;
  avatarUrl: string | null;
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

const selectIncomingRequests = db.prepare(`
  SELECT friend_requests.id, users.id AS user_id, users.username, users.avatar_file
    FROM friend_requests
    JOIN users ON users.id = friend_requests.requester_id
   WHERE friend_requests.addressee_id = ? AND friend_requests.status = 'pending'
   ORDER BY friend_requests.created_at DESC
`);

const selectRequestById = db.prepare("SELECT * FROM friend_requests WHERE id = ?");

const selectUserExists = db.prepare("SELECT 1 FROM users WHERE id = ?");

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

const searchUsersStmt = db.prepare(`
  SELECT id, username, avatar_file
    FROM users
   WHERE id != ?
     AND username LIKE ? ESCAPE '\\'
     AND id NOT IN (
       SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END
         FROM friend_requests
        WHERE requester_id = ? OR addressee_id = ?
     )
   ORDER BY username COLLATE NOCASE
   LIMIT ?
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

export function listIncomingRequests(actor: Actor): PublicFriendRequest[] {
  assertActor(actor);
  const rows = selectIncomingRequests.all(actor.userId) as (UserSummaryRow & {
    id: number;
    user_id: number;
  })[];
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    username: row.username,
    avatarUrl: avatarUrlFor(row.avatar_file),
  }));
}

/** Users neither friended nor mid-request with the actor, matching a query. */
export function searchUsers(actor: Actor, query: string): PublicFriend[] {
  assertActor(actor);
  const escaped = query.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const pattern = `%${escaped}%`;
  const rows = searchUsersStmt.all(
    actor.userId,
    pattern,
    actor.userId,
    actor.userId,
    actor.userId,
    SEARCH_LIMIT,
  ) as UserSummaryRow[];
  return rows.map(toPublicUser);
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
  if (!selectUserExists.get(targetUserId)) {
    throw new FriendRequestError("That user doesn't exist.", 404);
  }

  const existing = selectRelation.get(actor.userId, targetUserId, targetUserId, actor.userId);
  if (existing) {
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

/** Declines an incoming request, or cancels one the actor sent. */
export function declineFriendRequest(actor: Actor, requestId: number): void {
  assertActor(actor);
  const row = selectRequestById.get(requestId) as
    | { id: number; addressee_id: number; requester_id: number }
    | undefined;
  if (!row || (row.addressee_id !== actor.userId && row.requester_id !== actor.userId)) {
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
  removeFriendship(actor.userId, friendUserId);
}
