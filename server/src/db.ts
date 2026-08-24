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

/**
 * One row per (post, user) who liked it. The pair is the primary key so a
 * double-tap can't double-count, and `toggleLike` never needs a separate
 * existence check before deciding whether to insert or delete.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS likes (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (post_id, user_id)
  )
`);

/**
 * One row per comment. Unlike `likes` there is no natural key to collapse on —
 * the same person may say two different things — so this is an ordinary
 * autoincrement table.
 *
 * Nothing here counts. `about.md` excludes comment counts as deliberately as it
 * excludes like counts, so no query in the app may aggregate this table; the
 * only way its size is ever observable is by reading the comments themselves,
 * which is exactly the same rule `likers` follows.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

db.exec(
  "CREATE INDEX IF NOT EXISTS idx_posts_user_created ON posts (user_id, created_at DESC)",
);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_comments_post_created ON comments (post_id, created_at)",
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
 * Unique indexes that can fail on data that predates them.
 *
 * The case-insensitive pair matters because `UNIQUE` on the column itself is
 * case-sensitive, which would let `Ada@example.com` register alongside
 * `ada@example.com` and let one account impersonate another by casing alone.
 *
 * The normalised friendship pair covers what `(requester_id, addressee_id)`
 * cannot: that index sees A→B and B→A as different rows, so both can exist and
 * `listFriends` then returns the same person twice. Ordering the two ids by
 * MIN/MAX collapses a friendship to one key whichever way round it was made.
 *
 * `required` is what separates a degraded read from a wrong one. A duplicate
 * photo filename or a doubled friendship is visible and annoying; two users
 * differing only in the casing of their email means `findUserByEmail`'s
 * `COLLATE NOCASE` lookup returns an arbitrary one of them, and a sign-in
 * silently lands in the wrong account. That is not something to log and carry
 * on from, so those two take the boot down until the duplicates are resolved.
 */
for (const { name, sql, required } of [
  { name: "posts.photo_file", required: false, sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_photo_file ON posts (photo_file)" },
  { name: "users.email", required: true, sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase ON users (email COLLATE NOCASE)" },
  { name: "users.username", required: true, sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users (username COLLATE NOCASE)" },
  { name: "friend_requests.pair", required: false, sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_pair ON friend_requests (requester_id, addressee_id)" },
  { name: "friend_requests.normalised_pair", required: false, sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_pair_normalised ON friend_requests (MIN(requester_id, addressee_id), MAX(requester_id, addressee_id))" },
] as const) {
  try {
    db.exec(sql);
  } catch (err) {
    if (required) {
      throw new Error(
        `[db] Could not add the unique index on ${name} — the table already holds rows that collide there. ` +
          `Refusing to start: with duplicates present a lookup on that column returns an arbitrary one of them, ` +
          `which means signing in to the wrong account. Resolve the duplicates and restart.`,
        { cause: err },
      );
    }
    console.warn(
      `[db] Could not add the unique index on ${name} — the table already holds duplicate rows. Resolve them and restart; until then uniqueness is not enforced there.`,
    );
  }
}

/**
 * Distinguishes "that row already exists" from every other way a write can
 * fail. Anything else — a locked database, a full disk — has to keep its own
 * identity and reach the error handler, because reporting it as a duplicate
 * buries a real fault under a message the user can do nothing about.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  return String((err as { code?: string })?.code ?? "").startsWith("SQLITE_CONSTRAINT");
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

export type LikeRow = {
  post_id: number;
  user_id: number;
  created_at: number;
};

export type CommentRow = {
  id: number;
  post_id: number;
  user_id: number;
  body: string;
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
