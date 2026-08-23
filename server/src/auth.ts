import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, type UserRow } from "./db.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function toPublicUser(user: UserRow) {
  return { id: user.id, username: user.username, email: user.email };
}

export const authRouter = Router();

authRouter.post("/check-email", (req, res) => {
  const { email } = req.body ?? {};

  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  res.json({ exists: Boolean(existing) });
});

authRouter.post("/signup", async (req, res) => {
  const { username, email, password } = req.body ?? {};

  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: "Username must be 3-20 characters and contain only letters, numbers, and underscores.",
    });
  }
  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const existing = db
    .prepare("SELECT id FROM users WHERE email = ? OR username = ?")
    .get(email, username);
  if (existing) {
    return res.status(409).json({ error: "Username or email is already taken." });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const result = db
    .prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)")
    .run(username, email, passwordHash);

  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(result.lastInsertRowid) as UserRow;

  req.session = { userId: user.id };
  res.status(201).json({ user: toPublicUser(user) });
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
    | UserRow
    | undefined;
  if (!user) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  req.session = { userId: user.id };
  res.json({ user: toPublicUser(user) });
});

authRouter.post("/logout", (req, res) => {
  req.session = null;
  res.status(204).end();
});

authRouter.get("/me", (req, res) => {
  const userId = req.session?.userId;
  if (!userId) {
    return res.status(401).json({ error: "Not signed in." });
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as
    | UserRow
    | undefined;
  if (!user) {
    req.session = null;
    return res.status(401).json({ error: "Not signed in." });
  }

  res.json({ user: toPublicUser(user) });
});
