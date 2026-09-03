import express, { Router } from "express";
import { config } from "./config.js";
import { rateLimit } from "./rateLimit.js";
import { requireAuth } from "./sessions.js";
import {
  acceptFriendRequest,
  declineFriendRequest,
  FriendRequestError,
  getPublicUser,
  listFriendRequests,
  listFriends,
  removeFriend,
  searchUsers,
  sendFriendRequest,
  type Actor,
} from "./friendsStore.js";
import { listPostsFor, PostAccessError, postCountFor } from "./postsStore.js";

function actorOf(req: express.Request): Actor {
  return { userId: req.auth!.user.id };
}

function parseId(raw: unknown): number | null {
  // A repeated Express 5 path parameter is represented as an array. This API
  // only accepts one numeric id, so reject it rather than coercing it.
  if (typeof raw !== "string") return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export const friendsRouter = Router();

friendsRouter.use(requireAuth);
friendsRouter.use(express.json({ limit: "16kb" }));

friendsRouter.get("/", (req, res) => {
  res.json({ friends: listFriends(actorOf(req)) });
});

/**
 * Both directions, not a bare array of incoming ones. A sent request had no
 * representation the client could read back, so "Requested" was component state
 * that a reload destroyed — and since search hid the target as well, the person
 * you had just added looked like they had left the app.
 */
friendsRouter.get("/requests", (req, res) => {
  res.json(listFriendRequests(actorOf(req)));
});

friendsRouter.post("/requests", rateLimit(config.rateLimits.friendRequest), (req, res) => {
  const targetUserId = parseId(String(req.body?.userId ?? ""));
  if (targetUserId === null) {
    return res.status(400).json({ error: "A user id is required." });
  }

  try {
    sendFriendRequest(actorOf(req), targetUserId);
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err instanceof FriendRequestError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
});

/**
 * Accept, decline/cancel and remove all carry the friend-request limiter.
 *
 * None of them is an access-control gap — every one checks that the caller is a
 * party to the row it names — but all three take an arbitrary id, and `remove`
 * in particular runs a five-statement transaction with two correlated
 * subqueries over `posts`. Thirty an hour is far past what managing your actual
 * friends takes, and well under what walking a range of ids costs the database.
 *
 * One instance shared by all three, deliberately unlike the two separate
 * `userSearch` limiters below: those guard genuinely different reads, whereas
 * giving each of these its own store would just hand a walker three independent
 * budgets to spend.
 */
const friendActionLimit = rateLimit(config.rateLimits.friendRequest);

function handleRequestRemoval(req: express.Request, res: express.Response) {
  const requestId = parseId(req.params.id);
  if (requestId === null) {
    return res.status(404).json({ error: "That request no longer exists." });
  }

  try {
    declineFriendRequest(actorOf(req), requestId);
    res.status(204).end();
  } catch (err) {
    if (err instanceof FriendRequestError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
}

friendsRouter.post("/requests/:id/accept", friendActionLimit, (req, res) => {
  const requestId = parseId(req.params.id);
  if (requestId === null) return res.status(404).json({ error: "Not found." });

  try {
    acceptFriendRequest(actorOf(req), requestId);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof FriendRequestError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
});

/**
 * One route for both halves of getting rid of a pending request: the addressee
 * declining it and the requester cancelling it are the same row going away, and
 * `declineFriendRequest` already accepted either party. Cancelling simply had
 * no route reaching it before.
 */
friendsRouter.delete("/requests/:id", friendActionLimit, handleRequestRemoval);

/**
 * The pre-DELETE spelling, kept working so a browser still holding an older
 * bundle doesn't lose the ability to decline. Same handler, same guards; the
 * only difference a caller sees is 204 instead of `{ ok: true }`.
 */
friendsRouter.post("/requests/:id/decline", friendActionLimit, handleRequestRemoval);

friendsRouter.delete("/:id", friendActionLimit, (req, res) => {
  const friendUserId = parseId(req.params.id);
  if (friendUserId === null) return res.status(404).json({ error: "Not found." });

  removeFriend(actorOf(req), friendUserId);
  res.json({ ok: true });
});

export const usersRouter = Router();

usersRouter.use(requireAuth);

/**
 * The search term is truncated rather than rejected: past a couple of dozen
 * characters no username can still match, so a longer one is either a paste or
 * an attempt to make the scan expensive, and neither is worth an error message.
 */
const MAX_SEARCH_LENGTH = 64;

usersRouter.get("/search", rateLimit(config.rateLimits.userSearch), (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.slice(0, MAX_SEARCH_LENGTH) : "";
  if (!q.trim()) return res.json({ users: [] });

  res.json({ users: searchUsers(actorOf(req), q) });
});

/**
 * Public profile: whoever is signed in may look up anyone by id. The
 * response deliberately omits friend count and friend status — per
 * `about.md`, only the account owner ever sees their own friend count.
 *
 * Ids are sequential, so with only the global 600/15min API budget in front of
 * it this route answers a `seq 1 5000` loop with the entire member roster —
 * username, avatar and post count for everyone — from one fresh account. It
 * gets the search limiter for that reason: 120 profile lookups per 15 minutes
 * is far more than opening profiles takes and far less than a directory walk.
 * A separate `rateLimit(...)` call means it counts in its own store rather than
 * eating the search budget.
 */
usersRouter.get("/:id", rateLimit(config.rateLimits.userSearch), (req, res) => {
  const targetId = parseId(req.params.id);
  if (targetId === null) return res.status(404).json({ error: "Not found." });

  const user = getPublicUser(targetId);
  if (!user) return res.status(404).json({ error: "Not found." });

  res.json({ user: { ...user, postCount: postCountFor(targetId) } });
});

/**
 * The Instagram-style grid on a profile screen — your own, or a friend's.
 *
 * Narrower than `/:id` above, which stays open to any member: about.md makes a
 * profile's avatar, username and post count public within the app and stops
 * there. The photos are the private part, and this route handed them out — 300
 * of anybody's, with captions and timestamps — to any signed-in account. See
 * the policy note in postsStore.ts.
 *
 * A stranger gets 403 `not_friends` rather than an empty list, so the client can
 * say why the grid is locked instead of rendering a profile that looks like it
 * has never posted next to a post count that says otherwise. A user id that
 * doesn't exist still 404s, and `/:id` already answers that same question to the
 * same audience, so the two responses disclose nothing between them.
 *
 * The rate limiter is its own call, and its own store, for the reason `/:id`
 * gives: this route is a strictly richer answer to the same enumeration walk,
 * and it was the one route in the pair with no limiter at all.
 */
usersRouter.get("/:id/posts", rateLimit(config.rateLimits.userSearch), (req, res) => {
  const targetId = parseId(req.params.id);
  if (targetId === null) return res.status(404).json({ error: "Not found." });

  const user = getPublicUser(targetId);
  if (!user) return res.status(404).json({ error: "Not found." });

  try {
    res.json({ posts: listPostsFor(actorOf(req), targetId) });
  } catch (err) {
    if (err instanceof PostAccessError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }
});
