import express, { Router } from "express";
import { requireAuth } from "./sessions.js";
import {
  acceptFriendRequest,
  declineFriendRequest,
  FriendRequestError,
  listFriends,
  listIncomingRequests,
  removeFriend,
  searchUsers,
  sendFriendRequest,
  type Actor,
} from "./friendsStore.js";

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

friendsRouter.post("/requests", (req, res) => {
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

usersRouter.get("/search", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  if (!q.trim()) return res.json({ users: [] });

  res.json({ users: searchUsers(actorOf(req), q) });
});
