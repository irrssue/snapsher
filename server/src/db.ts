import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Overridable so a test run can point at a throwaway file instead of the
// database the homeserver is actually serving from.
export const dbFile = process.env.DB_FILE || path.join(__dirname, "..", "data.db");

export const db = new Database(dbFile);

db.pragma("journal_mode = WAL");
// SQLite ignores REFERENCES clauses unless this is on, which quietly made every
// `ON DELETE CASCADE` below a no-op.
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    description TEXT,
    photo_file TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

/**
 * Sessions live here rather than inside the cookie so that signing out, an
 * expiry, or a deleted account actually ends the session server-side. The row
 * id is a SHA-256 of the token the browser holds, so a leaked database still
 * can't be replayed as a login.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT,
    ip TEXT
  )
`);

db.exec(
  "CREATE INDEX IF NOT EXISTS idx_posts_user_created ON posts (user_id, created_at DESC)",
);
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_photo_file ON posts (photo_file)");
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at)");

/**
 * `UNIQUE` on the columns themselves is case-sensitive, which would let
 * `Ada@example.com` register alongside `ada@example.com` and let one account
 * impersonate another by casing alone. Creating these fails on a database that
 * already contains such a pair, so a failure is reported and left for a human
 * rather than taking the server down at boot.
 */
for (const [name, sql] of [
  ["users.email", "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase ON users (email COLLATE NOCASE)"],
  ["users.username", "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users (username COLLATE NOCASE)"],
] as const) {
  try {
    db.exec(sql);
  } catch {
    console.warn(
      `[db] Could not add the case-insensitive unique index on ${name} — the table already holds rows that differ only by case. Resolve the duplicates and restart.`,
    );
  }
}

export type UserRow = {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  created_at: string;
};

export type PostRow = {
  id: number;
  user_id: number;
  description: string | null;
  photo_file: string;
  created_at: number;
};

export type SessionRow = {
  id: string;
  user_id: number;
  csrf_token: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  user_agent: string | null;
  ip: string | null;
};
