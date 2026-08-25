import express, { Router } from "express";
import { config } from "./config.js";
import { rateLimit } from "./rateLimit.js";
import { requireAuth } from "./sessions.js";
import {
  acceptFriendRequest,
  declineFriendRequest,
  FriendRequestError,
  getPublicUser,
  listFriends,
  listIncomingRequests,
  removeFriend,
  searchUsers,
  sendFriendRequest,
  type Actor,
} from "./friendsStore.js";
import { postCountFor } from "./postsStore.js";

function actorOf(req: express.Request): Actor {
  return { userId: req.auth!.user.id };
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export const friendsRouter = Router();

friendsRouter.use(requireAuth);
friendsRouter.use(express.json({ limit: "16kb" }));

friendsRouter.get("/", (req, res) => {
  res.json({ friends: listFriends(actorOf(req)) });
});

friendsRouter.get("/requests", (req, res) => {
  res.json({ requests: listIncomingRequests(actorOf(req)) });
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

friendsRouter.post("/requests/:id/accept", (req, res) => {
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

friendsRouter.post("/requests/:id/decline", (req, res) => {
  const requestId = parseId(req.params.id);
  if (requestId === null) return res.status(404).json({ error: "Not found." });

  try {
    declineFriendRequest(actorOf(req), requestId);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof FriendRequestError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
});

friendsRouter.delete("/:id", (req, res) => {
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
 */
usersRouter.get("/:id", (req, res) => {
  const targetId = parseId(req.params.id);
  if (targetId === null) return res.status(404).json({ error: "Not found." });

  const user = getPublicUser(targetId);
  if (!user) return res.status(404).json({ error: "Not found." });

  res.json({ user: { ...user, postCount: postCountFor(targetId) } });
});
