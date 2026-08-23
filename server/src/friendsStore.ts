import { db, type UserRow } from "./db.js";
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
  id: number;
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

  const existing = selectRelation.get(actor.userId, targetUserId, targetUserId, actor.userId);
  if (existing) {
    throw new FriendRequestError("A request already exists between you two.", 409);
  }

  try {
    insertRequest.run(actor.userId, targetUserId, Date.now());
  } catch {
    throw new FriendRequestError("That user doesn't exist.", 404);
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

export function removeFriend(actor: Actor, friendUserId: number): void {
  assertActor(actor);
  deleteRelationBetween.run(actor.userId, friendUserId, friendUserId, actor.userId);
}
