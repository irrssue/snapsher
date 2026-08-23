import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Overridable so a test run can point at a throwaway file instead of the
// database the homeserver is actually serving from.
export const db = new Database(process.env.DB_FILE || path.join(__dirname, "..", "data.db"));

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
    avatar_file TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// SQLite has no `ADD COLUMN IF NOT EXISTS`, so a table created before avatars
// existed needs this checked and applied by hand.
const userColumns = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
if (!userColumns.some((column) => column.name === "avatar_file")) {
  db.exec("ALTER TABLE users ADD COLUMN avatar_file TEXT");
}

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

/**
 * One row per request, requester -> addressee. Friendship is the "accepted"
 * state of that same row rather than a separate table, so there is exactly
 * one place that can disagree with itself about whether two users are
 * friends. Reads that want "are A and B friends" check both directions.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  )
`);

db.exec(
  "CREATE INDEX IF NOT EXISTS idx_posts_user_created ON posts (user_id, created_at DESC)",
);
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at)");
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_friend_requests_addressee ON friend_requests (addressee_id, status)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_friend_requests_requester ON friend_requests (requester_id, status)",
);

/**
 * Unique indexes that can fail on data that predates them, so each is reported
 * and skipped rather than taking the server down at boot.
 *
 * The case-insensitive pair matters because `UNIQUE` on the column itself is
 * case-sensitive, which would let `Ada@example.com` register alongside
 * `ada@example.com` and let one account impersonate another by casing alone.
 */
for (const [name, sql] of [
  ["posts.photo_file", "CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_photo_file ON posts (photo_file)"],
  ["users.email", "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase ON users (email COLLATE NOCASE)"],
  ["users.username", "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users (username COLLATE NOCASE)"],
  ["friend_requests.pair", "CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_pair ON friend_requests (requester_id, addressee_id)"],
] as const) {
  try {
    db.exec(sql);
  } catch {
    console.warn(
      `[db] Could not add the unique index on ${name} — the table already holds duplicate rows. Resolve them and restart; until then uniqueness is not enforced there.`,
    );
  }
}

export type UserRow = {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  avatar_file: string | null;
  created_at: string;
};

export type PostRow = {
  id: number;
  user_id: number;
  description: string | null;
  photo_file: string;
  created_at: number;
};

export type FriendRequestRow = {
  id: number;
  requester_id: number;
  addressee_id: number;
  status: "pending" | "accepted";
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
